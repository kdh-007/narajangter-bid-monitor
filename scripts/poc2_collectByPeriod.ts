/**
 * PoC2: 2026-08-01 ~ 2026-08-31 공고 + 참가가능지역 + 면허제한 수집.
 * 기존 scripts/poc2_collectByPeriod.ts 전체를 이 파일로 교체한다.
 * 기존 workflow / package.json / config/keywords.json을 그대로 사용한다.
 * PERIOD_START, PERIOD_END 환경변수로 기간 변경 가능 (한국 공고일 기준).
 * 추가 결과는 raw._poc2_enrichment에 저장. 별도 DB 컬럼 추가 불필요.
 * 기존 코드의 DB 컬럼명 및 복합 UNIQUE 키를 그대로 사용한다.
 * 기존 6~9월 데이터는 삭제하지 않는다. 조회 또는 저장 실패 시 종료코드 1.
 * 지역/면허 조회 중 하나라도 실패하면 해당 공고를 덮어쓰지 않는다.
 * 빠른 진단: DB 읽기 사전 점검, 목록 페이지별 즉시 처리, 첫 오류에서 중단.
 * 사전 점검만으로 쓰기 권한을 보장하지 않으며 첫 실제 저장에서 확인한다.
 * 공식 명세: https://www.data.go.kr/data/15129394/openapi.do
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type RawItem = Record<string, any>;
const BASE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
const OPERATIONS = [
  { label: "물품", operation: "getBidPblancListInfoThngPPSSrch" },
  { label: "용역", operation: "getBidPblancListInfoServcPPSSrch" },
  { label: "공사", operation: "getBidPblancListInfoCnstwkPPSSrch" },
];
const REGION_OPERATION = "getBidPblancListInfoPrtcptPsblRgn";
const LICENSE_OPERATION = "getBidPblancListInfoLicenseLimit";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const text = (value: unknown) => value == null ? "" : String(value).trim();

export function normalizeOrd(value: unknown): string {
  const ord = text(value);
  if (!/^\d{1,3}$/.test(ord)) throw new Error("공고차수 누락 또는 형식 오류");
  return ord.padStart(3, "0");
}

export function parseAmount(value: unknown): number | null {
  const s = text(value).replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function monthlyChunks(start: string, end: string) {
  const parse = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("기간은 YYYY-MM-DD 형식이어야 합니다.");
    const d = new Date(s + "T00:00:00Z");
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      throw new Error("유효하지 않은 날짜입니다.");
    }
    return d;
  };
  let cursor = parse(start);
  const last = parse(end);
  if (cursor > last) throw new Error("시작일이 종료일보다 늦습니다.");
  const result: { from: string; to: string }[] = [];
  while (cursor <= last) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const monthEnd = new Date(next.getTime() - 86400000);
    result.push({ from: cursor.toISOString().slice(0, 10),
      to: (monthEnd < last ? monthEnd : last).toISOString().slice(0, 10) });
    cursor = next;
  }
  return result;
}

export function normalizeItems(value: any): RawItem[] {
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value : value.item;
  if (items == null || items === "") {
    if (typeof value === "object" && Object.keys(value).length === 0) return [];
    throw new Error("알 수 없는 items 응답 구조");
  }
  const list = Array.isArray(items) ? items : [items];
  if (!list.every(it => it && typeof it === "object" && !Array.isArray(it))) {
    throw new Error("items에 잘못된 항목이 있습니다.");
  }
  return list;
}

export function buildUrl(operation: string, params: Record<string, string>, key: string) {
  // Encoding 키와 Decoding 키 모두 URLSearchParams에서 한 번만 인코딩.
  let decoded = key.trim();
  if (/%[0-9a-f]{2}/i.test(decoded)) decoded = decodeURIComponent(decoded);
  const query = new URLSearchParams({ ...params, type: "json", serviceKey: decoded });
  return `${BASE_URL}/${operation}?${query}`;
}

class ApiError extends Error {
  retryable: boolean;
  constructor(message: string, retryable = false) { super(message); this.retryable = retryable; }
}

export async function fetchPage(
  operation: string,
  params: Record<string, string>,
  key: string
) {
  const TIMEOUT_MS = 30000;
  const MAX_ATTEMPTS = 2;

  const safeMessage = (value: unknown): string => {
    let message = text(value);

    const variants = [key, encodeURIComponent(key)];

    try {
      variants.push(decodeURIComponent(key));
    } catch {
      // 디코딩할 수 없는 키는 원래 값으로 마스킹한다.
    }

    for (const variant of variants) {
      if (variant) {
        message = message.split(variant).join("[REDACTED]");
      }
    }

    return message
      .replace(/serviceKey=[^&\s]+/gi, "serviceKey=[REDACTED]")
      .slice(0, 800);
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await sleep(300);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      TIMEOUT_MS
    );

    try {
      console.log(
        `[API 요청] ${operation} / 페이지 ${params.pageNo ?? "1"} / ` +
        `${attempt}/${MAX_ATTEMPTS}회 / 제한시간 30초`
      );

      const res = await fetch(
        buildUrl(operation, params, key),
        { signal: controller.signal }
      );

      if (!res.ok) {
        throw new ApiError(
          `HTTP ${res.status} ${res.statusText}`,
          res.status === 429 || res.status >= 500
        );
      }

      const bodyText = await res.text();
      let data: any;

      try {
        data = JSON.parse(bodyText);
      } catch {
        const match = bodyText.match(
          /<(?:returnAuthMsg|returnReasonCode|errMsg)>([^<]*)</
        );

        throw new ApiError(
          "JSON 형식이 아닌 응답 수신: " +
          (match
            ? safeMessage(match[1])
            : `Content-Type=${res.headers.get("content-type") ?? "없음"}`),
          false
        );
      }

      const response = data?.response;
      const code = text(response?.header?.resultCode);

      if (code !== "00") {
        throw new ApiError(
          `API 코드=${safeMessage(code) || "없음"}, ` +
          `메시지=${safeMessage(response?.header?.resultMsg) || "없음"}`,
          ["01", "02", "04", "05"].includes(code)
        );
      }

      const body = response?.body;

      if (
        body?.totalCount == null ||
        text(body.totalCount) === ""
      ) {
        throw new ApiError("응답에 totalCount가 없습니다.");
      }

      const totalCount = Number(body.totalCount);

      if (
        !Number.isSafeInteger(totalCount) ||
        totalCount < 0
      ) {
        throw new ApiError("응답의 totalCount가 올바르지 않습니다.");
      }

      const items = normalizeItems(body.items);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      console.log(
        `[API 성공] ${operation} / ${elapsed}초 / ${items.length}건`
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

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const timedOut = controller.signal.aborted;

      console.error(
        "[API 오류 상세]",
        JSON.stringify(
          {
            operation,
            pageNo: params.pageNo ?? "1",
            attempt,
            elapsedSeconds: elapsed,
            timedOut,
            name: safeMessage(error?.name),
            code: safeMessage(error?.code),
            message: timedOut
              ? "요청 시작 후 30초 안에 응답 수신을 완료하지 못했습니다."
              : safeMessage(error?.message),
            causeCode: safeMessage(error?.cause?.code),
            causeMessage: safeMessage(error?.cause?.message),
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

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new ApiError(
          `${operation}: ${
            timedOut
              ? "30초 응답 시간초과"
              : safeMessage(error?.message) || "원인 미확인"
          } — 위 API 오류 상세 확인`
        );
      }

      console.warn("[재시도 예정] 1초 후 한 번 더 요청합니다.");
    } finally {
      clearTimeout(timer);
    }

    await sleep(1000);
  }

  throw new ApiError(`${operation}: 요청 종료`);
}

// 전체 월 수집이 끝나기를 기다리지 않고, 페이지마다 실제 작업을 진행한다.
export async function* fetchPages(operation: string, params: Record<string, string>, key: string) {
  let count = 0;
  let previous = "";
  for (let pageNo = 1; pageNo <= 10000; pageNo++) {
    console.log(`[목록 요청] ${operation} ${pageNo}페이지`);
    const page = await fetchPage(operation, {...params, pageNo: String(pageNo), numOfRows: "100"}, key);
    if (!page.items.length) {
      if (count < page.totalCount) throw new Error("목록 페이지 누락: 전체 건수보다 적게 수신");
      return;
    }
    const fingerprint = JSON.stringify(page.items);
    if (fingerprint === previous) throw new Error("동일 목록 페이지 반복 수신");
    previous = fingerprint;
    count += page.items.length;
    console.log(`[목록 수신] ${operation}: ${count}/${page.totalCount}건`);
    yield page.items;
    if (count >= page.totalCount) return;
  }
  throw new Error("목록 페이지 안전 한도 초과");
}

export function validateDetails(items: RawItem[], no: string, ord: string, label: string) {
  for (const item of items) {
    if (text(item.bidNtceNo) !== no || normalizeOrd(item.bidNtceOrd) !== ord) {
      throw new Error("추가 조회 결과의 공고번호·차수가 요청과 다릅니다.");
    }
    if (text(item.bsnsDivNm) && text(item.bsnsDivNm) !== label) {
      throw new Error("추가 조회 결과의 업무구분이 요청과 다릅니다.");
    }
  }
  return items; // 그룹·순번·복수 지역/면허를 축약하지 않고 보존
}

export async function main() {
  await import("dotenv/config");
  const { createClient } = await import("@supabase/supabase-js");
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`환경변수 ${name}가 없습니다.`);
    return value;
  };
  const key = required("DATA_GO_KR_SERVICE_KEY");
  const secrets = [key, required("SUPABASE_KEY")];
  const safe = (value: unknown) => {
    let out = text(value);
    for (const secret of secrets) {
      for (const variant of [secret, encodeURIComponent(secret)]) out = out.split(variant).join("[REDACTED]");
    }
    return out.replace(/sb_secret_[A-Za-z0-9_-]+/g, "[REDACTED]");
  };
  const dbFailure = (stage: string, error: any): never => {
    console.error(`[${stage}]`, JSON.stringify({code: error.code, message: safe(error.message), details: safe(error.details), hint: safe(error.hint)}, null, 2));
    throw new Error(`${stage} 실패: ${safe(error.code)} ${safe(error.message)}`);
  };
  const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_KEY"), {
    global: { fetch: async (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(input, {...init, signal: controller.signal});
        const body = await response.arrayBuffer();
        return new Response(body.byteLength ? body : null, {status: response.status, statusText: response.statusText, headers: response.headers});
      } finally { clearTimeout(timer); }
    } },
  });
  const start = process.env.PERIOD_START ?? "2026-08-01";
  const end = process.env.PERIOD_END ?? "2026-08-31";
  const chunks = monthlyChunks(start, end);
  const config = JSON.parse(fs.readFileSync(path.resolve("config/keywords.json"), "utf8"));
  for (const field of ["keywords", "excludeKeywords"]) {
    if (!Array.isArray(config[field]) || !config[field].every((v: unknown) => typeof v === "string" && v.trim())) {
      throw new Error(`keywords.json의 ${field} 형식 오류`);
    }
  }
  const minBudget = parseAmount(config.minBudgetAmount);
  if (minBudget == null || minBudget < 0) throw new Error("minBudgetAmount 설정 오류");
  const compact = (s: string) => s.replace(/\s+/g, "");
  let matched = 0, saved = 0, failedNotices = 0, failedChunks = 0;
  let regionEmpty = 0, licenseEmpty = 0;
  const seen = new Set<string>();
  const distribution: Record<string, number> = {};
  console.log("[사전 점검] Supabase 연결·컬럼·읽기 권한 확인 (쓰기 권한은 첫 실제 저장에서 확인)");
  const probe = await supabase.from("poc2_notices").select("work_type,bid_ntce_no,bid_ntce_ord,bid_methd_nm,cntrct_mthd_candidate,sucsfbid_mthd_candidate,raw").limit(1);
  if (probe.error) dbFailure("Supabase 사전 점검", probe.error);
  console.log("[사전 점검 통과] 목록은 100건씩 받고 후보를 찾는 즉시 추가 조회·저장합니다.");
  console.log(`수집 기간: ${start} 00:00 ~ ${end} 23:59 (한국 공고일 기준)`);
  for (const { label, operation } of OPERATIONS) {
    for (const { from, to } of chunks) {
      for await (const items of fetchPages(operation, {inqryDiv: "1",
        inqryBgnDt: from.replace(/-/g, "") + "0000",
        inqryEndDt: to.replace(/-/g, "") + "2359"}, key)) {
      for (const item of items) {
        const title = compact(text(item.bidNtceNm));
        if (config.excludeKeywords.some((kw: string) => title.includes(compact(kw))) ||
            !config.keywords.some((kw: string) => title.includes(compact(kw)))) continue;
        const price = parseAmount(item.presmptPrce);
        if (price != null && price < minBudget) continue;
        // 원본 공고일로 기간을 재확인: 과거 데이터가 이번 실행에 섞이지 않게 함.
        const date = text(item.bidNtceDt).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new Error(`[${label}] 공고일 누락/형식 오류`);
        }
        if (date < from || date > to) continue;
        matched++;
        const no = text(item.bidNtceNo);
        try {
          if (!no) throw new Error("공고번호 누락");
          const ord = normalizeOrd(item.bidNtceOrd);
          const id = `${label}:${no}:${ord}`;
          if (seen.has(id)) { matched--; continue; }
          seen.add(id);
          // 2: 공고번호 조회. 특정 차수를 지정해 다른 차수 정보가 섞이지 않게 한다.
          const params = { inqryDiv: "2", bidNtceNo: no, bidNtceOrd: ord };
          console.log(`  [지역 조회] ${label} ${no}-${ord}`);
          const regions = validateDetails(await fetchAll(REGION_OPERATION, params, key), no, ord, label);
          console.log(`  [면허 조회] ${label} ${no}-${ord}`);
          const licenses = validateDetails(await fetchAll(LICENSE_OPERATION, params, key), no, ord, label);
          const entry = (operation: string, records: RawItem[]) => ({
            operation, status: records.length ? "ok" : "no_data",
            fetched_at: new Date().toISOString(), items: records,
          });
          const row = {
            work_type: label, bid_ntce_no: no, bid_ntce_ord: ord,
            bid_ntce_nm: text(item.bidNtceNm), ntce_instt_nm: text(item.ntceInsttNm),
            dminstt_nm: text(item.dminsttNm), presmpt_prce: price,
            bid_methd_nm: text(item.bidMethdNm),
            cntrct_mthd_candidate: text(item.cntrctCnclsMthdNm),
            sucsfbid_mthd_candidate: text(item.sucsfbidMthdNm),
            bid_ntce_dt: item.bidNtceDt,
            raw: { ...item, _poc2_enrichment: {
              schema_version: 1,
              regions: entry(REGION_OPERATION, regions),
              licenses: entry(LICENSE_OPERATION, licenses),
              note: "no_data는 API 조회 결과 없음이며 제한 없음이나 자격 충족을 뜻하지 않습니다.",
            } },
          };
          console.log(`  [DB 저장] ${label} ${no}-${ord}`);
          const { error } = await supabase.from("poc2_notices")
            .upsert(row, { onConflict: "work_type,bid_ntce_no,bid_ntce_ord" });
          if (error) dbFailure(`Supabase 저장 ${label} ${no}-${ord}`, error);
          saved++;
          if (!regions.length) regionEmpty++;
          if (!licenses.length) licenseEmpty++;
          const method = row.cntrct_mthd_candidate || "(값 없음)";
          distribution[method] = (distribution[method] ?? 0) + 1;
          console.log(`  저장 ${label} ${no}-${ord}: 지역 ${regions.length}건, 면허 ${licenses.length}건`);
        } catch (err) {
          failedNotices++;
          console.error(`  [즉시 중단] ${label} ${no}-${text(item.bidNtceOrd)}: ${safe((err as Error).message)}`);
          console.error(`중단 전 저장 성공 ${saved}건. 실패 건은 저장 완료로 처리하지 않습니다.`);
          throw new Error("위 상세 오류를 확인하세요. 나머지 공고 조회를 중단했습니다.");
        }
      }
    }
  }
  }
  console.log("계약방법 분포 (이번 실행 저장 성공 건):", distribution);
  console.log(`대상 ${matched}건 / 저장 성공 ${saved}건 / 공고 실패 ${failedNotices}건 / 목록 구간 실패 ${failedChunks}건`);
  console.log(`저장 성공 중 지역 API 결과 없음 ${regionEmpty}건 / 면허 API 결과 없음 ${licenseEmpty}건`);
  if (failedNotices || failedChunks) {
    throw new Error("일부 수집·저장 실패. 성공 건은 저장되었으며 로그 확인 후 재실행하세요.");
  }
  console.log("수집 완료. 기존 기간 외 데이터는 삭제하지 않았습니다.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => { console.error("[실행 중단]", (err as Error).message); process.exitCode = 1; });
}
