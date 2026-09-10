# AX Navi

AX Navi는 ITO/SI 조직을 위한 Claude Code 플러그인이다. 낯선 레거시 코드베이스를 스크립트로 전수 인덱싱해 지도를 만들고, 그 지도 위에서 영향 분석·안전 변경·신규 기능·마이그레이션 계획·SQL 리뷰·레거시 해석을 19개 에이전트와 17개 워크플로우 스킬로 수행한다. 추측 대신 근거를 남기는 것이 설계 원칙이다.

<div class="home-grid">
  <a class="home-card" href="#/getting-started/install">
    <span class="eyebrow">시작하기</span>
    <strong>설치부터 첫 초기화까지</strong>
    <span class="desc">마켓플레이스 등록 두 줄, 초기화 질문 두 개로 하네스가 만들어진다.</span>
  </a>
  <a class="home-card" href="#/concepts/deterministic-index">
    <span class="eyebrow">핵심 개념</span>
    <strong>결정론적 인덱스와 게이트</strong>
    <span class="desc">LLM이 아니라 스크립트가 호출 그래프·SQL·트랜잭션을 전수 추출하고, 판정은 근거 파일을 요구한다.</span>
  </a>
  <a class="home-card" href="#/skills/safe-modify">
    <span class="eyebrow">워크플로우 스킬</span>
    <strong>17개 스킬과 별칭 7종</strong>
    <span class="desc">영향 분석에서 크로스 리포 수정까지, 각 스킬의 트리거 문구·실행 흐름·산출물.</span>
  </a>
  <a class="home-card" href="#/tutorials/onboarding-day1">
    <span class="eyebrow">튜토리얼</span>
    <strong>SM 현장 시나리오 10개</strong>
    <span class="desc">투입 첫날, 운영 핫픽스, DB 컬럼 추가, 마이그레이션 착수, 인수인계.</span>
  </a>
</div>

## 무엇이 다른가

| 관점 | 일반적인 AI 코딩 도우미 | AX Navi |
|---|---|---|
| 코드베이스 이해 | 사람이 파일을 골라 보여 주고 LLM이 요약한다 | 스크립트가 전수 파싱해 심볼·호출 그래프·SQL 사용처·트랜잭션·외부 통신·데드 코드를 인덱스로 남긴다 |
| 컨벤션 | 사람이 규칙 문서를 쓴다 | 코드에서 추출한 패턴 프로필이 근거 파일을 가리키고, 근거 없는 프로필은 검증에서 떨어진다 |
| 변경 안전 | 승인 대화상자 | 영향 분석 → 패턴 적합성 → 실행 증거 → GO/HOLD/STOP 판정, 자동 수정 없음 |
| 분리 저장소 | 멀티루트 워크스페이스 | 백엔드·프론트엔드 API 계약을 추출해 드리프트를 검증하고 양쪽에 동시 반영한다 |
| 문서 | 요약 문서 생성 | 인덱스에서 LLM 없이 wiki를 렌더한다. 인터랙티브 호출 그래프와 붙여넣기용 Mermaid 마크업을 함께 낸다 |

## 한 번의 초기화, 이후의 모든 작업

```mermaid
flowchart LR
    A["인덱싱 (스크립트, LLM 0회)"] --> B["analyzer 해석"]
    B --> C["writer 생성"]
    C --> D["조립 (스크립트)"]
    D --> E["pattern-extractor"]
    E --> F["validator"]
    F --> G["harness-evaluator"]
    G --> H["CLAUDE.md · 로컬 스킬 · 패턴 · 인덱스"]
```

초기화가 끝나면 이후 작업은 인덱스를 재사용한다. 기능 위치 탐색은 수천 토큰, 영향 분석은 만 토큰 안에서 끝나며 코드를 다시 훑지 않는다. 비용 구조는 [Tier와 토큰 비용](/getting-started/tier-and-cost.md)에 있다.

## 첫 명령

프로젝트 루트에서 Claude Code를 열고 이렇게 요청한다.

```text
하네스 초기화해줘
```

질문 두 개에 답하면 된다. 어떤 분석 깊이로 할지(Tier), 그리고 저장소 구성이 단일·모노레포·분리 저장소 중 어느 쪽인지다. 이후에는 아래 문구가 바로 동작한다.

```text
/find 주문 취소
/flow POST /orders/{id}/cancel
/impact OrderService.cancel
/modify 취소 사유 필수값으로 바꿔줘
```

## 이 문서의 구성

- **시작하기**는 설치, 빠른 시작, 첫 초기화의 단계별 화면, 비용, 모범 사례를 다룬다.
- **핵심 개념**은 하네스가 만드는 파일, 인덱스, 패턴 프로필, 에이전트 팀, 판정 체계를 설명한다.
- **워크플로우 스킬**과 **에이전트**는 구성 요소별 레퍼런스다. 트리거 문구, 실행 흐름, 입력과 산출물, 원칙을 같은 형식으로 적었다.
- **설정**은 인덱서 옵션, 모델 정책, 도구 제한, 인덱스 갱신, 분리 저장소 연결을 다룬다.
- **튜토리얼**은 SM 현장의 상황별 절차다.
- **레퍼런스**는 인덱스 스펙, 스택 매트릭스, 파일 사전, 트리거 전체 표, 용어집이다.

## 플러그인 정보

| 항목 | 값 |
|---|---|
| 플러그인 이름 | `ax-navi` |
| 저장소 | Malburi/AX-NAVI-V2 |
| 구성 | 에이전트 19개, 워크플로우 스킬 17개, 단축 별칭 7개 |
| 요구 사항 | Claude Code, Node 18 이상, Python 3 |
| 라이선스 | MIT |

변경 이력은 저장소의 `docs/changelog.md`에 있다.
