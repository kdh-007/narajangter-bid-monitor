/**
 * PoC2 — 계약방법 분기 검증용 공고 수집 스크립트
 *
 * 목적: 2026-06-01 ~ 2026-09-11 사이 게시된 본공고 중 기존 config/keywords.json 기준으로
 *       지일 사업과 관련된 공고만 걸러 수집하고, 계약방법 관련 후보 필드를 함께 저장한다.
 *       이 결과에서 계약방법이 서로 다른 5건을 골라 PoC2 정답표에 채워 넣는 데 쓴다.
 *
 * 실행 전 준비
 *   1. .env에 DATA_GO_KR_SERVICE_KEY=... 값 필요 (공공데이터포털 발급키)
 *   2. narajangter-bid-monitor/ 저장소 루트에서 실행한다고 가정 (config/keywords.json 상대경로 기준)
 *   3. Node 18+ : npx tsx scripts/poc2_collectByPeriod.ts
 *
 * 실행 전 반드시 확인/조정해야 할 것 (직접 실측 안 해본 부분이라 확신 없음)
 *   - BASE_URL의 버전 접미사(BidPublicInfoService04 등)가 현재 유효한지
 *     → data.go.kr "나라장터 입찰공고정보서비스" 활용신청 상세페이지에서 실제 Endpoint 확인
 *   - inqryBgnDt/inqryEndDt 파라미터 포맷(yyyyMMddHHmm, 12자리)과 조회 가능 기간 제한 여부
 *   - "계약방법"이 실제로 cntrctCnclsMthdNm 필드에 오는지, 아니면 sucsfbidMthdNm(낙찰방법명)
 *     쪽에 오는지 → 그래서 두 필드를 CSV에 같이 남겨서 실행 후 눈으로 확인하도록 만듦
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// ---------- 설정 ----------

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error("환경변수 DATA_GO_KR_SERVICE_KEY가 없습니다. .env를 확인하세요.");
  process.exit(1);
}

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

const OUTPUT_DIR = path.resolve(process.cwd(), "output/poc2");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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
  업무구분: string;
  공고번호: string;
  공고차수: string;
  공고명: string;
  발주기관: string;
  수요기관: string;
  추정가격: string;
  입찰방식명: string; // bidMethdNm — "전자입찰" 등. 계약방법과는 다른 필드이니 혼동 주의
  계약방법명_후보1: string; // cntrctCnclsMthdNm 추정
  낙찰방법명_후보2: string; // sucsfbidMthdNm 추정
  공고게시일시: string;
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
    const url = new URL(`${BASE_URL}/${opPath}`);
    url.searchParams.set("serviceKey", SERVICE_KEY!);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("numOfRows", String(numOfRows));
    url.searchParams.set("inqryDiv", "1"); // 1 = 날짜기준 조회 (실측 필요)
    url.searchParams.set("inqryBgnDt", toApiDate(fromDate));
    url.searchParams.set("inqryEndDt", toApiDate(toDate, true));
    url.searchParams.set("type", "json");

    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`  ! HTTP ${res.status} — ${opPath} (${fromDate}~${toDate})`);
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
  return {
    업무구분: label,
    공고번호: item.bidNtceNo ?? "",
    공고차수: item.bidNtceOrd ?? "",
    공고명: item.bidNtceNm ?? "",
    발주기관: item.ntceInsttNm ?? "",
    수요기관: item.dminsttNm ?? "",
    추정가격: item.presmptPrce ?? "",
    입찰방식명: item.bidMethdNm ?? "",
    계약방법명_후보1: item.cntrctCnclsMthdNm ?? "",
    낙찰방법명_후보2: item.sucsfbidMthdNm ?? "",
    공고게시일시: item.bidNtceDt ?? "",
  };
}

function toCsv(rows: CollectedRow[]): string {
  const headers: (keyof CollectedRow)[] = [
    "업무구분", "공고번호", "공고차수", "공고명", "발주기관", "수요기관",
    "추정가격", "입찰방식명", "계약방법명_후보1", "낙찰방법명_후보2", "공고게시일시",
  ];
  const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
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

      allRows.push(...filtered.map((item) => toCollectedRow(label, item)));

      // 원본 JSON도 그대로 저장 (필드명 실측 확인용)
      const rawFileName = `raw_${label}_${from}_${to}.json`;
      fs.writeFileSync(path.join(OUTPUT_DIR, rawFileName), JSON.stringify(filtered, null, 2), "utf-8");
    }
  }

  const csv = toCsv(allRows);
  fs.writeFileSync(path.join(OUTPUT_DIR, "poc2_summary.csv"), csv, "utf-8");

  // 계약방법명_후보1 기준 분포 — 5종 확보 여부를 한눈에 보기 위함
  const grouped: Record<string, number> = {};
  for (const row of allRows) {
    const key = row.계약방법명_후보1 || "(값 없음)";
    grouped[key] = (grouped[key] ?? 0) + 1;
  }

  console.log("\n=== 계약방법명_후보1 기준 분포 ===");
  for (const [key, count] of Object.entries(grouped).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}건`);
  }
  console.log(`\n총 ${allRows.length}건 저장 완료 -> ${OUTPUT_DIR}/poc2_summary.csv`);
  console.log("※ 계약방법명_후보1이 비어있거나 이상하면 낙찰방법명_후보2와 raw JSON을 같이 확인할 것");
}

main().catch((err) => {
  console.error("실행 중 오류:", err);
  process.exit(1);
});
