---
name: security-scan
description: 저장소 또는 변경분의 보안 점검. 결정론적 규칙(OWASP Top 10·CWE)으로 의심 지점을 모은 뒤, 치명·높음 항목을 원문으로 확인해 확정/의심/오탐으로 분류하고 심각도·위치·원인·영향·조치 형식의 Findings 리포트를 만든다. "보안 점검", "보안 스캔", "security scan", "취약점 찾아줘", "OWASP 점검", "시큐어코딩 점검", "인젝션 있는지 봐줘", "하드코딩된 비밀번호 찾아줘", "보안 Findings" 요청 시 트리거. 변경분(diff)만 보려면 /review 를 먼저 쓴다. 축약 호출: "보안점검 [경로]".
---

# Security Scan (절차)

analyzer Step 14.5(OWASP Top 10 매핑)를 독립 실행할 수 있게 떼어 낸 절차다.  
1차는 **LLM 없이** `axnavi scan security` 규칙 엔진이 전수로 훑고, 2차에서 치명·높음만 원문으로 확인한다.  
규칙이 놓친 것을 추측으로 채우지 않는다 — 미탐지 ≠ 취약점 없음.

**시크릿 원문 인용 금지:** 비밀번호·키·토큰 값을 리포트·대화에 옮기지 않는다. 위치와 패턴만 적는다(analyzer Step 14.5 와 같은 규칙).  
**코드 수정 금지:** 이 절차는 점검·리포트만 한다. 조치는 사용자가 요청하면 safe-modify 로 진행한다.

---

## Phase 1: 규칙 엔진 실행

대상 범위를 정한다.

| 요청 | 실행 |
|------|------|
| 저장소 전체(기본) | `node "${CLAUDE_PLUGIN_ROOT}/packages/cli/src/bin.mjs" scan security --root "[프로젝트 루트]" --format json --out "[프로젝트 루트]/_workspace/reports/security_scan.json"` |
| 특정 경로 | 위 명령 끝에 경로를 덧붙인다(루트 기준 상대 경로, 여러 개 가능) |
| 이번 변경분 | `node "${CLAUDE_PLUGIN_ROOT}/packages/cli/src/bin.mjs" review --root "[프로젝트 루트]" --format json --out "[프로젝트 루트]/_workspace/reports/review.json"` — 결과의 `findings` 를 같은 방식으로 다룬다 |

결과 JSON 의 `findings[]` 각 항목은 이미 정규화돼 있다.

```json
{"rule": "SEC-SQLI-CONCAT", "title": "SQL 문자열 결합(인젝션 가능)", "severity": "critical",
 "owasp": "A03:2021", "cwe": "CWE-89", "file": "src/.../OrderDao.java", "line": 120,
 "snippet": "…", "impact": "…", "fix": "…"}
```

`suppressed[]` 는 코드에 `axnavi:allow <규칙ID> <사유>` 로 억제된 항목이다. 판정하지 않고 리포트 부록에 사유와 함께 옮긴다.

---

## Phase 2: 치명·높음 원문 확인

`severity` 가 `critical`·`high` 인 항목만 확인한다(중간·낮음은 규칙 판정 그대로 둔다).  
항목마다 `Read` 의 offset/limit 으로 **해당 줄 앞뒤 15줄만** 읽는다. 파일 전체를 읽지 않는다.

같은 규칙·같은 파일에서 반복되는 항목은 대표 1건만 열고 판정을 나머지에 적용한다. 판정이 갈릴 만한 경우에만 2~3건을 더 본다.

| 판정 | 기준 |
|------|------|
| **확정** | 외부 입력(요청 파라미터·화면 입력·외부 응답)이 위험 지점까지 검증 없이 닿는 것이 원문으로 보인다 |
| **의심** | 위험한 구문이지만 입력 출처가 이 범위에서 확인되지 않는다 — 호출자 확인 필요 |
| **오탐** | 상수·내부 값만 쓰인다, 이미 허용 목록 검증이 있다, 테스트 픽스처다 |

입력 출처를 따라가야 하면 인덱스 질의를 쓴다(원본 JSON 을 열지 않는다).

```bash
node "${CLAUDE_PLUGIN_ROOT}/agents/lib/query-index.mjs" callers --root "[프로젝트 루트]" --id "[메서드 id]"
node "${CLAUDE_PLUGIN_ROOT}/agents/lib/query-index.mjs" endpoint --root "[프로젝트 루트]" --path "[경로 일부]"
```

---

## Phase 3: 리포트

`_workspace/reports/security_findings.md` 에 쓴다.

```
=== SECURITY FINDINGS ===

점검 시각: [YYYY-MM-DD HH:MM]
대상: [루트 또는 경로 · 파일 N개]
규칙 엔진 결과: 치명 N · 높음 N · 중간 N · 낮음 N (억제 N)
원문 확인: 치명·높음 N건 중 확정 N · 의심 N · 오탐 N

## OWASP Top 10 분포
| 카테고리 | 확정 | 의심 | 규칙 판정(중간·낮음) |

## 확정
| 심각도 | 위치 | 원인 | 영향 | 조치 | OWASP / CWE |

## 의심 — 확인 필요
| 심각도 | 위치 | 확인할 것 |

## 오탐 — 억제 권고
| 위치 | 규칙 | 사유 | 권장 주석 |
(권장 주석 예: `// axnavi:allow SEC-SQLI-MYBATIS 정렬 컬럼은 SortWhitelist.check 에서 검증`)

## 다루지 않은 것
- A06 의존성 취약점 — npm audit · OWASP Dependency-Check 로 따로 확인
- 비즈니스 로직 인가(A04) — 정적 규칙으로 판정 불가, 수동 검토 권장
```

마지막에 사용자에게 확정 건수와 가장 급한 3건(위치·조치)만 짧게 보고한다.  
CI 에서 같은 규칙으로 막으려면 `axnavi review` 를 머지 요청 단계에 두면 된다(`docs/ci/gitlab-axnavi-review.yml`).
