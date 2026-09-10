# 트리거 문구 전체 표

스킬은 각 `SKILL.md`의 frontmatter `description`에 등록된 문구와 대상 프로젝트 CLAUDE.md의 자동 워크플로우 표를 근거로 자연어 요청에 매칭됩니다. 두 메커니즘 모두 LLM 판단 기반의 확률 매칭이므로 등록 문구와 다른 표현은 스킬을 타지 않을 수 있고, 보장 경로는 `/ax-navi:<스킬>` 슬래시 호출뿐입니다. 이 페이지는 `skills/*/SKILL.md` description과 `docs/skill-triggers.md`에서 문구를 그대로 옮겼습니다.

## 라우팅 우선순위

```
사용자 요청
 ├─ "/ax-navi:<스킬명>" 또는 "/modify" 등 별칭      → 해당 스킬 (확정 경로)
 ├─ "영향도 [대상]" 등 축약 문구                    → 지정 스킬
 ├─ "개발해줘/구현해줘/새 기능"                     → scaffold-feature (기본값)
 ├─ "수정해줘/고쳐줘/개선해줘"                      → safe-modify (기본값)
 ├─ "알아서 해줘/그냥 해줘/바이브로"                 → vibe (명시적 opt-out)
 ├─ "찾아 [대상]/찾기 [대상]"                       → find-feature
 └─ 그 외 description 매칭                          → 해당 스킬
```

기본값은 게이트 경로입니다. 범용 요청은 인덱스·패턴·안전성 게이트를 태우고, 게이트 생략은 vibe 문구로만 가능합니다. 기존 코드 변경이면 safe-modify, 새 파일·기능 생성이면 scaffold-feature로 갈립니다.

## 축약 문구

| 축약 문구 | 스킬 | 사용 예 |
|-----------|------|---------|
| 영향도, 임팩트 | analyze-impact | `영향도 UserService.updateUser` |
| 안전수정 | safe-modify | `안전수정 로그인 타임아웃 30초로` |
| 스캐폴드 | scaffold-feature | `스캐폴드 쿠폰 발급` |
| 마이그 | plan-migration | `마이그 iBatis → MyBatis` |
| SQL리뷰, 쿼리리뷰 | review-sql | `SQL리뷰 selectOrderList` |
| 찾아, 찾기 | find-feature | `찾아 결제 승인`, `쿠폰 찾기` |

bare "찾아줘"에 대상어가 없거나 버그·수정 맥락이면 find-feature로 고정하지 않고 safe-modify 판단 여지를 남깁니다.

## 범용 문구 (게이트 경로 기본값)

| 문구 | 라우팅 | 실행 내용 |
|------|--------|-----------|
| "수정해줘", "고쳐줘", "개선해줘", "버그 잡아줘", "이거 바꿔줘" | safe-modify | 사전 영향 분석 → 적용 → 사후 GO/HOLD/STOP |
| "개발해줘", "구현해줘", "코드 짜줘", "새 기능 만들어줘" | scaffold-feature | 패턴 로드 → 컨벤션 보일러플레이트 + 테스트 골격 + 영향 체크 |
| "알아서 해줘", "그냥 해줘", "바이브로", "바이브 코딩", "빠르게 그냥 고쳐", "vibe" | vibe | 영향·안전 에이전트 생략, 패턴 선택·최소 검증 유지 |

## 스킬별 등록 문구

### 초기화·정리

| 스킬 | 한국어 | 영어 | 비고 |
|------|--------|------|------|
| harness-init | "하네스 초기화", "하네스 만들어줘", "하네스 다시 초기화", "harness 다시 만들어줘", "프로젝트 분석해서 설정해줘", "이 프로젝트 Claude 설정해줘", "하네스 업데이트", "하네스 보완", "스킬만 다시 생성", "에이전트만 다시 생성", "validator만 다시 실행", "패턴 추출해줘" | "create harness", "initialize harness", "re-initialize harness", "generate project harness", "pattern extract" | `.claude/skills/trace.md`가 없으면 자동 트리거. "빠르게"는 Standard, "심층"·"레거시"·"마이그레이션"은 Full 강제 |
| spec-gate | "명세 명확화", "요구사항 정리해줘", "작업 범위 정해줘", "어디서부터 시작해야 해", "뭐부터 해야 해", "범위 정의해줘", "작업 목표 정리해줘", "시작 전 정리" | "spec gate", "ambiguity check", "scope clarify" | harness-init이 자동 호출하지 않음 |
| harness-clean | "하네스 삭제", "하네스 제거", "harness 지워줘", "초기화 되돌려줘", "harness 롤백" | "harness clean", "harness remove", "harness uninstall" | 삭제 목록 확인 후 진행 |

### 코드 이해

| 스킬 | 한국어 | 영어 |
|------|--------|------|
| find-feature | "결제 관련 파일 어디 있어?", "회원가입 어디서 처리해?", "쿠폰 관련 코드 찾아줘", "배송 로직 어디 있어?", "어디 있어?", "관련 코드 찾아줘", "관련 파일", "코드 어디에?", "찾아줘", "어디서 처리해?", "담당 파일", "담당 클래스" | "find feature" |
| trace-logic | "주문 취소 로직 어디 있어?", "이 API 어떻게 처리돼?", "결제 흐름 보여줘", "로그인 로직 따라가줘", "이 화면 저장 버튼 누르면 뭐가 실행돼?", "처리 흐름 알려줘", "실행 흐름", "로직 흐름", "흐름 추적", "어떻게 동작해?", "동작 방식", "내부 구조" | "trace logic", "flow of" |

### 변경·개발

| 스킬 | 한국어 | 영어 |
|------|--------|------|
| analyze-impact | "영향도 분석", "이거 수정하면 어디 영향?", "이 함수 수정해도 돼?", "이 SQL 바꾸면 어디 영향?", "이 컬럼 추가했을 때 영향", "이 API 변경 영향", "분석해줘 영향", "이거 건드려도 돼?", "어디서 쓰이고 있어?", "이 메서드 호출처" | "impact analysis" |
| safe-modify | "안전하게 수정", "회귀 위험 없이 변경", "이 변경 안전한가?", "변경 전 체크", "이 패치 적용해도 돼?", "운영 패치 검토", "긴급 핫픽스", "이 수정 GO/NO-GO?", "변경 리뷰" + 범용 수정 문구 | "safe modify" |
| scaffold-feature | "[기능명] 기능 추가", "주문 취소 기능 만들어줘", "신규 모듈 생성 컨벤션", "패턴대로 만들어줘", "프로젝트 스타일로 새 기능", "보일러플레이트 생성", "새 API 만들어줘 컨벤션 따라" + 범용 개발 문구 | "scaffold feature" |
| vibe | "알아서 해줘", "그냥 해줘", "바이브로", "바이브 코딩", "빠르게 그냥 고쳐" | "vibe" |
| review-sql | "SQL 리뷰", "이 쿼리 점검", "N+1 확인", "이 쿼리 성능", "인덱스 잘 쓰고 있어?", "이 SQL 안전한가?", "DDL 영향 분석", "이 컬럼 추가해도 돼?", "프로시저 리뷰", "운영 SQL 검토" | "SQL review" |
| plan-migration | "마이그레이션 계획", "Spring Boot로 마이그레이션", "Struts → Spring", "iBatis → MyBatis", "Oracle → PostgreSQL", ".NET Core로 옮겨야 해", "Java 17 업그레이드", "JSP를 React로", "AngularJS → Angular", "마이그레이션 로드맵", "전환 계획", "리프트앤시프트" | "migration plan" |

### wiki

| 스킬 | 한국어 | 영어 |
|------|--------|------|
| generate-wiki | "wiki 만들어줘", "wiki 생성", "문서 wiki", "프로젝트 wiki 생성", "위키 만들어줘", "위키 업데이트", "call graph 시각화", "호출 그래프 wiki" | "generate wiki" |
| publish-wiki | "wiki 발행", "위키 중앙 DB에 올려줘", "wiki 허브에 등록", "시스템 위키 등록", "위키 버전 올려줘", "백엔드 프론트엔드 위키 분리 저장" | "publish wiki" |
| wiki-hub | "위키 허브 띄워줘", "통합 위키 보여줘", "시스템 위키 목록", "wiki 검색", "위키 버전 비교", "이전 버전으로 되돌려줘", "중앙 위키 관리", "DB 위키 보여줘" | "wiki hub" |

### 크로스 리포

| 스킬 | 한국어 | 영어 |
|------|--------|------|
| pair-init | "백엔드 프론트엔드 연결해줘", "페어 설정", "두 프로젝트 연동", "백엔드랑 프론트 같이 분석해줘", "API 계약 추출해줘", "크로스리포 설정", "파트너 프로젝트 등록", "모바일도 추가해줘", "클라이언트 여러 개 연동", "허브형 연동" | "pair init" |
| cross-repo-scaffold | "전체 스택 기능 만들어줘", "백엔드랑 프론트 같이 만들어줘", "API부터 화면까지 만들어줘", "엔드투엔드 기능 추가", "백엔드 API 만들고 프론트 연동해줘" | "full-stack feature", "cross-repo scaffold" |
| cross-repo-modify | "이 기능 개선해줘", "API 필드 추가해줘", "이거 고쳐야 하는데 프론트도 같이", "양쪽 다 수정해줘", "풀스택 수정", "백엔드 프론트 둘 다 고쳐줘", "이 API 바꾸는데 프론트 영향 있으면 같이 처리해줘" | "cross-repo modify" |

## 슬래시 확정 경로

| 별칭 | 위임 대상 | 형식 |
|------|-----------|------|
| `/modify` | safe-modify | `/modify 주문 취소 버튼 오류 고쳐줘` |
| `/impact` | analyze-impact | `/impact ORDER 테이블에 STATUS 컬럼 추가` |
| `/scaffold` | scaffold-feature | `/scaffold 주문 취소 기능` |
| `/find` | find-feature | `/find 결제 승인 처리` |
| `/flow` | trace-logic | `/flow 로그인 처리` |
| `/sql` | review-sql | `/sql SELECT * FROM ORDERS WHERE STATUS = 'N'` |
| `/wiki` | generate-wiki | `/wiki` |

별칭은 절차 없이 args를 그대로 본편 스킬에 전달합니다. 다른 플러그인과 이름이 겹치면 `/ax-navi:safe-modify`처럼 네임스페이스를 붙입니다. `trace-logic`의 별칭이 `/trace`가 아닌 이유는 하네스가 프로젝트마다 로컬 `trace` 스킬을 배포하기 때문입니다.

## 프로젝트 전용 스킬의 트리거

writer가 프로젝트별로 작성하는 `trace`·`find-logic`·`scaffolder`·`cross-repo-*` 로컬 스킬의 트리거는 프로젝트마다 다르며, 한국어 3개 이상 + 영어 2개 이상 + 스택 키워드 1개 이상 규칙으로 생성됩니다. 실제 문구는 대상 프로젝트의 `.claude/skills/*.md`와 `.claude/ito-guide.md`에서 확인하세요.

## 트리거가 안 걸릴 때

- 등록 문구와 표현이 다르면 매칭이 안 될 수 있습니다. 슬래시 확정 경로를 쓰세요.
- `settings.json` hooks로는 트리거를 강제할 수 없습니다. 자세한 내용은 [권한과 도구 제한](/configuration/settings-and-tools.md)을 참고하세요.
- 플러그인 전역 스킬 6종은 업데이트 즉시 새 문구가 반영됩니다. CLAUDE.md 표·ito-guide에 새 이름을 올리려면 "스킬만 다시 생성"을 요청합니다.
- 세션 진입 규약 `AGENTS.md`(모든 프로젝트 동일)가 수정은 safe-modify, 신규는 scaffold-feature, 빠른 처리는 vibe로 가라고 한 번 더 상기시킵니다.

## 관련 문서

- [단축 별칭 7종](/skills/aliases.md)
- [권한과 도구 제한](/configuration/settings-and-tools.md)
- [safe-modify](/skills/safe-modify.md)
- [scaffold-feature](/skills/scaffold-feature.md)
- [vibe](/skills/vibe.md)
- [모범 사례](/getting-started/best-practices.md)
