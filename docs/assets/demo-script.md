# 데모 GIF 녹화 대본 — `/flow` 30초

README 맨 위에 걸 데모입니다. 보여 줄 것은 하나입니다.

> **처음 보는 전자정부 프로젝트에서, 질문 한 줄로 버튼 → SQL 까지 — 코드에 안 보이는 단계까지.**

## 대상 프로젝트

누구나 받아서 똑같이 해 볼 수 있어야 하므로 공개 샘플을 씁니다.

| 항목 | 값 |
|---|---|
| 저장소 | https://github.com/eGovFramework/egovframe-web-sample |
| 커밋 | `8f37555` (녹화 시점 고정 — 다시 녹화할 때도 이 커밋) |
| 흐름 | 샘플 등록 화면의 **등록** 버튼 |
| axnavi 판 | 인덱서 **1.20.0 이상**(`axnavi doctor`의 인덱서 줄) — Mapper 연결 · XML 트랜잭션 · XML 빈 · 메시지 라벨 검색이 들어간 판. `v0.1.0-alpha.35` 이상으로 녹화한다 — `v0.1.0-alpha.34` 이하로는 정답지가 재현되지 않는다 |

```bash
git clone https://github.com/eGovFramework/egovframe-web-sample.git C:\demo\egov-sample
cd C:\demo\egov-sample
git checkout 8f37555
axnavi index build        # 카메라 밖에서 미리 — 녹화에는 넣지 않습니다
```

## 정답지

녹화 전에 한 번 돌려 보고, 결과에 아래가 **모두** 나오는지 확인합니다. 빠진 게 있으면 녹화하지 말고 도구를 고칩니다.
결과 화면을 편집해서 채워 넣지 않습니다.

| # | 단계 | 근거 |
|---|---|---|
| 1 | `sampleAdd()` → `validateSampleVO` → `/addSample.do` 로 submit | `egovSampleRegister.jsp:59` · `:65` |
| 2 | `EgovSampleController.addSample` — `@Valid` 검증, 실패 시 등록 화면으로 | `EgovSampleController.java:125` |
| 3 | `sampleService.insertSample(sampleVO)` | `EgovSampleController.java:134` |
| 4 | **트랜잭션** — `*Impl.*` 전부에 AOP 로 걸림 (코드에 `@Transactional` 없음) | `context-transaction.xml:20` |
| 5 | `EgovSampleServiceImpl.insertSample` | `EgovSampleServiceImpl.java:69` |
| 6 | **ID 채번** — `egovIdGnrService.getNextStringId()`, `IDS` 테이블에서 `SAMPLE-00001` 형식 | `EgovSampleServiceImpl.java:75` · `context-idgen.xml:5` |
| 7 | `SampleMapper.insertSample` → `INSERT INTO SAMPLE (ID, NAME, DESCRIPTION, USE_YN, REG_USER)` | `EgovSample_Sample_SQL.xml:13` |

4번과 6번이 데모의 핵심입니다. Java 코드만 따라가면 안 보이고 XML 설정에만 있는 단계인데, 이걸 짚어 주는 게
"파일을 더듬는 AI"와 다른 점입니다.

## 녹화 환경

| 항목 | 설정 |
|---|---|
| 터미널 | 가상 터미널(ConPTY) 안의 PowerShell, 창 크기 **120 × 50** — 답 전체(약 50줄)가 마지막 화면에 남는 높이 |
| 글꼴 | D2Coding 16pt (한글 폭이 영문 두 칸에 맞는 고정폭) |
| 테마 | monokai |
| 경로 | `C:demoegov-sample` — 사용자 이름 · 회사 경로가 화면에 나오지 않게. `%TEMP%` 아래에 두지 않는다 |
| 권한 모드 | 기본값(`자동`) |
| 녹화 | `rec/record.mjs` 가 사람처럼 한 글자씩 입력하며 출력을 asciicast 로 기록 → `rec/retime.mjs` 가 시간 축만 편집 → [agg](https://github.com/asciinema/agg) 로 GIF |

## 컷 구성 (약 25초)

| 시간 | 화면 |
|---|---|
| 0–6s | 프롬프트에서 `axnavi` 입력 → 배너(판 · 인덱스 준비됨) → `/flow 샘플 등록 화면에서 등록 버튼 누르면 뭐가 실행돼?` 를 실제로 타이핑(1.5배속) |
| 6–16s | 에이전트가 인덱스를 질의하고 원문을 여는 구간. **빨리감기**(약 9배). 화면 바닥의 `logic-tracer · 58s` 같은 경과 시간이 실제 값이다 |
| 16–25s | 결과 — 버튼부터 Controller · Service(ID 채번 `SAMPLE-00001` · 트랜잭션) · SQL 까지 흐름, 찾은 것 · 확인했는데 없는 것 · 확인하지 못한 것. 마지막 화면 8초 정지 |

처음 대본의 자막 · 강조 박스 · 끝 화면 설치 명령은 넣지 않았다. 결과를 읽을 자리를 가리지 않게 했고, 설치 명령은 README 에서 GIF 바로 아래에 있다.

## 편집 규칙

- **빨리감기는 기다리는 구간에만** 쓴다. 빨리감은 구간에도 실제 경과 시간이 화면에 보인다.
- **결과 텍스트는 한 글자도 고치지 않는다.** `retime.mjs` 는 이벤트의 시각만 바꾼다. 원본은 `demo.cast`(편집 전)로 함께 둔다.
- 실패한 테이크를 이어 붙이지 않는다. 한 번에 끝까지 성공한 실행 하나로 만든다.

## 다시 녹화하기

```bash
# 준비(한 번): C:demoegov-sample 에 샘플(8f37555) · C:demo	ools 에 axnavi · C:demoec 에 아래 두 스크립트와 D2Coding.ttf
cd C:demoec && npm i @lydell/node-pty@1
cd C:demoegov-sample && axnavi index build          # 카메라 밖
cd C:demoec
ROWS=50 node record.mjs take.cast                        # 실제 실행을 기록 (약 2분)
node retime.mjs take.cast take-edit.cast 10 7            # 대기 구간만 약 10초로
agg --font-dir fonts --font-family D2Coding --font-size 16 --idle-time-limit 8     --last-frame-duration 8 --fps-cap 15 --theme monokai take-edit.cast demo.gif
```

## 내보내기

| 파일 | 용도 | 기준 |
|---|---|---|
| `docs/assets/demo.gif` | README | 976 × 1142, 25초, 1.3MB (5MB 이하) |
| `docs/assets/demo.cast` | 원본 녹화(편집 전) | 결과를 고치지 않았다는 근거 |
| `demo.mp4` | GeekNews · OKKY · LinkedIn 게시글 | 아직 없음 — 이 PC 에 ffmpeg 가 없다. GIF 로 올리거나 `demo.gif` 를 변환해 만든다 |

## 올리기 전 확인 (2026-09-29 녹화분)

- [x] 정답지 7개 단계가 결과에 모두 있다 — 마지막 화면에 한꺼번에 보인다
- [x] 화면에 사용자 이름 · 사내 경로 · 사내 시스템 이름 · 계정 정보가 없다 — `demo.cast` 전문 검사
- [x] 빨리감기 구간에 실제 시간 표시가 있다 — 화면 바닥 경과 시간
- [x] 판이 README 의 현재 버전과 같다 — 배너 `v0.1.0-alpha.35`
- [x] `README.md` 의 데모 GIF 를 걸었다

---

# /modify — 허락받고 고치기

## 요청

`/modify 카테고리명을 최대 20자까지만 입력되게 해줘` — 기본 자동 모드 그대로.

v0.1.0-alpha.37 부터 자동 모드도 프로젝트 소스 수정은 바뀌는 줄을 보여 주고 묻는다(리포트 쓰기는 묻지 않는다).
그 전 판의 자동 모드는 이 정도 수정을 묻지 않고 고쳐서, 테이크 4 는 `/mode 매번 묻기` 로 찍었다.

## 정답지

| 구분 | 기대 | 근거 |
|---|---|---|
| 바뀜 | `form:input path="name"` 의 `maxlength` 50 → 20 | `egovSampleRegister.jsp:134` |
| 바뀌면 좋음 | `validateSampleVO` 의 `name` 규칙에 `maxlength: 20` (검증기가 지원) | `EgovValidation.js:292` · `:35` |
| 영향도 | 등록 · 수정이 같은 JSP · VO. DB `NAME VARCHAR(50)` 라 DDL 불필요. 초기 데이터 최대 20자 | `sampledb.sql:3` · 114행 |
| 영향도(있으면 좋음) | 기존 회귀 테스트 `EgovSampleRegisterJspMaxLengthTest` 가 "폼 maxlength ≤ DDL 컬럼폭" 을 검사 — 20 ≤ 50 이라 통과 | upstream `747611b` |
| 안 바뀜 | DDL, SQL 매퍼 | |
| 화면 | 고치기 전에 바뀌는 줄과 승인 창 | |

서버 검증(`@Size`)은 요청이 "입력되게"라 범위 밖으로 두는 판단도 맞다 — 이 샘플은 id · regUser 도 화면 `maxlength` 만 쓴다.

## 녹화 기록 (2026-09-29)

| 테이크 | 결과 | 버린 이유 |
|---|---|---|
| 1 | 실패 | Git Bash 가 환경 변수의 `/modify` 를 `C:/Program Files/Git/modify` 로 바꿈 → 질문은 파일로 넘긴다(`QFILE`) |
| 2 · 3 | GO · JSP 1줄 | 승인 창 없음(자동 모드 · `/mode 매번 묻기` 가 켜지지 않던 버그), `find /` 로 2분 낭비 → alpha.36 에서 둘 다 고침 |
| 4 | GO · JSP + JS | 매번 묻기 모드로 찍음(승인 5번, 리포트 쓰기 포함) — alpha.37 이후 기본 모드 녹화로 교체 |
| **5** | **GO · JSP + JS** | 사용. alpha.37 · 기본 자동 모드 · 승인 2번(소스 수정만) · 6분 43초 · $0.72. `find /` 가 지침에도 불구하고 한 번 나옴(120초 제한, 빨리감기 구간) |

## 편집

`rec/retime2.mjs mod5.cast mod5-edit.cast 14 1,2 "변경 내용"` — 소스 수정 승인 두 번(JSP · JS)의 앞뒤만 실제 속도,
나머지 391초를 약 14초로. 최종 보고는 실제 속도 + 8초 정지. 10fps · 40초 · 4.4MB.

