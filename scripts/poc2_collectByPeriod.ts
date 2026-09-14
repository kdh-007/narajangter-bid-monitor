/**
 * PoC2 공고 수집
 *
 * 기본 기간: 2026-08-01 ~ 2026-08-31
 * 대상: 물품·용역·공사
 * 필터: 기존 config/keywords.json
 * 추가 조회: 참가가능지역·면허제한
 * 저장: poc2_notices.raw._poc2_enrichment
 *
 * 기존 package.json과 GitHub Actions YAML을 그대로 사용한다.
 * 기간 외 기존 데이터는 삭제하지 않는다.
 * 첫 오류에서 중단하며, 일시적 API 연결 오류만 1회 재시도한다.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

type RawItem = Record<string, any>;

const BASE_URL =
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";

const OPERATIONS = [
  {
    label: "물품",
    operation: "getBidPblancListInfoThngPPSSrch",
  },
  {
    label: "용역",
    operation: "getBidPblancListInfoServcPPSSrch",
  },
  {
    label: "공사",
    operation: "getBidPblancListInfoCnstwkPPSSrch",
  },
];

const REGION_OPERATION =
  "getBidPblancListInfoPrtcptPsblRgn";

const LICENSE_OPERATION =
  "getBidPblancListInfoLicenseLimit";

const API_TIMEOUT_MS = 30000;
const API_MAX_ATTEMPTS = 2;
const PAGE_SIZE = 100;

const text = (value: unknown): string =>
  value == null ? "" : String(value).trim();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`環境変数 ${name}가 없습니다.`);
  }

  return value;
}

// 로그에 인증키가 노출되지 않도록 마스킹한다.
function safeMessage(value: unknown): string {
  let message = text(value);

  for (const name of [
    "DATA_GO_KR_SERVICE_KEY",
    "SUPABASE_KEY",
  ]) {
    const secret = process.env[name]?.trim();
    if (!secret) continue;

    const variants = [secret, encodeURIComponent(secret)];

    try {
      variants.push(decodeURIComponent(secret));
    } catch {
      // 디코딩할 수 없는 값은 원래 값으로 마스킹한다.
    }

    for (const variant of variants) {
      if (variant) {
        message = message.split(variant).join("[REDACTED]");
      }
    }
  }

  return message
    .replace(
      /serviceKey=[^&\s]+/gi,
      "serviceKey=[REDACTED]"
    )
    .replace(
      /sb_secret_[A-Za-z0-9_-]+/g,
      "[REDACTED]"
    )
    .slice(0, 1500);
}

function normalizeOrd(value: unknown): string {
  const ord = text(value);

  if (!/^\d{1,3}$/.test(ord)) {
    throw new Error("공고차수 누락 또는 형식 오류");
  }

  return ord.padStart(3, "0");
}

function parseAmount(value: unknown): number | null {
  const valueText = text(value).replace(/,/g, "");

  if (!valueText) return null;

  const amount = Number(valueText);
  return Number.isFinite(amount) ? amount : null;
}

function monthlyChunks(
  start: string,
  end: string
): { from: string; to: string }[] {
  const parseDate = (value: string): Date => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error("기간은 YYYY-MM-DD 형식이어야 합니다.");
    }

    const date = new Date(`${value}T00:00:00Z`);

    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new Error(`유효하지 않은 날짜: ${value}`);
    }

    return date;
  };

  let cursor = parseDate(start);
  const last = parseDate(end);

  if (cursor > last) {
    throw new Error("시작일이 종료일보다 늦습니다.");
  }

  const chunks: { from: string; to: string }[] = [];

  while (cursor <= last) {
    const nextMonth = new Date(
      Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        1
      )
    );

    const monthEnd = new Date(
      nextMonth.getTime() - 86400000
    );

    chunks.push({
      from: cursor.toISOString().slice(0, 10),
      to: (monthEnd < last ? monthEnd : last)
        .toISOString()
        .slice(0, 10),
    });

    cursor = nextMonth;
  }

  return chunks;
}

function normalizeItems(value: any): RawItem[] {
  if (value == null || value === "") return [];

  let items: any;

  if (Array.isArray(value)) {
    items = value;
  } else if (
    typeof value === "object" &&
    "item" in value
  ) {
    items = value.item;
  } else if (
    typeof value === "object" &&
    Object.keys(value).length === 0
  ) {
    return [];
  } else {
    throw new Error("알 수 없는 items 응답 구조");
  }

  if (items == null || items === "") return [];

  const list = Array.isArray(items) ? items : [items];

  if (
    !list.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item)
    )
  ) {
    throw new Error("items에 잘못된 항목이 있습니다.");
  }

  return list;
}

function buildUrl(
  operation: string,
  params: Record<string, string>,
  key: string
): string {
  let decodedKey = key.trim();

  if (/%[0-9a-f]{2}/i.test(decodedKey)) {
    decodedKey = decodeURIComponent(decodedKey);
  }

  const query = new URLSearchParams({
    ...params,
    type: "json",
    serviceKey: decodedKey,
  });

  return `${BASE_URL}/${operation}?${query}`;
}

class ApiError extends Error {
  retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.retryable = retryable;
  }
}

// ---------- API 한 페이지 조회 ----------

async function fetchPage(
  operation: string,
  params: Record<string, string>,
  key: string
): Promise<{ items: RawItem[]; totalCount: number }> {
  for (
    let attempt = 1;
    attempt <= API_MAX_ATTEMPTS;
    attempt++
  ) {
    await sleep(300);

    const startedAt = Date.now();
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      API_TIMEOUT_MS
    );

    try {
      console.log(
        `[API 요청] ${operation} / ` +
        `페이지 ${params.pageNo ?? "1"} / ` +
        `${attempt}/${API_MAX_ATTEMPTS}회`
      );

      const response = await fetch(
        buildUrl(operation, params, key),
        { signal: controller.signal }
      );

      if (!response.ok) {
        throw new ApiError(
          `HTTP ${response.status} ${response.statusText}`,
          response.status === 429 ||
            response.status >= 500
        );
      }

      // 본문을 전부 받는 시간까지 타임아웃에 포함한다.
      const bodyText = await response.text();
      let data: any;

      try {
        data = JSON.parse(bodyText);
      } catch {
        const match = bodyText.match(
          /<(?:returnAuthMsg|returnReasonCode|errMsg)>([^<]*)</
        );

        throw new ApiError(
          "JSON이 아닌 응답: " +
            (match
              ? safeMessage(match[1])
              : `Content-Type=${
                  response.headers.get("content-type") ??
                  "없음"
                }`)
        );
      }

      const apiResponse = data?.response;
      const code = text(
        apiResponse?.header?.resultCode
      );

      if (code !== "00") {
        throw new ApiError(
          `API 코드=${safeMessage(code) || "없음"}, ` +
            `메시지=${
              safeMessage(
                apiResponse?.header?.resultMsg
              ) || "없음"
            }`,
          ["01", "02", "04", "05"].includes(code)
        );
      }

      const body = apiResponse?.body;

      if (
        body?.totalCount == null ||
        text(body.totalCount) === ""
      ) {
        throw new ApiError("totalCount 누락");
      }

      const totalCount = Number(body.totalCount);

      if (
        !Number.isSafeInteger(totalCount) ||
        totalCount < 0
      ) {
        throw new ApiError("totalCount 형식 오류");
      }

      const items = normalizeItems(body.items);
      const elapsed = (
        (Date.now() - startedAt) /
        1000
      ).toFixed(1);

      console.log(
        `[API 성공] ${operation} / ` +
        `${elapsed}초 / ${items.length}건`
      );

      return { items, totalCount };
    } catch (err) {
      const error = err as Error & {
        code?: string;
        cause?: {
          code?: string;
          message?: string;
        };
      };

      const timedOut = controller.signal.aborted;

      console.error(
        "[API 오류 상세]",
        JSON.stringify(
          {
            operation,
            pageNo: params.pageNo ?? "1",
            attempt,
            elapsedSeconds: (
              (Date.now() - startedAt) /
              1000
            ).toFixed(1),
            timedOut,
            name: safeMessage(error?.name),
            code: safeMessage(error?.code),
            message: timedOut
              ? "30초 안에 응답 수신을 완료하지 못했습니다."
              : safeMessage(error?.message),
            causeCode: safeMessage(
              error?.cause?.code
            ),
            causeMessage: safeMessage(
              error?.cause?.message
            ),
          },
          null,
          2
        )
      );

      const retryable =
        err instanceof ApiError
          ? err.retryable
          : timedOut ||
            error?.name === "TypeError" ||
            Boolean(error?.cause?.code);

      if (
        !retryable ||
        attempt === API_MAX_ATTEMPTS
      ) {
        throw new ApiError(
          `${operation}: ${
            timedOut
              ? "30초 응답 시간초과"
              : safeMessage(error?.message) ||
                "원인 미확인"
          }`
        );
      }

      console.warn(
        "[재시도 예정] 1초 후 한 번 더 요청합니다."
      );
    } finally {
      clearTimeout(timer);
    }

    await sleep(1000);
  }

  throw new ApiError(`${operation}: 요청 종료`);
}

// ---------- 목록을 페이지별로 전달 ----------

async function* fetchPages(
  operation: string,
  params: Record<string, string>,
  key: string
): AsyncGenerator<RawItem[]> {
  let received = 0;
  let previousPage = "";

  for (let pageNo = 1; pageNo <= 10000; pageNo++) {
    const page = await fetchPage(
      operation,
      {
        ...params,
        pageNo: String(pageNo),
        numOfRows: String(PAGE_SIZE),
      },
      key
    );

    if (!page.items.length) {
      if (received < page.totalCount) {
        throw new Error(
          `${operation}: 전체 건수보다 적게 받은 상태에서 빈 페이지 수신`
        );
      }

      return;
    }

    const fingerprint = JSON.stringify(page.items);

    if (fingerprint === previousPage) {
      throw new Error(
        `${operation}: 동일 페이지 반복 수신`
      );
    }

    previousPage = fingerprint;
    received += page.items.length;

    console.log(
      `[수신 진행] ${operation}: ` +
      `${received}/${page.totalCount}건`
    );

    yield page.items;

    if (received >= page.totalCount) return;
  }

  throw new Error(
    `${operation}: 페이지 안전 한도 초과`
  );
}

// ---------- 지역·면허 전체 페이지 조회 ----------
// 이번 오류의 원인이었던 fetchAll 함수를 포함한다.

async function fetchAll(
  operation: string,
  params: Record<string, string>,
  key: string
): Promise<RawItem[]> {
  const results: RawItem[] = [];

  for await (
    const items of fetchPages(operation, params, key)
  ) {
    results.push(...items);
  }

  return results;
}

function validateDetails(
  items: RawItem[],
  no: string,
  ord: string,
  label: string
): RawItem[] {
  for (const item of items) {
    if (
      text(item.bidNtceNo) !== no ||
      normalizeOrd(item.bidNtceOrd) !== ord
    ) {
      throw new Error(
        "추가 조회 결과의 공고번호·차수가 요청과 다릅니다."
      );
    }

    if (
      text(item.bsnsDivNm) &&
      text(item.bsnsDivNm) !== label
    ) {
      throw new Error(
        "추가 조회 결과의 업무구분이 요청과 다릅니다."
      );
    }
  }

  return items;
}

function dbFailure(stage: string, error: any): never {
  console.error(
    `[${stage}]`,
    JSON.stringify(
      {
        code: safeMessage(error?.code),
        message: safeMessage(error?.message),
        details: safeMessage(error?.details),
        hint: safeMessage(error?.hint),
      },
      null,
      2
    )
  );

  throw new Error(
    `${stage}: ${safeMessage(error?.code)} ` +
    safeMessage(error?.message)
  );
}

// ---------- 실행 ----------

async function main() {
  const serviceKey = required(
    "DATA_GO_KR_SERVICE_KEY"
  );

  const supabase = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_KEY"),
    {
      global: {
        fetch: async (input, init) => {
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            10000
          );

          try {
            const response = await fetch(input, {
              ...init,
              signal: controller.signal,
            });

            const body = await response.arrayBuffer();

            return new Response(
              body.byteLength ? body : null,
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }
            );
          } finally {
            clearTimeout(timer);
          }
        },
      },
    }
  );

  const start =
    process.env.PERIOD_START ?? "2026-08-01";

  const end =
    process.env.PERIOD_END ?? "2026-08-31";

  const chunks = monthlyChunks(start, end);

  const config = JSON.parse(
    fs.readFileSync(
      path.resolve("config/keywords.json"),
      "utf8"
    )
  ) as {
    keywords: string[];
    excludeKeywords: string[];
    minBudgetAmount: number;
  };

  for (const field of [
    "keywords",
    "excludeKeywords",
  ] as const) {
    if (
      !Array.isArray(config[field]) ||
      !config[field].every(
        (value) =>
          typeof value === "string" &&
          value.trim().length > 0
      )
    ) {
      throw new Error(
        `keywords.json의 ${field} 형식 오류`
      );
    }
  }

  const minBudget = parseAmount(
    config.minBudgetAmount
  );

  if (minBudget == null || minBudget < 0) {
    throw new Error("minBudgetAmount 설정 오류");
  }

  console.log(
    "[사전 점검] Supabase 연결·컬럼·읽기 권한 확인"
  );

  const probe = await supabase
    .from("poc2_notices")
    .select(
      "work_type,bid_ntce_no,bid_ntce_ord," +
      "bid_methd_nm,cntrct_mthd_candidate," +
      "sucsfbid_mthd_candidate,raw"
    )
    .limit(1);

  if (probe.error) {
    dbFailure("Supabase 사전 점검 실패", probe.error);
  }

  console.log(
    "[사전 점검 통과] 쓰기 권한은 첫 실제 저장에서 확인합니다."
  );

  console.log(
    `수집 기간: ${start} 00:00 ~ ${end} 23:59`
  );

  const compact = (value: string) =>
    value.replace(/\s+/g, "");

  const seen = new Set<string>();
  const distribution: Record<string, number> = {};

  let matched = 0;
  let saved = 0;
  let regionEmpty = 0;
  let licenseEmpty = 0;
  let stage = "목록 조회";

  try {
    for (const { label, operation } of OPERATIONS) {
      for (const { from, to } of chunks) {
        const periodParams = {
          inqryDiv: "1",
          inqryBgnDt:
            from.replace(/-/g, "") + "0000",
          inqryEndDt:
            to.replace(/-/g, "") + "2359",
        };

        stage = `목록 조회 ${label} ${from}~${to}`;

        for await (
          const items of fetchPages(
            operation,
            periodParams,
            serviceKey
          )
        ) {
          for (const item of items) {
            stage = `필터 확인 ${label} ${text(
              item.bidNtceNo
            )}`;

            const title = compact(
              text(item.bidNtceNm)
            );

            const excluded =
              config.excludeKeywords.some((keyword) =>
                title.includes(compact(keyword))
              );

            const included =
              config.keywords.some((keyword) =>
                title.includes(compact(keyword))
              );

            if (excluded || !included) continue;

            const price = parseAmount(
              item.presmptPrce
            );

            if (
              price != null &&
              price < minBudget
            ) {
              continue;
            }

            const date = text(
              item.bidNtceDt
            ).slice(0, 10);

            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(date)
            ) {
              throw new Error(
                "공고일 누락 또는 형식 오류"
              );
            }

            if (date < from || date > to) continue;

            const no = text(item.bidNtceNo);
            if (!no) {
              throw new Error("공고번호 누락");
            }

            const ord = normalizeOrd(
              item.bidNtceOrd
            );

            const id = `${label}:${no}:${ord}`;

            if (seen.has(id)) continue;

            seen.add(id);
            matched++;

            const params = {
              inqryDiv: "2",
              bidNtceNo: no,
              bidNtceOrd: ord,
            };

            stage = `지역 조회 ${label} ${no}-${ord}`;
            console.log(`[${stage}]`);

            const regions = validateDetails(
              await fetchAll(
                REGION_OPERATION,
                params,
                serviceKey
              ),
              no,
              ord,
              label
            );

            stage = `면허 조회 ${label} ${no}-${ord}`;
            console.log(`[${stage}]`);

            const licenses = validateDetails(
              await fetchAll(
                LICENSE_OPERATION,
                params,
                serviceKey
              ),
              no,
              ord,
              label
            );

            const entry = (
              op: string,
              records: RawItem[]
            ) => ({
              operation: op,
              status: records.length
                ? "ok"
                : "no_data",
              fetched_at: new Date().toISOString(),
              items: records,
            });

            const row = {
              work_type: label,
              bid_ntce_no: no,
              bid_ntce_ord: ord,
              bid_ntce_nm: text(item.bidNtceNm),
              ntce_instt_nm: text(item.ntceInsttNm),
              dminstt_nm: text(item.dminsttNm),
              presmpt_prce: price,
              bid_methd_nm: text(item.bidMethdNm),
              cntrct_mthd_candidate: text(
                item.cntrctCnclsMthdNm
              ),
              sucsfbid_mthd_candidate: text(
                item.sucsfbidMthdNm
              ),
              bid_ntce_dt: item.bidNtceDt,
              raw: {
                ...item,
                _poc2_enrichment: {
                  schema_version: 1,
                  regions: entry(
                    REGION_OPERATION,
                    regions
                  ),
                  licenses: entry(
                    LICENSE_OPERATION,
                    licenses
                  ),
                  note:
                    "no_data는 API 결과 없음이며 제한 없음이나 자격 충족을 뜻하지 않습니다.",
                },
              },
            };

            stage = `DB 저장 ${label} ${no}-${ord}`;
            console.log(`[${stage}]`);

            const { error } = await supabase
              .from("poc2_notices")
              .upsert(row, {
                onConflict:
                  "work_type,bid_ntce_no,bid_ntce_ord",
              });

            if (error) dbFailure(stage, error);

            saved++;

            if (!regions.length) regionEmpty++;
            if (!licenses.length) licenseEmpty++;

            const method =
              row.cntrct_mthd_candidate ||
              "(값 없음)";

            distribution[method] =
              (distribution[method] ?? 0) + 1;

            console.log(
              `[저장 성공] ${label} ${no}-${ord}: ` +
              `지역 ${regions.length}건, ` +
              `면허 ${licenses.length}건`
            );
          }

          stage = `목록 조회 ${label} ${from}~${to}`;
        }
      }
    }
  } catch (err) {
    console.error(
      `[즉시 중단] 단계=${stage}`
    );

    console.error(
      `원인: ${safeMessage(
        (err as Error)?.message ?? err
      )}`
    );

    console.error(
      `중단 전 후보 ${matched}건 / 저장 성공 ${saved}건`
    );

    throw new Error(
      "위 상세 오류를 확인하세요. 나머지 조회를 중단했습니다."
    );
  }

  console.log(
    "계약방법 분포:",
    distribution
  );

  console.log(
    `수집 완료: 후보 ${matched}건 / 저장 성공 ${saved}건`
  );

  console.log(
    `지역 API 결과 없음 ${regionEmpty}건 / ` +
    `면허 API 결과 없음 ${licenseEmpty}건`
  );

  console.log(
    "기존 기간 외 데이터는 삭제하지 않았습니다."
  );
}

main().catch((err) => {
  console.error(
    "[실행 중단]",
    safeMessage((err as Error)?.message ?? err)
  );

  process.exitCode = 1;
});
