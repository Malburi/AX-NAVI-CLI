# 인덱서 설정 (indexer-config.json)

`_workspace/indexer-config.json`은 결정론적 인덱서 `build-index.mjs`가 어느 경로를 어떤 워크스페이스로 읽을지 정하는 유일한 설정 파일입니다. harness-init의 `block: index` 단계가 `_workspace/00_init_scope.md`의 값을 기계적으로 옮겨 자동 생성하므로 평소에는 손댈 일이 없고, 인덱싱 범위나 제외 규칙을 바꾸고 싶을 때만 직접 편집합니다. 이 페이지의 키 목록은 `agents/lib/build-index.mjs`의 `loadConfig()`가 실제로 읽는 것만 적었습니다.

## 파일 위치와 로딩 규칙

| 항목 | 값 |
|------|-----|
| 기본 경로 | `[프로젝트 루트]/_workspace/indexer-config.json` |
| 다른 경로 지정 | `build-index.mjs --config <json>` (상대경로는 루트 기준) |
| 파일이 없을 때 | 빈 설정으로 간주하고 루트 전체를 `single-root`로 인덱싱 |
| 인코딩 | UTF-8. PowerShell로 만든 JSON의 BOM은 인덱서가 벗겨 읽음 |
| 생성 주체 | pipeline-runner `block: index` Step B (판단 없는 기계 변환) |

`--check-stale` 판정도 같은 파일을 읽어 `include_paths`를 적용하므로, 설정을 바꾸면 소스 지문이 달라져 다음 검사에서 재인덱싱이 필요하다고 나옵니다.

## 키 목록

| 키 | 타입 | 기본값 | 의미 |
|----|------|--------|------|
| `init_layout` | 문자열 | 아래 유추 규칙 | `single-root` / `monorepo` / `paired-roots` / `selected-paths` 중 하나. 허용 값이 아니면 무시하고 유추함 |
| `workspace_mode` | 불리언 | `false` | 모노레포처럼 여러 워크스페이스를 한 루트에서 인덱싱할 때 `true`. 복잡도 점수의 `multi_module` 신호에도 반영 |
| `workspaces[]` | 배열 | `[{id:"root", path:"", kind, stack}]` | 워크스페이스 정의. 파일이 어느 워크스페이스에 속하는지는 `path` 접두사가 가장 긴 항목으로 결정 |
| `workspaces[].id` | 문자열 | `"root"` | 인덱스 레코드의 `workspace` 필드에 기록되는 식별자 |
| `workspaces[].path` | 문자열 | `""` | 루트 기준 상대경로. `./` 접두사와 끝 `/`는 정규화 |
| `workspaces[].kind` | 문자열 | `"unknown"` | 역할 표기(backend·frontend 등). 인덱서는 값으로 분기하지 않음 |
| `workspaces[].stack` | 문자열 | `"unknown"` | 스택 이름. 복잡도 점수의 `db_or_orm`(sql·jpa·mybatis·ibatis 등)과 `legacy_stack`(struts·ibatis·jsp·egov) 판정에 정규식으로 사용 |
| `workspaces[].calls_backend_api` | 불리언 | `false` | 클라이언트 워크스페이스가 백엔드 API를 호출하는지 표시 |
| `include_paths[]` | 배열 | `[""]` (루트 전체) | 인덱싱할 상대경로 목록. `.`은 루트, `..`이나 `../`로 시작하는 값은 버림 |
| `kind` / `stack` | 문자열 | `"unknown"` | `workspaces`가 없을 때 기본 `root` 워크스페이스에 쓰는 값 |
| `vendor_exclude` | 불리언 | 켜짐 | `false`를 두면 벤더·미니파이 소스 제외를 전부 끔 |
| `test_exclude` | 불리언 | 켜짐 | `false`를 두면 테스트 디렉터리·테스트 파일명 제외를 끔 |

`init_layout`을 지정하지 않으면 `workspace_mode`가 `true`일 때 `monorepo`, `include_paths`에 비어 있지 않은 값이 있으면 `selected-paths`, 그 외에는 `single-root`로 유추합니다. `hub-roots`는 harness-init의 구성 이름이지만 인덱서 설정에서는 허용 값이 아니므로 유추 규칙을 탑니다.

## 예시

단일 프로젝트의 기본 생성값입니다.

```json
{
  "init_layout": "single-root",
  "include_paths": ["."],
  "workspace_mode": false,
  "workspaces": [
    {"id": "root", "path": "", "kind": "unknown", "stack": "unknown"}
  ]
}
```

모노레포에서 백엔드와 프론트엔드를 함께 인덱싱하는 예시입니다.

```json
{
  "init_layout": "monorepo",
  "workspace_mode": true,
  "include_paths": ["server", "web"],
  "workspaces": [
    {"id": "backend", "path": "server", "kind": "backend", "stack": "spring-boot-mybatis"},
    {"id": "frontend", "path": "web", "kind": "frontend", "stack": "vue3", "calls_backend_api": true}
  ]
}
```

특정 폴더만 인덱싱하고 테스트 코드까지 그래프에 넣는 예시입니다.

```json
{
  "init_layout": "selected-paths",
  "include_paths": ["src/main/java/com/example/order", "src/main/resources/mapper"],
  "test_exclude": false
}
```

## 제외 규칙과 이스케이프 해치

인덱서는 기본적으로 두 종류의 소스를 인덱싱하지 않습니다. 제외된 파일은 `_meta.json`의 `excluded_sources`에 `count`·`by_reason`·`bytes`와 파일 목록(최대 100건)으로 남습니다.

| 제외 대상 | 판정 기준 | `by_reason` 값 | 끄는 키 |
|-----------|-----------|----------------|---------|
| 벤더·미니파이 | 라이브러리 배포 디렉터리명, `*.min.js`·`*.bundle.js` 같은 파일명, `jquery-1.5.2.js`처럼 버전이 박힌 이름, 앞 64KB 줄당 평균 250자 이상 | `vendor-path`·`vendor-filename`·`vendor-versioned`·`minified` | `"vendor_exclude": false` |
| 테스트 코드 | `test`/`tests`/`__tests__`/`spec`/`specs` 디렉터리(세그먼트 완전 일치), `*Test.java`·`*_test.go`·`test_*.py`·`*.test.ts`·`*Tests.cs` | `test-path`·`test-filename` | `"test_exclude": false` |

파일명 접두사(`jquery.add.js` 같은 것)로는 판정하지 않습니다. 라이브러리 이름을 접두사로 쓴 업무 코드가 잘리는 실측 사례가 있었기 때문입니다. 자세한 배경은 [결정론적 인덱스](/concepts/deterministic-index.md)를 참고하세요.

## 언제 손으로 고치는가

| 상황 | 고칠 키 | 이후 할 일 |
|------|---------|-----------|
| 초기화 때 고른 폴더 외에 모듈을 하나 더 인덱싱하고 싶다 | `include_paths`에 상대경로 추가 | "인덱스만 갱신해줘" 또는 `build-index.mjs --mode init` |
| 모노레포에 워크스페이스가 추가됐다 | `workspaces[]` 항목 추가, 필요하면 `include_paths`도 | 같음 |
| 업무 코드가 벤더로 오인돼 빠진다 | `"vendor_exclude": false` (전체를 끄는 방식이라 노드가 크게 늘 수 있음) | 재인덱싱 후 `_meta.excluded_sources`로 확인 |
| 테스트 코드의 호출 관계도 보고 싶다 | `"test_exclude": false` | 재인덱싱. `call_graph.json`이 커지고 데드코드 후보가 늘 수 있음 |
| 복잡도 점수가 스택을 못 잡는다 | `workspaces[].stack`에 실제 스택 이름 기입 | 재인덱싱 후 `_meta.json`의 tier 추천값 확인 |

편집 후에는 반드시 재인덱싱해야 반영됩니다. `include_paths`를 바꾸면 인덱스 소스 지문이 달라져 `--check-stale`이 `소스가 변경됨`을 돌려주므로, 팀원과 인덱스를 공유하고 있다면 설정 파일도 함께 커밋하세요.

## 주의사항

- `include_paths`는 루트 안쪽만 허용합니다. 루트 밖 경로를 넣으면 조용히 버려지므로 결과 인덱스의 `_meta.include_paths`로 반영 여부를 확인하세요.
- `init_layout`은 인덱서 동작을 바꾸지 않고 `_meta.json`에 기록되는 표기값입니다. 실제 범위는 `include_paths`와 `workspaces`가 결정합니다.
- 기존 인덱스의 `_meta.generator`가 `deterministic-indexer`가 아닐 때는 `--mode incremental` 대신 `--mode init`으로 다시 만들어야 합니다. 생성기마다 노드 id 체계가 달라 섞이면 안 됩니다.
- 파일을 지우면 다음 인덱싱은 루트 전체를 단일 워크스페이스로 처리합니다.

## 관련 문서

- [결정론적 인덱스](/concepts/deterministic-index.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [크로스 리포 설정](/configuration/pair-config.md)
- [인덱스 파일 스펙](/reference/index-spec.md)
- [harness-init](/skills/harness-init.md)
