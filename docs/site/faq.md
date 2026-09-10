# 자주 묻는 질문

설치부터 크로스 리포 연동까지 자주 나오는 질문을 카테고리별로 모았습니다. 답은 `docs/workflows.md` FAQ, README FAQ, `docs/user-guide.md` 팁, 각 SKILL.md에서 가져왔으며, 증상 중심의 해결은 [문제 해결](/troubleshooting.md)에 따로 있습니다.

## 설치

**Q. 설치 확인은 어떻게 하나요?**

`/plugin list`에 `ax-navi@ax-navi — enabled`가 보이면 완료입니다. `/plugin details ax-navi@ax-navi`로 스킬 24종(워크플로우 17 + 별칭 7)과 에이전트 19종을 확인할 수 있고, 설치 결과가 재로딩을 요구할 때만 `/reload-plugins`를 실행합니다.

**Q. 예전 `Malburi/AX-NAVI` 등록이 남아 있어요.**

`claude plugin uninstall ax-navi@ax-navi --scope user` → `claude plugin marketplace remove ax-navi` → `claude plugin marketplace add Malburi/AX-NAVI-V2` → `claude plugin install ax-navi@ax-navi --scope user` 순서로 전환합니다.

**Q. Node나 Python이 꼭 필요한가요?**

결정론적 인덱서는 Node 18 이상이 필요합니다. 없으면 스택별 Python 추출기가 `symbols`·`call_graph`만 만들고, 그것도 안 되면 analyzer가 인덱스를 전부 작성해 LLM 비용이 커집니다. Python은 조립·검증·wiki 스크립트에 쓰이며 `python3`·`python`·`py` 중 실제로 실행되는 이름을 자동으로 찾습니다.

## 초기화

**Q. 초기화 질문이 많아요. 바로 시작하고 싶어요.**

"빠르게 하네스 초기화해줘"처럼 "빠르게"를 붙이면 Standard로 확정되고 Tier 질문이 생략됩니다. 요청문에 구성과 경로를 이미 명시했으면 구성 질문도 건너뜁니다.

**Q. Standard와 Full은 무엇이 다른가요?**

분석 범위만 다릅니다. Standard는 analyzer가 스택 해당 Phase B만 수행하고 데드코드 탐지를 생략하며, Full은 전체를 수행합니다. 모델은 둘 다 `claude-sonnet-5`이고 wiki·QA는 어느 쪽도 자동 실행하지 않습니다. 기본은 Full이며, 인덱싱 직후 실제 견적을 보고 Standard로 낮추거나 중단할 수 있습니다.

**Q. 비용을 미리 알 수 있나요?**

인덱싱(LLM 없음, 수십 초)이 끝나면 `ai-budget.mjs estimate`가 예상 토큰·분·판정 대상 미해결 관계 수를 보여줍니다. 이 시점이 되돌릴 수 있는 유일한 지점이며, "여기서 중단"을 고르면 인덱스만 남아 `analyze-impact`·`trace-logic`은 바로 쓸 수 있습니다.

**Q. 품질 점수(Eval)가 낮으면 어떻게 되나요?**

80점 미만이면 낮은 차원(커버리지·정확도·실행가능성·컨텍스트 품질)에 해당하는 에이전트만 타겟 재생성하고 1회 재평가합니다. 재생성 후 점수가 오히려 낮아지면 초기 결과를 유지하고 두 점수를 모두 보고합니다. 2차 평가 뒤에는 점수와 무관하게 종료되어 무한 루프가 없습니다.

**Q. 특정 부분만 다시 만들고 싶어요.**

"스킬만 다시 생성해줘", "패턴만 다시 추출해줘", "validator만 다시 실행해줘", "에이전트만 다시 생성"이 부분 재실행 문구입니다. 이전 `_workspace/` 산출물을 재사용하고 Tier도 다시 묻지 않습니다.

**Q. 초기화 후 어떻게 쓰는지 모르겠어요.**

`.claude/ito-guide.md`가 이 프로젝트에 맞는 트리거 예시·시나리오·주의사항을 담고 있습니다. "ito-guide 보여줘"로 확인하세요.

**Q. spec-gate는 언제 쓰나요?**

harness-init은 spec-gate를 자동 호출하지 않습니다. 큰 작업 전에 목적·범위·제약을 정리하고 싶을 때 "작업 범위 정해줘"로 먼저 호출합니다. 모호성 점수 ≤0.2면 GO, 0.21~0.4면 1회 재질문, 그 이상이어도 강제로 멈추지 않습니다.

## 비용과 유지

**Q. 하네스를 한 번 만들면 코드가 바뀌었을 때는?**

"인덱스만 갱신해줘"로 LLM 분석 없이 인덱스를 다시 만들고 기존 AI 보강(`_ai_patch.json`)을 재적용합니다. CLAUDE.md 내용까지 낡았으면 "하네스 업데이트해줘", 구조가 통째로 바뀌었으면 "하네스 다시 초기화해줘"입니다.

**Q. 인덱스가 stale인지 어떻게 알 수 있나요?**

`analyze-impact`·`safe-modify`·`trace-logic`·`find-feature`가 시작 시 `--check-stale`을 실행해 알려줍니다. 직접 확인하려면 `node "$env:CLAUDE_PLUGIN_ROOT/agents/lib/build-index.mjs" --root "<루트>" --check-stale`을 실행하세요. exit 0이면 최신입니다.

**Q. 팀원마다 초기화를 다시 해야 하나요?**

아닙니다. `CLAUDE.md`·`.claude/`·`_workspace/index/_ai_patch.json`을 커밋해 두면 팀원은 `--check-stale`만 실행하고, 필요할 때 인덱싱 한 번(LLM 없음)으로 끝납니다. 인덱스 자체를 커밋할지는 팀이 정합니다.

**Q. `_workspace/` 폴더가 너무 커요.**

분석이 끝난 뒤 지워도 되지만 `_workspace/index/`는 영향 분석·안전 변경 속도에 직접 영향을 주므로 남겨두는 편이 좋습니다. `_ai_patch.json`은 LLM 산출물이라 지우면 analyzer를 다시 돌려야 합니다.

**Q. 하네스 없이 그냥 쓰는 것보다 언제 이득인가요?**

문서 기준 손익분기점은 Standard 약 7회, Full 약 8회 작업입니다. 일회성 소규모 작업이면 미사용도 합리적이고, 유지보수가 이어지거나 레거시 전환·대형 SI면 Full이 유리합니다.

## 안전과 판정

**Q. analyze-impact와 safe-modify의 차이는?**

`analyze-impact`는 읽기 전용이고 변경은 하지 않습니다. `safe-modify`는 사전 영향 분석부터 적용·사후 안전성 판정까지 한 번에 진행하며, 작은 수정은 `safe-modify`만 써도 됩니다.

**Q. GO / HOLD / STOP이 나왔는데 어떻게 하나요?**

GO는 진행해도 안전, HOLD는 주의 후 결정, STOP은 현재 방식 중단 권고입니다. GO는 pattern-conformance `CONFORM`, 필수 테스트·빌드·린트 exit 0, change-safety `GO`가 모두 충족될 때만 나오고 검증 미실행은 HOLD입니다. Claude는 HOLD/STOP에서도 자동 수정하지 않으며 판정을 우회하는 방법은 제공하지 않습니다.

**Q. 자동 수정은 안 하나요?**

보안 위험·DEAD/ORPHAN 같은 위험 항목은 권고만 합니다. `safe-modify`의 변경 적용도 사용자가 진행 의사를 명시한 경우에만 합니다.

**Q. "그냥 고쳐줘"라고 하면 게이트를 건너뛰나요?**

"수정해줘"·"고쳐줘"는 기본적으로 `safe-modify`를 탑니다. 게이트를 생략하려면 "알아서 해줘"·"바이브로"처럼 vibe 문구를 명시해야 하고, vibe도 패턴 선택과 최소 실행 검증은 유지합니다. DB 스키마·외부 API 계약·트랜잭션 경계 변경이나 3개 이상 파일 수정은 vibe에서 자동 승격됩니다.

**Q. 운영 DB에 접속하나요?**

요청하지 않습니다. 스키마는 DDL 파일에서 파싱하거나, DDL이 없으면 SQL 사용처에서 테이블만 유도합니다. read-only 계정과 접속 정보를 직접 제공한 경우에만 접속합니다.

**Q. legacy-decoder 결과는 믿을 수 있나요?**

코드에서 직접 읽힌 것(변수 흐름·사이드 이펙트)은 신뢰할 수 있고, 비즈니스 의도 추정은 `[추정]` 표시가 붙으므로 사람 확인이 필요합니다.

**Q. 마이그레이션 도중에도 일반 작업을 할 수 있나요?**

가능합니다. `plan-migration`은 계획만 만들고 코드는 그대로 둡니다. 변환은 모듈 단위로 `safe-modify`·`scaffold-feature`를 조합하고, 일반 버그 수정은 대상 모듈 충돌만 주의하면 병행할 수 있습니다.

## wiki

**Q. wiki는 자동으로 만들어지나요?**

아닙니다. harness-init 완료 후 선택 메뉴에서 고를 때만 실행되고, 컨텍스트가 큰 초기화 세션보다 새 세션에서 "위키 만들어줘"로 따로 돌리는 편이 같은 결과를 더 싸게 얻습니다. `safe-modify`·`scaffold-feature`가 GO로 끝나면 자동으로 재생성됩니다.

**Q. wiki를 열려면 서버가 필요한가요?**

Docsify 페이지는 `serve.bat` 실행 후 `http://localhost:3501`로 열며 인터넷 CDN이 필요합니다. `call-graph.html`은 데이터를 인라인으로 포함해 `file://`로 바로 열리고, `_html/*.html`·`offline.html`은 서버 없는 열람용 렌더 사본입니다.

**Q. wiki 내용을 직접 고쳐도 되나요?**

wiki는 `_workspace/`·`.claude/` 산출물의 뷰라 다음 생성 때 덮어씌워집니다. 고칠 내용이 있으면 원본 산출물이나 코드를 고치고 재생성하세요.

**Q. wiki-hub는 반드시 설치해야 하나요?**

아닙니다. 폴더 wiki만으로 대부분 충분하고, 여러 시스템을 버전 관리와 함께 한 곳에서 보고 싶을 때 `publish-wiki`로 DB에 발행합니다. 발행은 플러그인에 내장된 `wikihub_db/`가 하므로 wiki-hub 프로젝트 설치 없이 `sqlalchemy`와 엔진 드라이버만 있으면 됩니다.

## 크로스 리포

**Q. 백엔드와 프론트엔드가 저장소가 나뉘어 있어요.**

`pair-init`으로 연결하면 API 계약을 추출해 드리프트를 검증하고 `cross-repo-scaffold`·`cross-repo-modify`로 양쪽에 동시에 반영합니다. 백엔드 1개에 클라이언트 여러 개인 허브형(1:N)도 지원합니다.

**Q. harness-init 때 연동을 안 했는데 나중에 추가할 수 있나요?**

가능합니다. 양쪽에 하네스가 있으면 "백엔드 프론트엔드 연결해줘"로 pair-init을 직접 호출합니다. 파트너에 하네스가 없으면 자동 생성·하네스 없이 진행·중단 중에서 고릅니다.

**Q. 클라이언트를 하나 더 붙이려면?**

"[새 역할] 클라이언트 추가해줘"로 pair-init을 재실행하면 기존 목록은 그대로 두고 `## Partner:` 블록 하나만 추가됩니다.

**Q. API 드리프트를 다시 확인하려면?**

"API 드리프트 확인해줘"로 pair-init을 재실행합니다. 결과는 각 클라이언트의 `_workspace/reports/api_drift_report.md`에 개별 저장됩니다.

## 관련 문서

- [문제 해결](/troubleshooting.md)
- [10분 빠른 시작](/getting-started/quickstart.md)
- [Tier와 토큰 비용](/getting-started/tier-and-cost.md)
- [판정과 게이트](/concepts/gates.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [크로스 리포 설정](/configuration/pair-config.md)
- [트리거 문구 전체 표](/reference/triggers.md)
