/**
 * PoC2: 2026-08-01 ~ 2026-08-31 공고 + 참가가능지역 + 면허제한 수집.
 * 기존 scripts/poc2_collectByPeriod.ts 전체를 이 파일로 교체한다.
 * 기존 workflow / package.json / config/keywords.json을 그대로 사용한다.
 * PERIOD_START, PERIOD_END 환경변수로 기간 변경 가능 (한국 공고일 기준).
 * 추가 결과는 raw._poc2_enrichment에 저장. 별도 DB 컬럼 추가 불필요.
 * 기존 코드의 DB 컬럼명 및 복합 UNIQUE 키를 그대로 사용한다.
 * 기존 6~9월 데이터는 삭제하지 않는다. 조회 또는 저장 실패 시 종료코드 1.
 * 지역/면허 조회 중 하나라도 실패하면 해당 공고를 덮어쓰지 않는다.
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

export async function fetchPage(operation: string, params: Record<string, string>, key: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(300);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(buildUrl(operation, params, key), { signal: controller.signal });
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status === 429 || res.status >= 500);
      // 본문 수신까지 타임아웃 적용. URL/인증키/원문 오류 응답은 로그에 남기지 않음.
      const bodyText = await res.text();
      let data: any;
      try { data = JSON.parse(bodyText); }
      catch { throw new ApiError("JSON 응답이 아님: 인증·서비스 상태 확인 필요", true); }
      const response = data?.response;
      const code = text(response?.header?.resultCode);
      if (code !== "00") {
        throw new ApiError(`API 결과코드 ${/^[A-Z0-9_]{1,60}$/i.test(code) ? code : "미확인"}`,
          ["01", "02", "04", "05"].includes(code));
      }
      const body = response?.body;
      if (body?.totalCount == null || text(body.totalCount) === "") throw new ApiError("totalCount 누락");
      const totalCount = Number(body.totalCount);
      if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new ApiError("totalCount 오류");
      return { items: normalizeItems(body.items), totalCount };
    } catch (err) {
      const safeError = err instanceof ApiError ? err : new ApiError("연결·응답 수신 실패", true);
      if (!safeError.retryable || attempt === 5) throw safeError;
      console.warn(`  ${operation}: ${safeError.message}, 재시도 ${attempt}/5`);
    } finally { clearTimeout(timer); }
    await sleep(Math.min(3000 * 2 ** (attempt - 1), 15000));
  }
  throw new ApiError("재시도 종료");
}

export async function fetchAll(operation: string, params: Record<string, string>, key: string) {
  const results: RawItem[] = [];
  const numOfRows = 500;
  let previousPage = "";
  for (let pageNo = 1; pageNo <= 10000; pageNo++) {
    const page = await fetchPage(operation, { ...params, pageNo: String(pageNo), numOfRows: String(numOfRows) }, key);
    if (!page.items.length) {
      if (results.length < page.totalCount) throw new ApiError("전체 건수에 못 미친 빈 페이지");
      return results;
    }
    const fingerprint = JSON.stringify(page.items);
    if (fingerprint === previousPage) throw new ApiError("동일 페이지 반복 수신");
    previousPage = fingerprint;
    results.push(...page.items);
    if (results.length >= page.totalCount) return results;
  }
  throw new ApiError("페이지 안전 한도 초과");
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
  const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_KEY"));
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
  console.log(`수집 기간: ${start} 00:00 ~ ${end} 23:59 (한국 공고일 기준)`);
  for (const { label, operation } of OPERATIONS) {
    for (const { from, to } of chunks) {
      let items: RawItem[];
      try {
        items = await fetchAll(operation, { inqryDiv: "1",
          inqryBgnDt: from.replace(/-/g, "") + "0000",
          inqryEndDt: to.replace(/-/g, "") + "2359" }, key);
      } catch (err) {
        failedChunks++;
        console.error(`[${label}] ${from}~${to} 목록 수집 실패: ${(err as Error).message}`);
        continue;
      }
      console.log(`[${label}] ${from}~${to}: ${items.length}건 수신`);
      for (const item of items) {
        const title = compact(text(item.bidNtceNm));
        if (config.excludeKeywords.some((kw: string) => title.includes(compact(kw))) ||
            !config.keywords.some((kw: string) => title.includes(compact(kw)))) continue;
        const price = parseAmount(item.presmptPrce);
        if (price != null && price < minBudget) continue;
        // 원본 공고일로 기간을 재확인: 과거 데이터가 이번 실행에 섞이지 않게 함.
        const date = text(item.bidNtceDt).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          failedNotices++; console.error(`[${label}] 공고일 누락/형식 오류`); continue;
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
          const regions = validateDetails(await fetchAll(REGION_OPERATION, params, key), no, ord, label);
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
          const { error } = await supabase.from("poc2_notices")
            .upsert(row, { onConflict: "work_type,bid_ntce_no,bid_ntce_ord" });
          if (error) throw new Error(`Supabase 저장 실패 (코드 ${error.code ?? "미확인"}): 컬럼/권한/고유키 확인`);
          saved++;
          if (!regions.length) regionEmpty++;
          if (!licenses.length) licenseEmpty++;
          const method = row.cntrct_mthd_candidate || "(값 없음)";
          distribution[method] = (distribution[method] ?? 0) + 1;
          console.log(`  저장 ${label} ${no}-${ord}: 지역 ${regions.length}건, 면허 ${licenses.length}건`);
        } catch (err) {
          failedNotices++;
          console.error(`  실패 ${label} ${no}: ${(err as Error).message} — 해당 공고 저장 보류`);
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
  main().catch(err => { console.error((err as Error).message); process.exitCode = 1; });
}
