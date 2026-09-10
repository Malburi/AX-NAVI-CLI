# wiki-hub

`publish-wiki`로 발행된 여러 시스템의 wiki를 한 사이트에서 통합 열람·검색·관리하는 스킬이다. 시스템 목록, 백엔드/프론트엔드 컴포넌트 구분, 전 시스템 전문 검색, API·DB테이블·화면·외부연동 교차 인덱스, 페이지별 버전 이력·비교·복원을 다룬다. 읽기 전용 뷰어가 아니라 관리 도구다.

한 가지를 먼저 분명히 해 둔다. 이 스킬이 실행하는 `wiki-hub-serve`는 AX Navi 플러그인이 아니라 별도 프로젝트 wiki-hub의 콘솔 명령이며, 이 저장소 안에는 그 서버 코드가 들어 있지 않다. 운영 계획은 수립 중이다. 플러그인이 갖고 있는 것은 저장(쓰기) 쪽인 `agents/lib/wikihub_db/`뿐이고, 조회 화면은 같은 DB를 읽는 별도 서버가 맡는다. 따라서 이 페이지의 화면 안내는 SKILL.md에 적힌 계획을 옮긴 것이며, 서버가 배포되기 전까지는 직접 확인할 수 없다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 실행 | "위키 허브 띄워줘", "통합 위키 보여줘", "DB 위키 보여줘" |
| 목록·검색 | "시스템 위키 목록", "wiki 검색" |
| 버전 | "위키 버전 비교", "이전 버전으로 되돌려줘" |
| 관리 | "중앙 위키 관리" |
| 영어 | "wiki hub" |

슬래시 호출은 `/ax-navi:wiki-hub`이며 별칭은 없다. 사용자가 "위키 보여줘"라고만 말하면 폴더 wiki인지 DB wiki인지 먼저 확인한다.

| | 폴더 wiki | DB(중앙 허브) wiki |
|---|---|---|
| 저장 위치 | 이 프로젝트의 `_workspace/wiki/` | 중앙 DB (여러 프로젝트 공유) |
| 보는 방법 | `_workspace/wiki/serve.bat` → `http://localhost:3501` | `wiki-hub-serve` → `http://localhost:8800` |
| 범위 | 이 프로젝트 하나 | 발행된 모든 시스템 |
| 버전 이력 | 없음 (매번 덮어씀) | 있음 (비교·되돌리기) |
| 만드는 스킬 | `generate-wiki` | `generate-wiki` 다음 `publish-wiki` |

"이 프로젝트 wiki만 보고 싶다"면 generate-wiki가 만든 `serve.bat` 안내로 끝이고 이 스킬은 필요 없다. "여러 시스템을 한 곳에서" 또는 "버전 이력을" 보고 싶을 때만 이 스킬로 진행한다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 설치·데이터 확인 | `wiki-hub-serve --help`로 명령 존재 확인, 발행 데이터 존재 확인 | `wiki-hub-serve` (별도 프로젝트) | 없음 |
| Phase 1 허브 실행 | 서버 기동 후 접속 URL 안내 | `wiki-hub-serve --root "[절대경로]" --port 8800` | 브라우저 접속, 종료는 Ctrl+C |
| Phase 2 화면 안내 | 하려는 일에 맞는 화면 경로 안내 | 없음 | 화면 조작 |
| Phase 3 버전 관리 | 이력·비교·되돌리기, 되돌린 내용의 로컬 회수 | `publish.py --pull` | 되돌리기 버튼, 회수 여부 |
| Phase 3.5 담당자·권한 | 담당자 조회, 권한 부여 순서 안내 | `publish.py --list-owners`, `--grant`, `--list-grants`, `--access-control on` | 부여 대상 결정, 스위치 켜기 확인 |
| Phase 4 시스템 목록 관리 | 표시 이름·설명·담당·태그 수정, 보관 | 없음 | 폼 편집 |

Phase 0에서 명령이 없으면 서버가 아직 배포되지 않은 것이다. 이때는 "서버 배포 전이라 통합 조회 화면은 아직 없습니다. 데이터는 이미 DB에 저장돼 있으니 서버 배포 후 그대로 보입니다"라고 안내하고 중단한다. `publish-wiki`의 DB 저장은 이 명령과 무관하게 항상 가능하다. 아직 아무 시스템도 발행하지 않았다면 `publish-wiki`를 먼저 안내한다.

Phase 1의 옵션은 SKILL.md에 적힌 네 가지다.

| 옵션 | 설명 |
|------|------|
| `--engine` | `.env`의 `WIKI_DB_ENGINE`을 1회성으로 덮어씀 (mssql/postgresql/oracle/sqlite) |
| `--host 0.0.0.0` | 팀에 공유. 인증이 없으므로 사내망 안에서만 |
| `--read-only` | 되돌리기·정보 수정 비활성화. 열람 전용 배포용 |
| `--port` | 기본 8800 |

`--root`는 접속 정보(`.env`)가 있는 폴더다. 여러 프로젝트가 같은 DB를 공유하므로 어느 프로젝트 루트에서 실행해도 등록된 시스템은 전부 보인다.

Phase 2의 화면 구성은 다음과 같다.

| 하려는 일 | 화면 |
|----------|------|
| 어떤 시스템이 등록돼 있나 | `/` — 시스템 카드, 색 배지가 레이어 |
| 한 시스템의 구성과 페이지 | `/s/[시스템키]` — 컴포넌트 표 + 페이지 목록 + 정보 편집 + 담당자 표 |
| 문서 내용에서 찾기 | `/search` — 전 시스템 본문 검색, 시스템·레이어로 좁힘 |
| 이 API를 누가 쓰나 | `/index/api` |
| 이 테이블을 누가 쓰나 | `/index/db` |
| 어떤 화면이 어떤 API를 부르나 | `/index/route` |
| 외부 시스템 연동 지점 | `/index/external` |
| 최근에 뭐가 바뀌었나 | `/changes` — 누가(성명·사번) 올렸는지 함께 표시 |
| 페이지 내용 보기 | `/page/[시스템]/[컴포넌트]/[경로]` (`?v=N`으로 특정 버전) |
| 버전 이력 | `/history/[시스템]/[컴포넌트]/[페이지]` |

허브 화면은 외부 CDN을 쓰지 않고 서버가 직접 렌더링하므로 폐쇄망에서도 뜬다.

Phase 3.5의 역할 체계는 다음과 같다. 표와 기본 역할은 준비돼 있고 강제만 꺼져 있다(`access_control=off`).

| 역할 | 할 수 있는 일 |
|------|-------------|
| `reader` | 열람 · 검색 · 버전 이력 |
| `editor` | reader + 발행 · 되돌리기 |
| `manager` | editor + 시스템 정보 수정 · 권한 부여 |
| `admin` | 전부 (`--grant-scope global`이면 모든 시스템) |

권한을 걸 때는 순서를 지킨다. 부여를 모두 끝낸 뒤 켠다. 먼저 켜면 권한을 못 받은 사람이 즉시 전부 차단된다.

```powershell
# 1) 부여
publish.py --root "[절대경로]" --grant "20231234=reader" --system-key ORDER
# 2) 확인
publish.py --root "[절대경로]" --list-grants
# 3) 사용자 확인을 받고 마지막에 켠다
publish.py --root "[절대경로]" --access-control on
```

## 입력과 산출물

이 스킬은 harness 프로젝트 파일을 거의 쓰지 않는다. 허브 화면의 조작은 DB 안에서 일어난다.

| 구분 | 경로 | 설명 |
|------|------|------|
| 읽음 | `.env` | `--root`로 가리킨 폴더의 DB 접속 정보 |
| 읽음 | 중앙 DB `wikihub_*` 테이블 | publish-wiki가 쓴 시스템·컴포넌트·페이지·버전·인덱스·담당자·권한 |
| 씀 (허브 화면) | 중앙 DB | 되돌리기(새 버전 추가), 시스템 정보 편집, 보관 표시 |
| 씀 (`--pull`) | `_workspace/wiki/` | 허브에서 되돌린 내용을 로컬 폴더로 회수할 때만 |

되돌린 내용을 실제 프로젝트 폴더에도 반영하려면 회수한다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wikihub_db/publish.py" --root "[절대경로]" `
  --system-key "[시스템키]" --component-key "[컴포넌트키]" --pull --wiki-dir "[절대경로]/_workspace/wiki"
```

## 예시

```text
사용자: 위키 허브 띄워줘

Claude: wiki-hub-serve --help 를 확인합니다.
        명령이 없습니다. wiki-hub-serve 는 별도 서버(운영 계획 수립 중)라 아직 배포되지 않았습니다.
        서버 배포 전이라 통합 조회 화면은 아직 없습니다. 데이터는 이미 DB에 저장돼 있으니(publish-wiki)
        서버 배포 후 그대로 보입니다.
        지금 이 프로젝트 wiki만 보려면 _workspace/wiki/serve.bat 을 실행하세요.
```

```text
사용자: 이전 버전으로 되돌려줘

Claude: (서버가 있는 환경) /history/ORDER/backend/api-endpoints.md 에서 버전을 최신순으로 볼 수 있습니다.
        "이 버전으로 되돌리기"를 누르면 새 버전이 하나 더 쌓이고 이력은 줄지 않습니다.
        로컬 _workspace/wiki/ 에도 반영하려면 publish.py --pull 로 회수합니다.
        다음 generate-wiki 실행 시 harness 산출물 기준으로 다시 덮어써지니 되돌리기는 문서 이력 추적용입니다.
```

## 원칙과 주의

- 허브는 발행된 것만 보여준다. 코드를 다시 읽지 않는다. 화면이 옛날 내용이면 그 시스템에서 `generate-wiki` → `publish-wiki`를 다시 돌린다.
- 인덱스 표는 스냅샷이다. `/index/*`의 API·테이블 목록은 발행 시점 값이며 실제 영향도 판단은 `impact-analyzer`와 `api-bridge`의 라이브 재분석으로 한다.
- DB 엔진을 바꿔도 이 스킬은 그대로다. `.env`의 `WIKI_DB_ENGINE`만 바뀌고 실행법은 같다.
- 스키마는 플러그인의 `agents/lib/wikihub_db/models.py`와 wiki-hub 프로젝트 쪽이 바이트 단위로 같아야 한다. 현재는 수동 동기화이며 자동화 방안은 없다.
- 되돌리기는 문서 이력 추적용이지 소스 코드 롤백이 아니다.
- 실제 차단은 조회 서버가 수행한다. 서버 배포 전에는 `--access-control on`을 켜도 화면 동작이 달라지지 않는다.

## 관련 문서

- [publish-wiki](/skills/publish-wiki.md)
- [generate-wiki](/skills/generate-wiki.md)
- [설정과 도구](/configuration/settings-and-tools.md)
- [튜토리얼: wiki 생성과 발행](/tutorials/wiki-and-publish.md)
- [FAQ](/faq.md)
