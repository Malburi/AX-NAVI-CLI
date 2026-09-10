# 별칭 스킬 (aliases)

AX Navi에는 워크플로우 스킬 17개 외에 단축 호출용 별칭 스킬 7개가 들어 있다. 별칭은 `/modify 주문 취소 버튼 오류 고쳐줘`처럼 짧은 슬래시 명령으로 본편 스킬을 부르기 위한 것이며, 자기 절차를 갖지 않는다. 호출되면 즉시 Skill 도구로 본편을 호출하고 사용자가 별칭 뒤에 쓴 내용 전부를 args로 그대로 넘긴다.

## 별칭 7종

| 별칭 | 본편 | 본편이 하는 일 (description 인용) | 호출 예 |
|------|------|-------------------------------|---------|
| `/modify` | [safe-modify](/skills/safe-modify.md) | "사전 영향 분석→적용→사후 안전성 평가" | `/modify 주문 취소 버튼 오류 고쳐줘` |
| `/impact` | [analyze-impact](/skills/analyze-impact.md) | "변경 대상의 직간접 영향·위험도 분석" | `/impact ORDER 테이블에 STATUS 컬럼 추가` |
| `/scaffold` | [scaffold-feature](/skills/scaffold-feature.md) | "프로젝트 컨벤션 기반 신규 기능 스캐폴딩" | `/scaffold 주문 취소 기능` |
| `/find` | [find-feature](/skills/find-feature.md) | "관련 파일·클래스·메서드·SQL 목록 반환" | `/find 결제 승인 처리` |
| `/flow` | [trace-logic](/skills/trace-logic.md) | "진입점부터 DB/외부 시스템까지 흐름 추적" | `/flow 로그인 처리` |
| `/sql` | [review-sql](/skills/review-sql.md) | "사용처·성능·보안·트랜잭션·스키마 영향 종합 리뷰" | `/sql SELECT * FROM ORDERS WHERE STATUS = 'N'` |
| `/wiki` | [generate-wiki](/skills/generate-wiki.md) | "하네스 산출물 기반 위키 페이지 세트 생성, call graph 시각화 포함" | `/wiki` |

각 별칭 SKILL.md의 본문은 한 문단이다. 예를 들어 `/modify`는 다음과 같이 동작한다.

```text
/modify 주문 취소 버튼 오류 고쳐줘
  → Skill(skill="ax-navi:safe-modify", args="주문 취소 버튼 오류 고쳐줘")
```

`/wiki`는 args가 비어 있어도 된다. generate-wiki가 페이지 범위를 발견된 데이터로 자동 결정하기 때문이다. "해설 포함"처럼 옵션 문구를 붙이면 그대로 본편에 전달된다.

## 언제 쓰는가

별칭은 슬래시 입력 전용이다. 자연어 트리거는 본편이 이미 갖고 있으므로 "결제 흐름 보여줘"라고 말하면 별칭을 거치지 않고 trace-logic이 바로 실행된다. 별칭이 유용한 경우는 다음과 같다.

| 상황 | 별칭 사용 이유 |
|------|--------------|
| 짧게 치고 싶을 때 | `/ax-navi:safe-modify`보다 `/modify`가 짧다 |
| 라우팅을 확정하고 싶을 때 | "고쳐줘"가 safe-modify로 갈지 vibe로 갈지 애매할 때 `/modify`로 못 박는다 |
| 명령형으로 일괄 작업할 때 | `/impact`, `/sql`처럼 대상만 바꿔 반복 호출 |

자연어 축약형과의 관계도 정리해 둔다. "찾아 [대상]", "찾기 [대상]"은 find-feature의 description에 직접 등록된 트리거라 `/find`를 거치지 않고 바로 라우팅된다. 자연어를 `/find`로 우회시키면 위임 홉만 늘고 결과는 같다. bare "찾아줘"는 대상어가 없거나 버그·수정 맥락이면 safe-modify 성격일 수 있어 하드 트리거로 고정하지 않는다.

`/modify` 별칭에는 "modify로 고쳐줘" 같은 자연어 표현도 트리거로 적혀 있다. 나머지 6개 별칭의 description은 슬래시 형식만 언급한다.

## 왜 /trace가 아니라 /flow인가

trace-logic의 별칭 이름은 `/flow`다. `/trace`가 더 직관적이지만 쓸 수 없는 이유가 있다. harness-init이 대상 프로젝트마다 로컬 스킬 `.claude/skills/trace.md`를 배포하기 때문이다. 플러그인 전역 스킬 `trace`와 프로젝트 로컬 스킬 `trace`가 같은 이름으로 공존하면 어느 쪽이 실행될지 모호해진다. flow SKILL.md의 description은 이를 "하네스가 프로젝트마다 로컬 trace 스킬을 배포하므로 이름 충돌 방지"라고 적고 있다.

같은 이유로 `/scaffold`는 로컬 스킬 `scaffolder.md`와, `/find`는 로컬 스킬 `find-logic.md`와 이름이 다르다. 셋 다 로컬 스킬과 겹치지 않는 이름을 골랐다.

## 별칭은 얇은 위임층이다

별칭 SKILL.md는 절차를 재정의하지 않는다. 각 파일에 "이 파일에서 절차를 재정의하지 않는다 — 절차는 전적으로 본편을 따른다"는 문장이 있다. 따라서 다음이 성립한다.

| 항목 | 별칭 | 본편 |
|------|------|------|
| Phase·게이트·판정 | 없음 | 전부 본편이 정의 |
| 산출물 파일 | 없음 | 본편이 `_workspace/reports/` 등에 기록 |
| 사용자 질문 | 없음 | 본편의 Phase 0 확인 질문이 그대로 나옴 |
| 동작 차이 | 없음 | `/modify X`와 "X 안전하게 적용해줘"는 같은 safe-modify 실행 |

별칭 문서가 본편과 다른 내용을 담고 있다면 그것은 오류다. 절차·옵션·산출물은 항상 본편 페이지를 기준으로 본다.

## 로컬 스킬 3종과 전역 스킬의 관계

harness-init은 대상 프로젝트의 `.claude/skills/`에 로컬 스킬 세 개를 만든다. 이 파일들은 writer 에이전트가 프로젝트별로 직접 작성하며, 트리거에 한국어 3개 이상·영어 2개 이상·스택 키워드 1개 이상을 넣는 규칙을 따른다. 내용이 프로젝트마다 다르기 때문에 템플릿으로 조립하지 않고 LLM이 쓴다.

| 로컬 스킬 (프로젝트 `.claude/skills/`) | 성격 | 가장 가까운 전역 스킬 | 차이 |
|--------------------------------------|------|---------------------|------|
| `trace.md` | 이 프로젝트의 스택·레이어 이름으로 쓴 처리 흐름 추적 안내 | trace-logic (`/flow`) | 전역은 logic-tracer 에이전트와 인덱스를 호출하는 오케스트레이터 |
| `scaffolder.md` | 어떤 파일을 만들어야 하는지 체크리스트만 보여줌 | scaffold-feature (`/scaffold`) | 전역은 실제 파일 생성 + 테스트 골격 + 사전 영향 체크 |
| `find-logic.md` | 이 프로젝트의 패키지·모듈 기준 코드 위치 탐색 안내 | find-feature (`/find`) | 전역은 feature-finder 에이전트와 `symbols.json` 인덱스를 호출 |

전역 스킬 중 `analyze-impact`, `safe-modify`, `scaffold-feature`, `vibe`는 로컬 파일이 없다. harness-init은 이 네 개를 "가용성 판단 목록"으로만 취급해 이름을 `CLAUDE.md`와 ito-guide에 반영하고 파일은 만들지 않는다. `plan-migration`, `review-sql`은 프로젝트 조건에 따라 가용 여부만 결정된다. 그래서 `git add .claude/`로 커밋할 대상은 로컬 스킬 3종과 패턴 파일, domain-expert.md이며 전역 스킬은 커밋 대상 자체가 없다.

## 예시

```text
사용자: /impact OrderService.cancel

Claude: (impact 별칭이 ax-navi:analyze-impact 로 위임, args="OrderService.cancel")
        인덱스 신선도를 확인하고 impact-analyzer 를 호출합니다.

        영향도 분석 결과 — OrderService.cancel
        위험도는 MEDIUM (6/10) 이며 직접 영향 3건, 간접 영향 5건입니다.
        리포트는 _workspace/reports/impact_orderservice_cancel.md 에 있습니다.
```

```text
사용자: /flow 결제 승인

Claude: (flow 별칭이 ax-navi:trace-logic 으로 위임, args="결제 승인")
        어떤 진입점부터 볼까요? PaymentController.approve() 와 배치 PaymentApprovalJob 두 곳이 후보입니다.

사용자: 컨트롤러

Claude: logic-tracer 를 호출합니다. 결과는 _workspace/reports/trace_payment_approve.md 에 저장됩니다.
```

## 원칙과 주의

- 별칭은 절차를 갖지 않는다. 동작이 궁금하면 본편 페이지를 읽는다.
- 별칭 뒤의 텍스트는 가공 없이 본편에 전달된다. 본편이 이해할 수 있는 형태로 쓴다.
- `/trace`, `/scaffolder`, `/find-logic`은 전역 별칭이 아니다. 대상 프로젝트에 하네스가 있으면 로컬 스킬이 그 이름으로 응답할 수 있다.
- 로컬 스킬은 프로젝트마다 내용이 다르다. 다른 프로젝트의 `.claude/skills/trace.md`를 복사해 쓰지 않는다.
- 사용자 설명서 기준 설치 확인 개수는 스킬 24개(워크플로우 17 + 별칭 7)와 에이전트 19개다. `/plugin details ax-navi@ax-navi`로 확인한다.

## 관련 문서

- [trace-logic](/skills/trace-logic.md)
- [find-feature](/skills/find-feature.md)
- [generate-wiki](/skills/generate-wiki.md)
- [트리거 레퍼런스](/reference/triggers.md)
- [하네스 산출물](/concepts/harness-outputs.md)
