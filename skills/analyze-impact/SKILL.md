---
name: analyze-impact
model: sonnet
description: 변경 대상(파일/함수/클래스/SQL/엔드포인트/DB 컬럼)의 직간접 영향과 위험도를 분석한다. "영향도 분석", "이거 수정하면 어디 영향?", "이 함수 수정해도 돼?", "이 SQL 바꾸면 어디 영향?", "이 컬럼 추가했을 때 영향", "impact analysis", "이 API 변경 영향", "분석해줘 영향", "이거 건드려도 돼?", "어디서 쓰이고 있어?", "이 메서드 호출처" 요청 시 트리거. 축약 호출 "영향도 [대상]", "임팩트 [대상]"도 트리거. 인덱스가 없으면 analyzer를 feature-scoped 모드로 먼저 호출.
---

# Analyze Impact (오케스트레이터) — v2

변경 대상을 받아 `impact-analyzer` 로 직간접 영향(다른 저장소 화면 포함)과 위험도를 낸다. 수정 · 개발 · 마이그레이션의 시작점이다.

**모델 고정:** `sonnet` 별칭. Opus 로 자동 승격하지 않는다.

<!-- cli:executor -->
## 실행자에게

- 대상 정규화: "OrderService.cancel 수정" → 메서드 · "ORDER_LMS_U02 쿼리" → SQL id · "TBL_ORDER 에 STATUS 추가" → DB 스키마 · "/api/orders/{id} 응답 변경" → 엔드포인트. 모호하면 1회만 묻는다.
- `<사전 영향도>` 블록이 있으면 그것이 `impact` 결과다. 없으면 `QueryIndex impact` 부터 부른다.
- 영향받는 곳은 전부 나열한다. 표본만 원문으로 검증하고, 열지 않은 곳은 "인덱스 근거"로 표시한다.
- 단독으로 불렸으면 끝에 다음 액션 한 줄: 진행하려면 `/modify`, 회귀 테스트가 필요하면 test-generator.
<!-- /cli:executor -->

---

## 플러그인(Claude Code)에서 실행할 때

1. **입력 정규화** — 위 "실행자에게" 와 같다.
2. **인덱스 준비** — `node "${CLAUDE_PLUGIN_ROOT}/agents/lib/build-index.mjs" --root "[루트]" --check-stale` → exit 1 이면 `--mode incremental`(인덱스 없음이면 `--mode init`). AX-NAVI CLI 는 런타임이 맞추므로 건너뛴다.
3. **impact-analyzer 호출**
   ```
   Agent(subagent_type="ax-navi:impact-analyzer", description="변경 영향도 분석", model="sonnet",
     prompt="<변경 대상: [식별자]. 프로젝트 루트: [절대경로]. (safe-modify 에서) 맥락: _workspace/reports/context_<slug>.md, 규모: small|normal. 출력: _workspace/reports/impact_<slug>.md>")
   ```
   네임스페이스를 지원하지 않는 호스트는 `general-purpose` 로 폴백하고 "`agents/impact-analyzer.md` 의 지침을 읽고 따른다"를 넣는다.
   결과 파일이 없는데 본문을 돌려줬으면 그 본문을 경로에 쓴다. 둘 다 없으면 "대기 없이 이번 턴에 직접 산출하라"를 붙여 1회 다시 부른다.
4. **보고** — 리포트의 결론 · 영향받는 곳 전체 · 위험도를 보여 준다. 단독 호출이면 다음 액션(safe-modify 또는 중단)을 묻고, safe-modify · cross-repo 안에서 불렸으면 묻지 않는다.
