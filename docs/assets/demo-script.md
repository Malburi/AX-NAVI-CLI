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
| axnavi 판 | 인덱서 **1.20.0 이상**(`axnavi doctor`의 인덱서 줄) — Mapper 연결 · XML 트랜잭션 · XML 빈 · 메시지 라벨 검색이 들어간 판. `v0.1.0-alpha.34` 로는 정답지가 재현되지 않는다 |

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
| 터미널 | Windows Terminal, 창 크기 **120 × 32** |
| 글꼴 | D2Coding 16pt (한글 폭이 맞는 고정폭) |
| 테마 | 어두운 배경 하나로 통일 |
| 경로 | `C:\demo\egov-sample` — 사용자 이름 · 회사 경로가 화면에 나오지 않게 |
| 권한 모드 | 기본값(`자동`). 개발 PC 의 `auto` 설정은 끄고 녹화 |
| 녹화 도구 | [ScreenToGif](https://www.screentogif.com/) — 15fps, 터미널 창만 |

## 컷 대본 (30초)

| 시간 | 화면 | 자막 (화면 하단, 짧게) |
|---|---|---|
| 0–3s | 프롬프트에서 `axnavi` 입력 → 배너 · 인덱스 상태 한 줄 | 처음 보는 전자정부 프로젝트 |
| 3–9s | `/flow 샘플 등록 화면에서 등록 버튼 누르면 뭐가 실행돼?` 를 친다. 복사 붙여넣기 말고 실제로 타이핑 (편집에서 1.5배속) | — |
| 9–14s | 에이전트 활동이 화면 바닥에 흐르는 구간. **빨리감기**, 우상단에 `⏩ 실제 1m 53s` 처럼 그 테이크에서 실제 걸린 시간 표시 (2026-09-29 실측 1분 50초 안팎) | 인덱스를 근거로 추적 중 |
| 14–26s | 결과 — 버튼부터 SQL 까지 흐름이 한 화면에. 4번 트랜잭션, 6번 ID 채번 줄에 차례로 강조 박스 | 코드에 안 보이는 단계까지 |
| 26–30s | 마지막 화면을 멈추고 설치 한 줄을 겹쳐 띄움: `npm i -g …` · `github.com/Malburi/AX-NAVI-CLI` | 5분이면 직접 해 봅니다 |

- 결과가 한 화면(32줄)에 안 들어오면 핵심 줄이 보이는 곳에서 멈춥니다. 스크롤을 넣지 않습니다.
- 자막은 3~4개가 전부입니다. 많으면 결과를 못 읽습니다.
- 마우스 커서는 숨깁니다.

## 편집 규칙

- **빨리감기는 기다리는 구간에만** 씁니다. 빨리감은 구간에는 반드시 실제 시간을 표시합니다.
- **결과 텍스트는 한 글자도 고치지 않습니다.** 강조 박스 · 자막만 덧붙입니다.
- 실패한 테이크를 이어 붙이지 않습니다. 한 번에 끝까지 성공한 실행 하나로 만듭니다.

## 내보내기

| 파일 | 용도 | 기준 |
|---|---|---|
| `docs/assets/demo.gif` | README | 가로 1200px 녹화 → README 에서 820px 표시, **5MB 이하** (넘으면 12fps · 색상 수 줄이기) |
| `docs/assets/demo.mp4` | GeekNews · OKKY · LinkedIn 게시글 | 같은 편집본, 1080p |

## 올리기 전 확인

- [ ] 정답지 7개 단계가 결과에 모두 있다
- [ ] 화면에 사용자 이름 · 사내 경로 · 사내 시스템 이름 · 계정 정보가 없다
- [ ] 빨리감기 구간에 실제 시간 표시가 있다
- [ ] 끝 화면의 설치 명령이 README 의 현재 버전과 같다
- [ ] `README.md` 의 데모 GIF 주석을 풀었다
