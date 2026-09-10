# wiki 생성과 발행

하네스 산출물을 사람이 읽는 wiki로 바꾸고, 혼자 볼 때는 폴더로 열고, 조직에 시스템이 여러 개 쌓이면 중앙 DB에 발행하는 흐름이다. wiki 본문은 LLM을 쓰지 않고 스크립트가 만들기 때문에 언제든 다시 만들 수 있다.

- **소요 시간** — 생성 수 분(LLM 없음), 발행은 최초 설정 10분 이후 회당 1분 내외.
- **전제** — `_workspace/01_analyzer_report.md`가 있다. 발행에는 Python `SQLAlchemy`와 DB 드라이버가 필요하다.
- **이 튜토리얼이 다루는 스킬** — `generate-wiki`(`/wiki`), `publish-wiki`, 열람은 `wiki-hub`.

## 준비

새 세션에서 시작한다. `harness-init` 직후에는 컨텍스트가 이미 커져 있어 같은 결과를 더 비싸게 얻기 때문에 초기화 메뉴에서 "지금 안 함"을 고르고 따로 도는 것이 권고된다.

폴더 wiki와 DB wiki는 용도가 다르다.

| | 폴더 wiki | DB(중앙 허브) wiki |
|---|---|---|
| 저장 위치 | `_workspace/wiki/` | wiki-hub 중앙 DB(여러 프로젝트 공유) |
| 보는 방법 | `_workspace/wiki/serve.bat` → `http://localhost:3501` | `wiki-hub-serve` → `http://localhost:8800` |
| 범위 | 이 프로젝트 하나 | 발행된 모든 시스템 |
| 버전 이력 | 없음(매번 덮어씀) | 있음(비교·되돌리기) |
| 만드는 스킬 | `generate-wiki` | `generate-wiki` 다음 `publish-wiki` |

대부분은 폴더만으로 충분하다.

## 단계별 진행

### 1. wiki 생성

```text
위키 만들어줘
```

`generate-wiki`가 Phase 0에서 `_workspace/01_analyzer_report.md`를 확인하고(없으면 harness-init 안내 후 중단), 기존 `_workspace/wiki/`가 있으면 덮어쓸지 묻는다. Y면 `_workspace/wiki_prev/`로 1세대만 백업하고 재생성한다. 다른 스킬의 후속 갱신(safe-modify Phase 5 등)으로 호출된 경우에는 이 질문이 생략된다.

Phase 2에서 명령 한 번으로 페이지를 만든다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wiki_generator.py" --root "[절대경로]" --wiki-dir "[절대경로]/_workspace/wiki"
```

`_workspace/pair_config.md`가 있으면 파트너 저장소의 `call_graph.json`·`api_contract.json`·`schema.json`·`external_io.json`을 함께 읽어 architecture·api-endpoints·database·external-systems 페이지에 자동 병합한다. 별도 인자는 없다.

AI 해설 페이지가 필요하면 요청문에 밝힌다.

```text
위키 만들어줘 — 해설 포함
```

이 경우에만 `_workspace/01_analyzer_report.md`를 읽어 `_workspace/wiki/overview.md`를 쓴다(약 5~10K 토큰). wiki 본문 중 유일한 LLM 예외다.

### 2. 폴더 wiki 열기

보고에 나오는 열기 방법을 따른다.

- `_workspace/wiki/serve.bat` 실행 후 브라우저로 `http://localhost:3501` — Docsify 기반이라 인터넷 CDN이 필요하고 `file://`로 직접 열기는 미지원이다.
- `_workspace/wiki/_html/*.html` — Home·architecture·workflows 등 페이지의 서버 없는 열람용 렌더 사본. 원본 `.md`는 그대로 유지된다.
- `_workspace/wiki/call-graph.html` — 데이터가 파일 안에 인라인된 완전 독립 페이지. `file://`로 열린다.
- `_workspace/wiki/patterns.md` — 모듈·레이어별 패턴 상태(preferred/legacy/anti-pattern), 신뢰도, 실제 기준 파일이 상세 컨벤션보다 먼저 나온다.
- `_workspace/wiki/business-flows.md` — API별 실제 호출 관계·SQL·읽기/쓰기 테이블과 미확인 규칙.
- `_workspace/wiki/coverage.md`와 `_workspace/wiki_quality.json` — 연결 수·설명 수·깊이 제한. `PARTIAL`은 페이지 생성 실패가 아니라 분석 누락이 있다는 뜻이다.

빌드 요약은 `_workspace/07_wiki_build.md`에 있다.

### 3. diagrams.md의 Mermaid 붙여넣기

`call-graph.html`은 인터랙티브 열람용이라 GitHub·Confluence·PR 본문에 붙일 수 없다. 같은 인덱스에서 붙여 넣을 수 있는 Mermaid 마크업을 만든 페이지가 `_workspace/wiki/diagrams.md`다.

| 절 | 소스 | 다이어그램 |
|---|---|---|
| ERD | `schema.json` | `erDiagram` — 테이블·컬럼·FK. DDL 유도 스키마는 컬럼이 비어 관계만 그린다 |
| 엔드포인트 처리 흐름 | `data_flow.json`·`api_contract.json` | `sequenceDiagram` — 메서드 체인이 긴 엔드포인트 상위 N개 |
| 외부 통신 | `external_io.json` | `flowchart` — type별 외부 대상 |

각 절의 ```` ```mermaid ```` 코드 블록을 그대로 복사해 붙인다. 상한을 넘은 항목은 "통신 대상 N개 중 상위 M개만 표시했다" 같은 안내 문장이 뒤따르니 함께 옮긴다. 인덱스에 없는 것은 그리지 않으므로 지어낸 관계가 섞일 걱정은 없다. 그릴 데이터가 하나도 없으면 페이지 자체가 생성되지 않는다.

### 4. 중앙 허브 발행 여부

폴더 wiki 생성이 끝나면 Phase 3.5에서 묻는다.

```text
생성된 wiki를 중앙 허브(wiki-hub)에도 발행할까요? (Y/N)
```

Y면 `publish-wiki`로 이어진다. N이면 나중에 "wiki 발행해줘"로 따로 부를 수 있다. DB 저장은 플러그인에 내장된 `agents/lib/wikihub_db/`가 직접 수행하므로 별도 프로젝트 wiki-hub를 설치하지 않아도 된다.

### 5. publish-wiki 최초 설정

Phase 0에서 `python -c "import sqlalchemy"`로 패키지를 확인한다. 없으면 안내가 나온다.

```text
pip install sqlalchemy
MSSQL: pip install pymssql / PostgreSQL: psycopg2-binary / Oracle: oracledb
비밀번호 암호화(권장): pip install cryptography
```

Phase 1에서 `.env`의 `WIKI_DB_ENGINE`을 읽고, 없으면 MSSQL(권장)·PostgreSQL·Oracle·SQLite(1인·오프라인) 중 고르게 한다. 접속 필드는 엔진마다 다르다(`MSSQL_*`/`PG_*`/`ORACLE_*`/`WIKI_SQLITE_PATH`). 스키마는 최초 접속 시 자동 생성된다.

비밀번호는 평문으로 두지 않고 암호화를 권장한다. 이 스크립트는 사용자가 자신의 터미널에서 직접 실행한다. Claude 도구로 실행하면 TTY가 없어 멈추고, 채팅으로 입력하면 로그에 평문이 남기 때문이다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wikihub_db/encrypt_password.py" --root "[절대경로]" --engine mssql
```

암호화 키는 프로젝트 루트 `.wiki_db.key`에 생성된다(git 미포함). 삭제하면 복호화할 수 없다.

Phase 2에서 시스템 키(예: `ORDER`)와 표시 이름(예: 주문관리시스템), 컴포넌트(backend/frontend/fullstack/batch/mobile/common)를 확인한다. 백엔드와 프론트엔드가 한 시스템이면 양쪽 저장소에 같은 시스템 키를 넣고 컴포넌트로 레이어를 나눈다.

Phase 2.5에서 담당자 정보를 한 번에 받는다.

```text
한빛에스아이 / 금융서비스1팀 / 20231234 / 김유지 / 010-1234-5678 / yujin.kim@hanbit.co.kr
```

회사명·사번·성명이 없으면 발행이 중단된다. 소속·전화·이메일은 경고 후 진행된다. `.env`에 `WIKI_PUBLISHER_*`가 있으면 다시 묻지 않는다.

### 6. 발행 실행과 옵션

Phase 3에서 스크립트를 실행한다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wikihub_db/publish.py" --root "[절대경로]" `
  --system-key "ORDER" --system-name "주문관리시스템" `
  --component-type backend --component-key "backend" `
  --publisher-company "[회사명]" --publisher-dept "[소속]" --publisher-empno "[사번]" `
  --publisher-name "[성명]" --publisher-phone "[전화번호]" --publisher-email "[이메일]" `
  --summary "[이번 변경 요약]" --save-env
```

기본값은 wiki 문서와 `_workspace/**/*.json` 원본을 모두 발행한다. 대부분은 옵션 없이 그대로 실행하면 된다.

| 옵션 | 쓰는 때 |
|---|---|
| `--dry-run` | DB를 건드리지 않고 대상 페이지만 확인 |
| `--no-index` | API·DB테이블·화면·외부연동 구조화 인덱스 추출 생략 |
| `--no-workspace-json` | `_workspace/**/*.json` 원본 발행 생략(위키 문서만) |
| `--pull` | 반대 방향. 위키는 `_workspace/wiki/`로, 워크스페이스 JSON은 원래 경로로 복원 |
| `--list` | 등록된 시스템·컴포넌트 확인 |
| `--list-owners` | 시스템별 담당자와 연락처 확인 |
| `--save-env` | 이번 입력값을 `.env`에 저장해 다음부터 질문 생략 |
| `--owner-role owner --set-system-owner` | 발행자를 시스템 대표 담당자로 등록 |
| `--skip-publisher` | CI 등 담당자 없는 자동 발행(사용자 확인 후에만) |
| `--migrate-v1` | 예전 단일 테이블(`harness_wiki_pages`) 데이터 이관 |

Phase 4 보고에는 시스템·컴포넌트·담당자·페이지 수(신규/변경/동일/삭제표시)·워크스페이스 JSON 수·인덱스 건수가 나온다. 내용이 같은 페이지는 새 버전을 만들지 않는다.

## 결과 확인

- `_workspace/wiki/` 전체와 `_workspace/07_wiki_build.md`, `_workspace/wiki_quality.json`.
- `_workspace/wiki/diagrams.md`에서 복사한 Mermaid 블록이 대상 문서에서 렌더된다.
- `publish.py --list` 결과에 시스템 키와 컴포넌트가 보인다.
- `publish.py --list-owners` 결과에 담당자와 연락처가 보인다.
- `.env`에 `WIKI_DB_ENGINE`·`WIKI_SYSTEM_KEY`·`WIKI_PUBLISHER_*`가 저장돼 다음 발행부터 질문이 없다.

## 막혔을 때

- **"harness-init을 먼저 실행해주세요"** — `_workspace/01_analyzer_report.md`가 없다. 하네스를 만든 뒤 다시 시도한다.
- **브라우저에서 `file://`로 열었는데 빈 화면이다** — Docsify는 서버가 필요하다. `serve.bat`을 쓰거나 `_html/*.html`을 연다. `call-graph.html`만 `file://`로 열린다.
- **wiki 페이지를 직접 고쳤는데 사라졌다** — wiki는 산출물의 뷰다. 다음 `generate-wiki`에서 덮어쓰인다. 고칠 내용은 소스나 하네스에 반영하고 재생성한다.
- **`coverage.md`가 PARTIAL이다** — 분석 누락 목록을 근거로 필요한 업무만 추가 분석한다. 전체 harness-init을 자동 재실행하지는 않는다.
- **파트너 wiki가 병합되지 않았다** — `07_wiki_build.md`의 "크로스 리포 병합" 줄에 스킵 사유가 있다. 파트너 `_workspace/index/`가 없으면 그쪽에서 인덱싱을 먼저 한다.
- **크로스 리포 구조인데 어떻게 발행하나** — 양쪽 저장소에서 각각 발행하되 같은 `--system-key`, 다른 `--component-type`을 쓴다. 키가 다르면 허브에서 한 시스템이 둘로 쪼개져 보인다.
- **팀원이 `--pull`로 받았는데 인덱스가 오래됐다** — 순서는 반드시 pull → `build-index.mjs --check-stale`이다. exit 1이면 `--mode incremental` 1회로 맞춘다. 반대로 하면 방금 만든 로컬 인덱스를 오래된 DB 사본이 덮어쓴다.
- **통합 화면이 안 뜬다** — `wiki-hub-serve`는 별도 서버 프로젝트의 명령이다. 배포 전이면 화면은 없지만 데이터는 이미 DB에 있으므로 배포 후 그대로 보인다.

## 관련 문서

- [generate-wiki](/skills/generate-wiki.md) — Phase 0~3.5와 원칙.
- [publish-wiki](/skills/publish-wiki.md) — DB 축(시스템·컴포넌트·페이지·버전·담당자·권한)과 옵션 전문.
- [wiki-hub](/skills/wiki-hub.md) — 통합 열람 화면, 버전 비교·복원, 권한 스위치.
- [하네스 산출물](/concepts/harness-outputs.md) — wiki가 어떤 파일에서 만들어지는지.
- [담당자 교체·인수인계](/tutorials/handover.md) — 발행본을 인수인계에 쓰는 방법.
