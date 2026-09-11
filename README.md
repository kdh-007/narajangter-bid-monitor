# jiil-poc2-contract-method

PoC2 — 계약방법 분기 검증용 공고 수집 저장소.

나라장터 입찰공고정보서비스 API에서 2026-06-01 ~ 2026-09-11 기간의 본공고를 조회해,
기존 키워드 필터로 지일 사업 관련 공고만 걸러 수집한다. 결과에서 계약방법이 서로 다른
사례들을 찾아 PoC2 정답표를 채우는 데 쓴다.

## 준비

```bash
npm install
cp .env.example .env
# .env에 DATA_GO_KR_SERVICE_KEY=발급받은키 입력
```

## 실행

```bash
npm run collect
```

결과는 `output/poc2/`에 저장됨:
- `raw_{업무구분}_{시작월}_{종료월}.json` — 월/업무구분별 원본 응답
- `poc2_summary.csv` — 통합 요약표

## 확인 필요 사항

`scripts/poc2_collectByPeriod.ts` 상단 주석 참고 — API 버전 접미사, 날짜 파라미터 포맷,
계약방법 필드명(cntrctCnclsMthdNm vs sucsfbidMthdNm)은 실제 실행 후 검증 필요.

## config/keywords.json

기존 narajangter-bid-monitor 저장소 값을 재현한 것. 원본과 차이가 있을 수 있으니
가능하면 원본 파일로 교체 권장.
