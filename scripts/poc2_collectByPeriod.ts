/**
 * PoC2 — 계약방법 분기 검증용 공고 수집 스크립트
 *
 * 목적: 2026-06-01 ~ 2026-09-11 사이 게시된 본공고 중 기존 config/keywords.json 기준으로
 *       지일 사업과 관련된 공고만 걸러 수집하고, 계약방법 관련 후보 필드를 함께
 *       Supabase(poc2_notices 테이블)에 저장한다.
 *       이 결과에서 계약방법이 서로 다른 5건을 골라 PoC2 정답표에 채워 넣는 데 쓴다.
 *
 * 실행 전 준비
 *   1. .env에 DATA_GO_KR_SERVICE_KEY, SUPABASE_URL, SUPABASE_KEY 값 필요
 *   2. narajangter-bid-monitor/ 저장소 루트에서 실행한다고 가정 (config/keywords.json 상대경로 기준)
 *   3. Node 18+ : npm install 후 npx tsx scripts/poc2_collectByPeriod.ts
 *
 * 실행 전 반드시 확인/조정해야 할 것 (직접 실측 안 해본 부분이라 확신 없음)
 *   - BASE_URL의 버전 접미사(BidPublicInfoService04 등)가 현재 유효한지
 *     → data.go.kr "나라장터 입찰공고정보서비스" 활용신청 상세페이지에서 실제 Endpoint 확인
 *   - inqryBgnDt/inqryEndDt 파라미터 포맷(yyyyMMddHHmm, 12자리)과 조회 가능 기간 제한 여부
 *   - "계약방법"이 실제로 cntrctCnclsMthdNm 필드에 오는지, 아니면 sucsfbidMthdNm(낙찰방법명)
 *     쪽에 오는지 → 그래서 두 필드를 DB에 같이 남겨서 실행 후 눈으로 확인하도록 만듦
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// ---------- 설정 ----------

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error("환경변수 DATA_GO_KR_SERVICE_KEY가 없습니다. .env를 확인하세요.");
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("환경변수 SUPABASE_URL / SUPABASE_KEY가 없습니다. .env를 확인하세요.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 조사 기간 (필요시 직접 수정)
const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-09-11";

// 기존 config 재사용. 저장소 루트(narajangter-bid-monitor/)에서 실행한다고 가정.
const CONFIG_DIR = path.resolve(process.cwd(), "config");
const keywordsConfig = JSON.parse(
  fs.readFileSync(path.join(CONFIG_DIR, "keywords.json"), "utf-8")
) as {
  keywords: string[];
  excludeKeywords: string[];
  minBudgetAmount: number;
};

// 나라장터 입찰공고정보서비스 — 업무구분별 "검색조건별 목록" 오퍼레이션
// ⚠ 버전 접미사(04)는 확인 필요 — data.go.kr 상세페이지의 Endpoint로 교체할 것
const BASE_URL = "https://apis.data.go.kr/1230000/BidPublicInfoService04";
const OPERATIONS: { label: string; path: string }[] = [
  { label: "물품", path: "getBidPblancListInfoThngPPSSrch" },
  { label: "용역", path: "getBidPblancListInfoServcPPSSrch" },
  { label: "공사", path: "getBidPblancListInfoCnstwkPPSSrch" },
];

type RawItem = Record<string, any>;

interface CollectedRow {
  work_type: string;
  bid_ntce_no: string;
  bid_ntce_ord: string;
  bid_ntce_nm: string;
  ntce_instt_nm: string;
  dminstt_nm: string;
  presmpt_prce: number | null;
  bid_methd_nm: string; // bidMethdNm — "전자입찰" 등. 계약방법과는 다른 필드이니 혼동 주의
  cntrct_mthd_candidate: string; // cntrctCnclsMthdNm 추정
  sucsfbid_mthd_candidate: string; // sucsfbidMthdNm 추정
  bid_ntce_dt: string;
  raw: RawItem;
}

// ---------- 유틸 ----------

function toApiDate(dateStr: string, endOfDay = false): string {
  // yyyy-MM-dd -> yyyyMMddHHmm (12자리)
  const compact = dateStr.replace(/-/g, "");
  return compact + (endOfDay ? "2359" : "0000");
}

function monthlyChunks(start: string, end: string): { from: string; to: string }[] {
  // 긴 기간을 한 번에 조회 못 할 가능성을 감안해 월 단위로 쪼갬
  const chunks: { from: string; to: string }[] = [];
  let cursor = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");

  while (cursor <= endDate) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const clippedEnd = chunkEnd > endDate ? endDate : chunkEnd;

    chunks.push({
      from: chunkStart.toISOString().slice(0, 10),
      to: clippedEnd.toISOString().slice(0, 10),
    });

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return chunks;
}

function matchesKeywordFilter(title: string): boolean {
  const normalized = title.replace(/\s+/g, "");
  const hasExclude = keywordsConfig.excludeKeywords.some((kw) =>
    normalized.includes(kw.replace(/\s+/g, ""))
  );
  if (hasExclude) return false;

  return keywordsConfig.keywords.some((kw) => normalized.includes(kw.replace(/\s+/g, "")));
}

function passesBudget(presmptPrce: string | undefined): boolean {
  if (!presmptPrce) return true; // 예산 정보 없으면 통과 (기존 로직과 동일, fail-open)
  const amount = Number(presmptPrce);
  if (Number.isNaN(amount)) return true;
  return amount >= keywordsConfig.minBudgetAmount;
}

async function fetchOperation(opPath: string, fromDate: string, toDate: string): Promise<RawItem[]> {
  const results: RawItem[] = [];
  let pageNo = 1;
  const numOfRows = 500;

  while (true) {
    // ⚠ serviceKey는 공공데이터포털에서 이미 URL 인코딩된 값(Encoding 키)인 경우가 많아서,
    //    URLSearchParams.set()으로 넣으면 이중 인코딩되어 400 에러가 남. 그래서 이 값만 직접 문자열에 붙임.
    const otherParams = new URLSearchParams({
      pageNo: String(pageNo),
      numOfRows: String(numOfRows),
      inqryDiv: "1", // 1 = 날짜기준 조회 (실측 필요)
      inqryBgnDt: toApiDate(fromDate),
      inqryEndDt: toApiDate(toDate, true),
      type: "json",
    });
    const url = `${BASE_URL}/${opPath}?serviceKey=${SERVICE_KEY}&${otherParams.toString()}`;

    const res = await fetch(url);
    if (!res.ok) {
      const bodyText = await res.text();
      console.error(`  ! HTTP ${res.status} — ${opPath} (${fromDate}~${toDate})`);
      console.error(`    응답 내용: ${bodyText.slice(0, 500)}`);
      break;
    }
    const data: any = await res.json();

    const header = data?.response?.header;
    if (header && header.resultCode !== "00") {
      console.error(`  ! API 오류 [${header.resultCode}] ${header.resultMsg} — ${opPath}`);
      break;
    }

    const body = data?.response?.body;
    const items: RawItem[] = body?.items ?? [];
    const normalizedItems = Array.isArray(items) ? items.filter((it) => it && typeof it === "object") : [];

    results.push(...normalizedItems);

    const totalCount = Number(body?.totalCount ?? 0);
    if (pageNo * numOfRows >= totalCount || normalizedItems.length === 0) break;
    pageNo += 1;
  }

  return results;
}

function toCollectedRow(label: string, item: RawItem): CollectedRow {
  const price = Number(item.presmptPrce);
  return {
    work_type: label,
    bid_ntce_no: item.bidNtceNo ?? "",
    bid_ntce_ord: item.bidNtceOrd ?? "",
    bid_ntce_nm: item.bidNtceNm ?? "",
    ntce_instt_nm: item.ntceInsttNm ?? "",
    dminstt_nm: item.dminsttNm ?? "",
    presmpt_prce: Number.isNaN(price) ? null : price,
    bid_methd_nm: item.bidMethdNm ?? "",
    cntrct_mthd_candidate: item.cntrctCnclsMthdNm ?? "",
    sucsfbid_mthd_candidate: item.sucsfbidMthdNm ?? "",
    bid_ntce_dt: item.bidNtceDt ?? "",
    raw: item,
  };
}

// ---------- 실행 ----------

async function main() {
  const chunks = monthlyChunks(PERIOD_START, PERIOD_END);
  const allRows: CollectedRow[] = [];

  for (const { label, path: opPath } of OPERATIONS) {
    for (const { from, to } of chunks) {
      console.log(`[${label}] ${from} ~ ${to} 조회 중...`);
      const items = await fetchOperation(opPath, from, to);
      console.log(`  -> ${items.length}건 수신`);

      const filtered = items.filter(
        (item) => matchesKeywordFilter(item.bidNtceNm ?? "") && passesBudget(item.presmptPrce)
      );
      console.log(`  -> 필터 통과 ${filtered.length}건`);

      const rows = filtered.map((item) => toCollectedRow(label, item));
      allRows.push(...rows);

      if (rows.length > 0) {
        const { error } = await supabase
          .from("poc2_notices")
          .upsert(rows, { onConflict: "work_type,bid_ntce_no,bid_ntce_ord" });
        if (error) {
          console.error(`  ! Supabase 저장 오류 (${label}, ${from}~${to}):`, error.message);
        } else {
          console.log(`  -> Supabase poc2_notices 테이블에 ${rows.length}건 저장`);
        }
      }
    }
  }

  // 계약방법 후보1 기준 분포 — 5종 확보 여부를 한눈에 보기 위함
  const grouped: Record<string, number> = {};
  for (const row of allRows) {
    const key = row.cntrct_mthd_candidate || "(값 없음)";
    grouped[key] = (grouped[key] ?? 0) + 1;
  }

  console.log("\n=== cntrct_mthd_candidate(계약방법 후보1) 기준 분포 ===");
  for (const [key, count] of Object.entries(grouped).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}건`);
  }
  console.log(`\n총 ${allRows.length}건을 Supabase poc2_notices 테이블에 저장 완료`);
  console.log("※ cntrct_mthd_candidate이 비어있거나 이상하면 sucsfbid_mthd_candidate와 raw 컬럼(원본 JSON)을 같이 확인할 것");
}

main().catch((err) => {
  console.error("실행 중 오류:", err);
  process.exit(1);
});
