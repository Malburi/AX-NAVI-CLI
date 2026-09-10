# generate-wiki

harness 산출물(`_workspace/` + `.claude/`)을 기반으로 프로젝트 wiki 페이지 세트를 생성하는 스킬이다. 본체는 `wiki_generator.py`라는 zero-LLM 스크립트로, 산출물을 그대로 복사·집계하고 구조화 JSON(`api_contract.json`, `schema.json`, `external_io.json`, `pattern_profile.json` 등)을 표로 바꾼다. `call_graph.json`은 vis-network 기반의 인터랙티브 HTML(`call-graph.html`)로 변환된다. 생성이 끝나면 별도 프로젝트 wiki-hub로 발행할지 선택 질문이 한 번 나온다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 생성 | "wiki 만들어줘", "wiki 생성", "문서 wiki", "프로젝트 wiki 생성", "위키 만들어줘" |
| 갱신 | "위키 업데이트" |
| 그래프 | "call graph 시각화", "호출 그래프 wiki" |
| 영어 | "generate wiki" |

호출 방법은 세 가지다.

| 방법 | 입력 |
|------|------|
| 자연어 | 위 트리거 문구 중 하나를 포함해 요청 |
| 슬래시 | `/ax-navi:generate-wiki` |
| 별칭 | `/wiki` (generate-wiki로 그대로 위임) |

자동 실행 조건도 정리해 둔다. harness-init 완료 후에는 자동 실행되지 않으며 Phase 3.6 선택 작업 메뉴에서 사용자가 고를 때만 실행된다(2026-08-16 자동 실행 해제, 토큰 절감). 반대로 safe-modify Phase 5, vibe의 wiki 최신성 유지, cross-repo-scaffold·cross-repo-modify의 GO 판정 뒤에는 이미 있는 wiki를 최신화하기 위해 후속 호출된다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 사전 확인 | harness 존재 확인, 기존 wiki 감지 | 없음 | 기존 `_workspace/wiki/`가 있으면 덮어쓰기 Y/N |
| Phase 2 생성 | 페이지·사이드바·call-graph.html·`_html/` 사본을 한 번에 생성 | `wiki_generator.py` (zero-LLM) | 없음. "해설 포함"을 요청한 경우만 내러티브 페이지 추가 |
| Phase 3 결과 보고 | `07_wiki_build.md`·`wiki_quality.json`을 읽어 요약 | 없음 | PARTIAL이면 누락 항목 확인 |
| Phase 3.5 허브 발행 확인 | 중앙 DB 발행 여부를 묻고 Y면 publish-wiki로 이어감 | [publish-wiki](/skills/publish-wiki.md) | Y/N 응답 |

SKILL.md에는 Phase 1 번호가 없고 Phase 0에서 Phase 2로 바로 이어진다.

Phase 0의 확인 항목은 두 가지다.

| 확인 대상 | 없을 경우 |
|----------|----------|
| `_workspace/01_analyzer_report.md` | "harness-init을 먼저 실행해주세요" 안내 후 중단 |
| `CLAUDE.md` | 경고만 표시하고 계속 진행 |

기존 wiki가 있으면 Y/N을 묻는다. Y면 `_workspace/wiki/`를 `_workspace/wiki_prev/`로 백업한 뒤 재생성하고, N이면 중단한다. 백업은 1세대만 유지하며 기존 `wiki_prev/`는 삭제 후 교체된다. 다른 스킬의 후속 갱신 호출(safe-modify Phase 5, vibe 등)에서는 이 질문을 생략하고 곧바로 백업·재생성한다.

Phase 2의 실행 명령은 하나다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wiki_generator.py" --root "[절대경로]" --wiki-dir "[절대경로]/_workspace/wiki"
```

저장 위치는 항상 `_workspace/wiki/`이며 묻지 않는다. `_workspace/pair_config.md`가 있으면 파트너의 `call_graph.json`·`01_analyzer_report.md`·`api_contract.json`·`schema.json`·`external_io.json`을 함께 읽어 architecture·api-endpoints·database·external-systems 4개 페이지와 call-graph.html에 자동 병합한다. 별도 인자는 없다. harness-init 파이프라인 안에서는 이 명령을 [pipeline-runner](/agents/pipeline-runner.md)의 `block: wiki`가 대신 실행하며, 허브 발행 질문은 블록이 아니라 오케스트레이터의 몫이다.

선택 항목으로 AI 해설 페이지가 있다. 사용자가 "해설 포함"·"내러티브 포함"을 요청한 경우에만 `_workspace/01_analyzer_report.md`만 읽어 `_workspace/wiki/overview.md`를 쓰고 `docsify_convert.py`로 사이드바를 재조립한다. wiki 본문은 zero-LLM이 원칙이고 이 페이지만 유일한 예외다(약 5~10K 토큰). `_html/` 사본에는 포함되지 않고, 파트너 연동 wiki에서는 사이드바의 병합 앵커를 잃으므로 건너뛴다.

## 입력과 산출물

읽는 파일은 harness 산출물 전부다.

| 경로 | 용도 |
|------|------|
| `_workspace/01_analyzer_report.md` | domain·Home 페이지의 업무 개요·업무별 흐름·업무 규칙 |
| `_workspace/index/*.json` | call_graph·schema·api_contract·external_io·sql_usage 등 구조화 데이터 |
| `.claude/patterns/pattern_profile.json`, `.claude/patterns/*.md` | patterns 페이지의 preferred/legacy/anti-pattern 상태와 기준 파일 |
| `.claude/skills/*.md`, `CLAUDE.md` | workflows·support-status 페이지 |
| `_workspace/pair_config.md` (있을 때) | 파트너 저장소 산출물 병합 |

생성되는 페이지는 발견된 데이터에 따라 자동 결정된다.

| 페이지 | 섹션 | 내용 |
|--------|------|------|
| `Home.md` | 홈 | 프로젝트 개요와 진입 링크 |
| `domain.md` | 시스템 개요 | analyzer의 업무 개요 우선, 구형 리포트는 기술 개요 폴백 표시 |
| `business-flows.md` | 시스템 개요 | API별 실제 호출 관계·SQL·읽기/쓰기 테이블과 미확인 규칙 |
| `architecture.md` | 시스템 개요 | 레이어 구조. 파트너 병합 대상 |
| `workflows.md` | AI 도구 | 사용 가능한 AI 워크플로우 스킬 |
| `support-status.md` | AI 도구 | 유지보수 지원 현황 |
| `database.md` | 데이터 | 스키마 표. 파트너 병합 대상 |
| `external-systems.md` | 데이터 | 외부 시스템 연동. 파트너 병합 대상 |
| `diagrams.md` | 데이터 | schema·api_contract·data_flow·external_io를 Mermaid 마크업으로 변환한 문서 붙여넣기용 페이지. 오늘 추가된 페이지다 |
| `api-endpoints.md` | API 레퍼런스 | 전체 엔드포인트. 파트너 병합 대상 |
| `patterns.md` | 코드 컨벤션 | 모듈·레이어별 패턴 상태, 신뢰도, 실제 기준 파일 + 상세 컨벤션 |
| `coverage.md` | 분석 리포트 | 분석 범위와 미확인 항목 |
| `issues.md` | 분석 리포트 | 이슈와 보안 |
| `call-graph.html` | 분석 리포트 | 데이터가 인라인된 완전 독립 페이지. file://로 직접 열람 가능 |
| `overview.md` (선택) | 시스템 개요 | AI 해설 페이지. 요청 시에만 생성 |

페이지 외 부속 파일은 다음과 같다.

| 파일 | 역할 |
|------|------|
| `_sidebar.md`, `_navbar.md`, `index.html` | Docsify 네비게이션과 진입점 |
| `serve.bat` | `python -m http.server 3501` 실행 스크립트 |
| `_html/*.html`, `offline.html` | 서버 없이 여는 렌더 사본과 file:// 진입점. 원본 `.md`는 그대로 유지 |
| `_workspace/07_wiki_build.md` | 생성 결과 리포트. 크로스 리포 병합 줄 2개 포함 |
| `_workspace/wiki_quality.json` | 연결 수·설명 수·깊이 제한 |
| `_workspace/wiki_prev/` | 재생성 전 백업 1세대 |

## 예시

```text
사용자: 위키 만들어줘

Claude: 기존 wiki가 발견되었습니다 (_workspace/wiki/ 폴더). 덮어쓰시겠습니까? (Y/N)

사용자: Y

Claude: _workspace/wiki/ → _workspace/wiki_prev/ 로 백업 후 wiki_generator.py를 실행합니다.

        wiki 생성 완료

        출력 위치는 _workspace/wiki/ 입니다.
        열기 방법은 _workspace/wiki/serve.bat 실행 후 http://localhost:3501 접속입니다.
        (Docsify 기반이라 인터넷 CDN이 필요하고 file:// 직접 열기는 미지원)
          - _workspace/wiki/_html/*.html 은 서버 없는 열람용 렌더 사본입니다.
          - _workspace/wiki/call-graph.html 은 file://로 직접 열 수 있습니다.
          - _workspace/wiki/diagrams.md 에 Mermaid 다이어그램이 들어 있습니다.

        생성된 wiki를 중앙 허브(wiki-hub)에도 발행할까요? (Y/N)

사용자: N

Claude: 나중에 필요하면 "wiki 발행해줘"라고 하세요.
```

```text
사용자: /wiki 해설 포함

Claude: wiki_generator.py 실행 후 _workspace/01_analyzer_report.md 만 읽어
        _workspace/wiki/overview.md 를 작성하고 docsify_convert.py 로 사이드바를 재조립했습니다.
        overview 는 _html/ 사본에는 포함되지 않습니다.
```

## 원칙과 주의

- wiki는 산출물의 뷰이고 소스는 harness다. wiki 파일을 직접 편집해도 다음 실행 시 덮어쓰인다.
- 폴더 wiki와 wiki-hub는 선택이 아니라 용도가 다르다. 폴더는 이 프로젝트 하나를 혼자 보는 용도, wiki-hub는 여러 시스템을 조직 차원에서 버전 관리와 함께 모아 보는 용도다. 대부분은 폴더만으로 충분하다.
- `PARTIAL`은 페이지 생성 실패가 아니라 분석 누락이 있다는 뜻이다. 누락 목록을 근거로 필요한 업무만 추가 분석하며 전체 harness-init을 자동 재실행하지 않는다.
- 정적 도달 목록을 실제 실행 순서로 설명하지 않는다. business-flows의 호출 관계는 인덱스가 보는 정적 구조다.
- Docsify 뷰는 CDN이 필요하다. 폐쇄망에서는 `_html/`·`offline.html`·`call-graph.html`을 쓴다.

## 관련 문서

- [publish-wiki](/skills/publish-wiki.md)
- [wiki-hub](/skills/wiki-hub.md)
- [pipeline-runner 에이전트](/agents/pipeline-runner.md)
- [하네스 산출물](/concepts/harness-outputs.md)
- [튜토리얼: wiki 생성과 발행](/tutorials/wiki-and-publish.md)
