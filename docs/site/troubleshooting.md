# 문제 해결

AX Navi를 쓰다 마주치는 증상을 원인과 조치로 정리했습니다. 대부분은 실행 환경(Node·Python·호스트 기능)이나 인덱스 상태에서 비롯되며, 플러그인은 문제를 조용히 넘기지 않고 WARN이나 exit code로 드러내도록 설계되어 있으므로 먼저 보고 문구를 그대로 찾아보세요. 근거는 `skills/harness-init/SKILL.md` 에러 표, `agents/lib/python-bin.mjs`, `docs/user-guide.md` 7절, `docs/workflows.md` FAQ, README FAQ입니다.

## 설치와 실행 환경

| 증상 | 원인 | 조치 |
|------|------|------|
| `block: index` 반환에 `node: none`, `indexer_rank: 2` 또는 `3` | Node 18 이상이 없어 결정론적 인덱서를 못 씀. 2는 스택별 Python 추출기 폴백(`symbols`·`call_graph`만), 3은 인덱스 없이 analyzer가 전부 작성 | Node 18+ 설치 후 "인덱스만 갱신해줘". `_workspace/00_stack_precheck.json`의 `indexer` 키로 어느 순위로 실행됐는지 확인 |
| "파이썬 없음" WARN, `.py` 블록 스킵 | `python-bin.mjs`가 `python3`·`python`·`py` 순으로 `--version`을 시도했는데 Python 3이 하나도 성공하지 않음. Windows Store 스텁 `python`은 존재해도 실행이 실패해 인정되지 않음 | Python 3 설치 후 PATH 확인. 하드코딩 없이 자동 판정하므로 이름을 맞출 필요는 없음 |
| `validate-harness.mjs` 실행 자체 실패 | node 없음 등 환경 문제 | WARN 후 스키마 검증 없이 `validator_checks.py`·validator Agent만으로 계속 진행됨. Node 설치 후 "validator만 다시 실행" |
| `ai_budget: skipped(node 없음)` | 예산 게이트가 Node 스크립트 | `claim` 호출이 전부 생략되고 무제한 진행됨. 비용 한도가 필요하면 Node 설치 |
| 플러그인 업데이트 후 새 트리거·스킬이 안 보임 | 구성 요소 재로딩 필요 | `/reload-plugins` 실행. `/plugin details ax-navi@ax-navi`로 스킬 24종·에이전트 19종 확인 |
| `claude plugin update`가 새 버전을 잡지 않음 | 버전 문자열로만 판단. 이전 이름 설치본은 버전이 내려가 업데이트가 잡히지 않을 수 있음 | 구 마켓플레이스 제거 → `Malburi/AX-NAVI-V2` 등록 → 재설치([설치](/getting-started/install.md)) |
| 스크립트 경로를 못 찾음 | `agents/lib/...` 상대경로는 개발 저장소에서만 동작 | `$env:CLAUDE_PLUGIN_ROOT`(PowerShell) 또는 `$CLAUDE_PLUGIN_ROOT`(bash)를 쓰고, 비어 있으면 플러그인 설치 루트 절대경로로 대체 |

## 호스트 기능 차이

| 증상 | 원인 | 조치 |
|------|------|------|
| `subagent_type="ax-navi:..."` 호출 실패 | 호스트가 플러그인 네임스페이스 지정을 지원하지 않음 | 스킬이 `general-purpose`로 폴백하고 프롬프트에 "`agents/<이름>.md` 지침을 읽고 따른다"를 명시함. 폴백이면 에이전트 지침을 직접 읽느라 토큰이 늘어남 |
| 초기화 질문이 번호 목록 평문으로 나옴 | `AskUserQuestion` 툴이 없는 호스트 | 자유 텍스트로 번호 응답. 정상 폴백 |
| 작업 6개가 계속 pending으로 보임 | `TaskCreate`/`TaskUpdate`가 없거나 상태 전이 누락 | `_workspace/00_pipeline_status.md` 체크리스트 폴백을 확인 |
| 테스트 러너가 Bash 도구에서 실패 | 저장소 스크립트 예시와 테스트 명령은 PowerShell 기준(`$env:` 표기)으로 작성됨 | `node agents/lib/tests/run.js`처럼 PowerShell에서 실행. bash에서는 `$CLAUDE_PLUGIN_ROOT` 표기로 바꿔서 실행 |

## 인덱스

| 증상 | 원인 | 조치 |
|------|------|------|
| 스킬 리포트에 `지식 모델 stale` WARN | 코드가 인덱스보다 최신이거나 재인덱싱이 실패·생략됨 | `--check-stale` 후 `reason`에 따라 `--mode init`(인덱스 없음·구버전) 또는 `--mode incremental`(소스 변경·버전 변경). 자연어로는 "인덱스만 갱신해줘" |
| `--check-stale`이 `인덱서 버전 변경`을 반환 | 플러그인 업데이트로 `INDEXER_VERSION`이 올라감 | 소스가 그대로여도 `--mode incremental` 1회. `_ai_patch.json`은 재병합됨 |
| 팀원이 pull했는데 `_ai_patch.json`이 없음 | `.gitignore`의 `_workspace/`에 걸려 커밋되지 않음 | `_workspace/index/_ai_patch.json`만 예외로 추적. 이미 잃었으면 wiki-hub DB에 발행돼 있다면 `publish-wiki --pull`로 복원, 아니면 analyzer 재실행 필요 |
| `--pull` 뒤 로컬 인덱스가 옛 것으로 바뀜 | 순서를 check-stale → pull로 실행 | 반드시 pull → `--check-stale` 순서. exit 1이면 `--mode incremental` 1회 |
| `AI patch가 하나도 적용되지 않았습니다` | 패치의 오퍼레이션이 전부 거부됨(없는 노드 참조 등) | 인덱스 자체는 유효. WARN으로 보고되고 계속 진행. `_meta.ai_enrichment`의 `rejected_reasons` 확인 |
| 노드가 수만 개, 데드코드가 거의 전부 | 벤더·미니파이 제외가 꺼져 있거나 `vendor_exclude: false` | `indexer-config.json`에서 키 제거 후 재인덱싱. `_meta.excluded_sources`로 제외 결과 확인 |
| 업무 코드가 인덱스에 없음 | 벤더 디렉터리명·테스트 디렉터리명과 일치하거나 `include_paths` 밖 | `_meta.excluded_sources`의 `by_reason` 확인. 필요하면 `test_exclude: false` 또는 `include_paths` 조정 |
| `schema.json`의 컬럼이 전부 비어 있음 | DDL이 없어 `sql_usage.json`에서 테이블만 유도(`_meta.source: derived-from-sql`) | 정상. 컬럼은 지어내지 않음. DDL 파일을 저장소에 두면 다음 인덱싱에서 DDL 우선 |
| 한글 주석·경로가 `U+FFFD`로 깨짐 | 소스가 EUC-KR인데 인코딩 판정이 실패 | 인덱서는 BOM → 선언 인코딩 → UTF-8 → `euc-kr` 순으로 자동 판정함. `_meta.encoding.guessed`에 든 파일이 잘못 읽힌 후보이므로 확인. `guessed_count`가 0이 아니면 Phase 3 보고에 드러남 |
| EUC-KR 파일을 고친 뒤 인코딩이 바뀌지 않았는지 걱정됨 | 레거시 인코딩(EUC-KR·CP949 등) 파일 | 정상 동작. Read/Edit/Write가 도는 동안만 제자리에서 UTF-8로 바꿨다가 끝나면(실패·거부·세션 종료 포함) 원래 인코딩으로 되돌린다. 바이너리 파일은 대상이 아니다. axnavi CLI와 Claude Code 플러그인(`hooks/hooks.json`) 모두 적용 |
| 수정이 `인코딩 보존 불가`로 거부됨 | 원래 인코딩으로 온전히 되돌릴 수 없는 파일(깨진 바이트, 표에 없는 조합)이거나 32MB 초과 | 읽기는 된다. 원본 글자가 바뀌지 않도록 수정만 막은 것이므로 그 파일은 편집기에서 인코딩을 확인해 직접 고치거나 UTF-8 전환을 팀에서 결정한다 |
| `indexer-config.json`을 PowerShell로 만들었는데 인식이 이상함 | PowerShell JSON 출력에 BOM이 붙음 | 인덱서와 Python 쪽이 모두 BOM을 벗겨 읽으므로 보통 문제 없음. 다른 도구로 열 때만 주의 |

## 스택·어댑터

| 증상 | 원인 | 조치 |
|------|------|------|
| safe-modify가 시작부터 HOLD | 변경 대상 확장자의 어댑터가 `UNSUPPORTED`이거나 `_meta.json`이 없다. `PARTIAL`(`.jsp`·`.xml`·`.cshtml`·`.xfdl`·`.csproj` 등)은 원래 원문을 읽고 진행하므로, 원문을 읽지 않고 멈춘 경우에만 HOLD가 된다 | UNSUPPORTED면 어댑터 추가가 필요. PARTIAL인데 멈췄으면 "원문 읽고 진행해줘"로 다시 요청. `check-adapter-coverage.mjs --target <파일>`로 사유 확인 |
| `_meta.json` 없음으로 HOLD | 인덱싱되지 않았거나 구버전 인덱스 | `build-index.mjs --mode init` |
| Rust·COBOL·ABAP 등에서 코드 변경 자동화가 거부됨 | 분석 깊이 LOW, discovery-only | 의도된 제한. `legacy-decoder`로 구조 파악 후 수동 작업 |

## 모델

| 증상 | 원인 | 조치 |
|------|------|------|
| "모델 미지원" 또는 "다른 모델로 대체됨"으로 중단 | 호스트·조직 allowlist·클라우드 설정에서 `claude-sonnet-5`를 쓸 수 없음 | 의도된 정책. Opus 등으로 자동 폴백하지 않음. 모델 가용성을 확인한 뒤 재실행 |
| 다음 턴에서 메인 모델이 원래대로 돌아옴 | 스킬 frontmatter `model:`은 해당 턴에만 적용 | 세션에서 `/model claude-sonnet-5` 선택 |

## wiki

| 증상 | 원인 | 조치 |
|------|------|------|
| `_workspace/wiki/index.html`을 더블클릭하면 빈 화면 | Docsify는 인터넷 CDN이 필요하고 `file://` 직접 열기를 지원하지 않음 | `serve.bat` 실행 후 `http://localhost:3501`. 오프라인이면 `_workspace/wiki/offline.html`·`_html/*.html` 렌더 사본 또는 `call-graph.html`(데이터 인라인 포함, `file://` 가능) |
| `wiki_quality.json`이 `PARTIAL` | 페이지 생성 실패가 아니라 분석 누락이 있음 | 누락 목록을 근거로 필요한 업무만 추가 분석. 전체 harness-init 재실행은 하지 않음 |
| wiki가 코드 변경을 반영하지 않음 | wiki는 산출물의 뷰라 재생성해야 갱신됨. 직접 편집한 내용은 다음 생성 때 덮어씌워짐 | `safe-modify` GO 이후에는 자동 재생성. 그 외에는 "위키 만들어줘" |
| 발행 시 `SQLAlchemy` 없음 | DB 저장에 `sqlalchemy` + 엔진 드라이버가 필요 | `pip install sqlalchemy pymssql`(MSSQL 기준, PostgreSQL은 `psycopg2-binary`, Oracle은 `oracledb`). SQLite는 추가 설치 불필요 |

## 초기화 파이프라인

| 증상 | 원인 | 조치 |
|------|------|------|
| "CLAUDE.md 미생성 — writer 재실행 필요" | writer가 `claude_md_fields.json`을 만들지 않음 | 다른 항목은 계속 배포됨. "스킬만 다시 생성" 또는 "하네스 업데이트해줘" |
| "writer 재실행 필요", 패턴 스켈레톤 없음 | `writer_decisions.json` 미생성 | 조건부 스킬·패턴·`02_writer_files.md` 조립이 전부 스킵됨. writer 재실행 |
| `PROFILE_FAIL` 2회차, 파이프라인 FAIL | 패턴 프로필이 검증을 두 번 통과하지 못함 | 프로필을 사용 가능으로 표시하지 않음. `pattern_profile_validation.json`의 `profile_missing` 확인 후 "패턴 다시 추출해줘" |
| 경계 QA를 골랐는데 "구조 검증 실패로 미실행" | validator 신뢰도 < 50 | validator 권고를 먼저 처리한 뒤 "경계 QA 실행해줘" |
| `AI 예산 claim 실패(exit 1)`로 레인 중단 | 역할당 initial 1회·시간·토큰 한도 소진 | 의도된 하드 스톱. 견적을 크게 벗어난 상황을 잡기 위한 것이므로 원인(대형 저장소·범위) 확인 후 Standard로 재시도 또는 `include_paths` 축소 |
| "플러그인 인덱스 계약 결함" | `validator_schema.json`의 `plugin_contract_failures > 0`. `build-index.mjs`나 스키마 파일 자체 결함 | AI 재시도 대상이 아님. 플러그인 이슈로 보고 |
| CLAUDE.md 변경 이력이 1행으로 리셋됨 | 기존 표가 손상돼 `skills_builder.py`가 파싱 실패 | stderr의 `WARN: ... '## 변경 이력' 표를 파싱하지 못해 ...` 확인 후 `.claude/backup/[시각]/`에서 복원 |
| 파트너 경로 없음 | pair-init에 입력한 절대경로가 존재하지 않음 | 재입력 요청이 뜸. 1:N에서는 그 클라이언트만 건너뛰고 나머지 진행 |
| 파트너에 하네스가 없음 | 파트너 `CLAUDE.md` 부재 | standalone pair-init에서는 자동 생성·하네스 없이 진행(드리프트 검증 스킵)·중단 3지선다 |

## 그래도 안 될 때

- 보고에 나온 `_workspace/` 파일을 직접 열어 어느 단계의 산출물이 비었는지 확인하세요. 파일별 의미는 [_workspace 파일 사전](/reference/workspace-files.md)에 있습니다.
- 자동 수정은 없습니다. 보안 위험·DEAD/ORPHAN·HOLD/STOP은 사람이 결정합니다.
- 재초기화 전 백업은 `.claude/backup/[YYYYMMDD-HHMMSS]/`, 이전 산출물은 `_workspace_prev/`에 있습니다.

## 관련 문서

- [설치](/getting-started/install.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [인덱서 설정](/configuration/indexer-config.md)
- [모델 정책](/configuration/model-policy.md)
- [지원 스택 매트릭스](/reference/stack-matrix.md)
- [FAQ](/faq.md)
