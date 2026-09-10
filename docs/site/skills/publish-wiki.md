# publish-wiki

`generate-wiki`가 만든 `_workspace/wiki/` 폴더와 `_workspace/**/*.json`을 중앙 DB(MSSQL·PostgreSQL·Oracle·SQLite)에 발행하는 스킬이다. 시스템 단위로 구분하고 백엔드·프론트엔드를 컴포넌트로 분리 저장하며, 내용이 바뀐 페이지만 새 버전으로 쌓는다. DB 쓰기는 harness 플러그인에 내장된 `agents/lib/wikihub_db/publish.py`가 직접 수행하므로 별도 프로젝트 wiki-hub를 설치할 필요가 없다. 필요한 것은 `SQLAlchemy`와 엔진별 드라이버뿐이다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 발행 | "wiki 발행", "위키 중앙 DB에 올려줘", "wiki 허브에 등록", "시스템 위키 등록" |
| 버전 | "위키 버전 올려줘" |
| 레이어 분리 | "백엔드 프론트엔드 위키 분리 저장" |
| 영어 | "publish wiki" |

슬래시 호출은 `/ax-navi:publish-wiki`이며 별칭은 없다. 자동 제안 경로가 하나 있다. harness-init·generate-wiki 완료 후 "생성된 wiki를 중앙 허브(wiki-hub)에도 발행할까요? (Y/N)" 질문에 Y라고 답하면 이 스킬이 이어서 실행된다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 패키지 확인 | `import sqlalchemy` 확인, `_workspace/wiki/` 존재 확인 | `python -c "import sqlalchemy"` | 없으면 pip install 안내 후 재요청 |
| Phase 1 DB 엔진 확인 | `.env`의 `WIKI_DB_ENGINE`을 읽고 없으면 선택 질문 | `encrypt_password.py` (사용자가 직접 실행) | 엔진 1~4 선택, 접속 정보 입력, 비밀번호 암호화 |
| Phase 2 시스템 키·컴포넌트 | `WIKI_SYSTEM_KEY`와 컴포넌트 타입 결정 | 없음 | 키 입력, 추정된 레이어 확인 |
| Phase 2.5 담당자 정보 | `WIKI_PUBLISHER_*`가 없으면 여섯 항목을 한 번에 받음 | 없음 | 회사명·소속·사번·성명·전화·이메일 |
| Phase 3 발행 실행 | 스크립트 1회 실행 | `agents/lib/wikihub_db/publish.py` | 없음 |
| Phase 4 결과 보고 | 스크립트 출력과 열람 경로 안내 | 없음 | 없음 |

Phase 1의 엔진 선택지는 다음과 같다. MSSQL을 기본 추천으로 제시하되 강제하지 않는다.

| 선택 | 엔진 | 드라이버 |
|------|------|---------|
| 1 | MSSQL (권장, 팀 공유) | `pymssql` |
| 2 | PostgreSQL (팀 공유) | `psycopg2-binary` |
| 3 | Oracle (팀 공유) | `oracledb` (Instant Client 불필요) |
| 4 | SQLite (1인 사용·오프라인) | 추가 설치 불필요 |

비밀번호는 평문으로 `.env`에 쓰지 않고 암호화를 권장한다. 암호화 스크립트는 `getpass`로 입력받기 때문에 Claude가 대신 실행하지 않고 사용자가 자기 터미널에서 직접 실행한다. 완료 알림을 받은 뒤 다음 단계로 넘어간다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wikihub_db/encrypt_password.py" --root "[절대경로]" --engine mssql
```

Phase 2의 컴포넌트 타입은 `.env`(`WIKI_COMPONENT_KEY`/`TYPE`) → `_workspace/pair_config.md`의 `project_type` → 폴더명 추정 순으로 결정하되, 추정값은 반드시 확인받는다. Phase 2.5의 담당자 항목 중 회사명·사번·성명이 없으면 발행을 중단하고, 소속·전화번호·이메일이 없으면 경고 후 진행한다.

Phase 3의 기본 명령은 다음과 같다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wikihub_db/publish.py" --root "[절대경로]" `
  --system-key "[시스템키]" --system-name "[표시이름]" `
  --component-type [backend|frontend|...] --component-key "[컴포넌트키]" `
  --publisher-company "[회사명]" --publisher-dept "[소속]" --publisher-empno "[사번]" `
  --publisher-name "[성명]" --publisher-phone "[전화번호]" --publisher-email "[이메일]" `
  --summary "[이번 변경 요약]" --save-env
```

SKILL.md에 적힌 추가 옵션은 다음과 같다.

| 옵션 | 쓰는 때 |
|------|--------|
| `--dry-run` | DB를 건드리지 않고 대상 페이지만 확인 |
| `--no-index` | 구조화 인덱스 추출을 건너뜀 |
| `--no-workspace-json` | `_workspace/**/*.json` 원본 발행을 건너뜀 (위키 문서만 발행) |
| `--pull` | 반대 방향. 위키 문서는 `_workspace/wiki/`로, 워크스페이스 JSON은 프로젝트 루트 기준 원래 경로로 복원 |
| `--list` | 등록된 시스템·컴포넌트 확인 |
| `--list-owners` | 시스템별 담당자와 연락처 확인 |
| `--save-env` | 이번에 받은 값을 `.env`에 저장해 다음 발행부터 질문 생략 |
| `--owner-role owner --set-system-owner` | 발행자를 시스템 대표 담당자로 등록 |
| `--skip-publisher` | 담당자 정보 없이 발행. CI 등 예외 상황에서만, 사용자 확인 후 |
| `--grant "사번=역할"`, `--grant-scope global`, `--list-grants`, `--access-control on` | 권한 관리. 사용자가 먼저 요청할 때만 안내 |
| `--migrate-v1`, `--map "KEY=SYS:comp:type"` | 예전 단일 테이블(`harness_wiki_pages`) 데이터를 새 스키마로 이관 |

기본값은 위키 문서와 워크스페이스 JSON을 모두 발행하는 것이라 대부분은 옵션 없이 실행하면 된다. 백엔드·프론트엔드가 별도 저장소면 양쪽에서 각각 발행하되 같은 `--system-key`와 다른 `--component-type`을 쓴다.

## 입력과 산출물

| 구분 | 경로 | 설명 |
|------|------|------|
| 읽음 | `_workspace/wiki/*.md`, `*.html` | generate-wiki가 만든 폴더 wiki |
| 읽음 | `_workspace/**/*.json` | call_graph·schema·sql_usage 등 harness index와 writer_decisions.json 원본 |
| 읽음 | `.env` | `WIKI_DB_ENGINE`, `MSSQL_*`/`PG_*`/`ORACLE_*`/`WIKI_SQLITE_PATH`, `WIKI_SYSTEM_KEY`, `WIKI_COMPONENT_*`, `WIKI_PUBLISHER_*` |
| 읽음 | `.wiki_db.key` | 비밀번호 복호화 키. 최초 암호화 시 자동 생성, git 미포함 |
| 읽음 | `_workspace/pair_config.md` (있을 때) | 컴포넌트 타입 추정 근거 |
| 씀 | `.env` | `--save-env` 시 키·담당자 값 저장. 기존 값은 덮어쓰지 않음 |
| 씀 | 중앙 DB `wikihub_*` 테이블 | 아래 표 참조 |
| 씀 (`--pull`) | `_workspace/wiki/`, `_workspace/index/...` | DB에서 문서와 JSON을 원래 경로로 복원 |

DB에 저장되는 축은 다음과 같다.

| 축 | 테이블 |
|----|--------|
| 시스템 | `wikihub_systems` |
| 컴포넌트 | `wikihub_components` (backend/frontend/fullstack/batch/mobile/common) |
| 페이지·버전 | `wikihub_pages`, `wikihub_page_versions` (체크섬이 바뀔 때만 새 버전) |
| 구조화 정보 | `wikihub_api_endpoints`, `wikihub_db_objects`, `wikihub_frontend_routes`, `wikihub_external_links` |
| 담당자 | `wikihub_persons`, `wikihub_system_owners` |
| 권한 | `wikihub_roles`, `wikihub_permissions`, `wikihub_role_permissions`, `wikihub_access_grants` (강제는 기본 off) |

`--pull` 직후에는 `build-index.mjs --check-stale`로 받은 인덱스가 내 로컬 소스와 맞는지 확인한다. 순서는 반드시 pull → check-stale이다. 반대로 하면 방금 만든 로컬 인덱스를 오래된 DB 사본이 덮어쓴다.

## 예시

```text
사용자: wiki 발행해줘

Claude: sqlalchemy 확인 완료. .env 에 WIKI_DB_ENGINE 이 없습니다.
        wiki를 저장할 DB 엔진을 선택하세요. (1 MSSQL / 2 PostgreSQL / 3 Oracle / 4 SQLite)

사용자: 1

Claude: HOST/PORT/USER/DATABASE 를 알려주세요. 비밀번호는 아래 명령을 사용자 터미널에서 직접 실행해 암호화합니다.
        python ".../agents/lib/wikihub_db/encrypt_password.py" --root "D:\work\order-api" --engine mssql

사용자: (터미널 실행 후) 암호화 완료

Claude: 이 저장소가 속한 시스템의 키를 입력하세요 (예: ORDER). 표시 이름도 함께 주세요.

사용자: ORDER / 주문관리시스템

Claude: 레이어 추정 결과는 backend 입니다 (근거는 폴더명). 그대로 사용할까요?

사용자: 1

Claude: 담당자 정보를 한 줄로 주세요. 예) 한빛에스아이 / 금융서비스1팀 / 20231234 / 김유지 / 010-1234-5678 / yujin.kim@hanbit.co.kr

사용자: 한빛에스아이 / 금융서비스1팀 / 20231234 / 김유지 / 010-1234-5678 / yujin.kim@hanbit.co.kr

Claude: 발행 완료
          시스템   : ORDER (주문관리시스템)
          컴포넌트 : backend [backend]
          담당자   : 한빛에스아이 금융서비스1팀 / 김유지(20231234) [publisher]
          페이지   : 신규 8 / 변경 0 / 동일 0 / 삭제표시 0 (총 8)
          워크스페이스 JSON : 6개
          인덱스   : api 4건, db 3건, route 0건, external 2건
        --save-env 로 키와 담당자를 .env 에 저장했으니 다음 발행부터는 질문이 없습니다.
```

```text
사용자: 팀원이 발행해둔 인덱스 받아줘

Claude: python publish.py --root "D:\work\order-api" --pull --system-key ORDER --component-key backend 를 실행합니다.
        위키 문서는 _workspace/wiki/ 로, JSON 은 _workspace/index/ 원래 경로로 복원했습니다.
        이어서 build-index.mjs --check-stale 결과가 exit 1 이라 --mode incremental 인덱싱 1회를 실행합니다.
```

## 원칙과 주의

- 시스템 키는 조직의 시스템 단위, 컴포넌트는 레이어 단위다. 백엔드·프론트엔드 저장소가 같은 업무 시스템이면 시스템 키가 같아야 한다. 이 규칙이 깨지면 허브에서 한 시스템이 둘로 쪼개져 보인다.
- 비밀번호 암호화는 "디스크에 평문으로 남지 않게"이지 "접속 시 평문을 안 쓰게"가 아니다. `.env`가 유출돼도 암호문뿐이지만 `.wiki_db.key`까지 함께 유출되면 복호화 가능하다.
- 담당자는 문자열이 아니라 사람으로 저장한다. (회사명 + 사번)이 유일 키이며 기존 `author` 컬럼은 표시용으로 남아 있다.
- 권한은 표를 먼저 만들고 강제는 나중에 켠다. `--access-control on`은 부여를 끝낸 뒤 사용자 확인을 받고 실행한다. 실제 차단은 조회 서버가 하므로 서버 배포 전에는 켜도 화면 동작이 달라지지 않는다.
- wiki는 harness 산출물의 스냅샷이다. 영향도 분석·드리프트 검증은 `impact-analyzer`·`api-bridge`의 라이브 재분석으로 한다.
- 예전 v1 단일 테이블 이관 시 원본 테이블은 지우지 않는다. 확인 후 사용자가 직접 정리한다.

## 관련 문서

- [generate-wiki](/skills/generate-wiki.md)
- [wiki-hub](/skills/wiki-hub.md)
- [설정과 도구](/configuration/settings-and-tools.md)
- [튜토리얼: wiki 생성과 발행](/tutorials/wiki-and-publish.md)
- [튜토리얼: 인수인계](/tutorials/handover.md)
