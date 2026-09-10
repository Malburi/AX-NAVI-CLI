---
name: add-agent-or-skill
description: AX Navi 저장소(플러그인 소스)에 새 에이전트/스킬을 추가하거나 기존 에이전트를 수정하는 절차. "에이전트 추가해줘", "새 스킬 만들어줘", "에이전트 수정" 요청에 사용한다.
---

에이전트 개선은 `agents/[name].md` 파일을 직접 수정한다.
변경사항은 `docs/changelog.md`의 변경 이력 테이블에 기록한다.

새 에이전트 추가:
1. `agents/[name].md` 작성 (frontmatter + 본문)
2. 호출하는 오케스트레이터 스킬(`skills/<name>/SKILL.md`)에 등록
3. 루트 `CLAUDE.md` 팀 구성 + `docs/role-map.md` + `docs/changelog.md`에 기록

새 스킬 추가:
1. `skills/[name]/SKILL.md` 폴더 + 파일 생성 (frontmatter 필수)
2. 파이프라인 연결 지점 10단계는 `docs/skill-triggers.md` 7절 체크리스트를 따른다 (skills_builder 등록 · ito-guide 템플릿 블록 · CLAUDE.md 표 · validator check2 · plugin.json 카운트 · 패키징 테스트)

완료 전 `node agents/lib/tests/run.js`와 `claude plugin validate . --strict`를 실행한다.
