import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

function read(path) {
  return readFileSync(path, "utf8");
}

function field(text, name) {
  return text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim() || "";
}

function agentFiles() {
  return readdirSync(join(root, "agents"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(root, "agents", name));
}

function skillFiles() {
  return readdirSync(join(root, "skills"))
    .map((name) => join(root, "skills", name, "SKILL.md"))
    .filter((path) => {
      try {
        read(path);
        return true;
      } catch {
        return false;
      }
    });
}

export async function test(register, assert) {
  register("에이전트·스킬 frontmatter의 이름과 모델 계약이 유일하다", () => {
    const agents = agentFiles().map((path) => ({ path, text: read(path) }));
    const skills = skillFiles().map((path) => ({ path, text: read(path) }));
    const agentNames = agents.map(({ text }) => field(text, "name"));
    const skillNames = skills.map(({ text }) => field(text, "name"));

    assert.equal(agents.length, 19);
    assert.equal(skills.length, 24); // 워크플로우 17 + 별칭 7 (modify/impact/scaffold/find/flow/sql/wiki)
    assert.equal(new Set(agentNames).size, agents.length);
    assert.equal(new Set(skillNames).size, skills.length);
    assert.ok(agentNames.every(Boolean), "에이전트 name 누락");
    assert.ok(skillNames.every(Boolean), "스킬 name 누락");
    assert.ok(agents.every(({ text }) => ["sonnet", "opus"].includes(field(text, "model"))), "에이전트 model 누락·오류");
  });

  /*
   * 모델은 별칭으로만 적는다. 정식 ID(claude-sonnet-5 등)를 박아 두면 그 ID 를 허용하지 않는
   * 게이트웨이 조직에서 초기화가 막히고, ANTHROPIC_DEFAULT_SONNET_MODEL 로도 바꿀 수 없다
   * (서브에이전트 frontmatter 의 정식 ID 는 별칭 환경변수가 덮지 못한다 — 실측).
   */
  register("에이전트·스킬은 모델을 별칭으로만 적는다 — 조직이 실제 모델을 정할 수 있게", () => {
    const pinnedId = /claude-(?:haiku|sonnet|opus|fable)-\d/;
    const offenders = [];
    for (const name of readdirSync(join(root, "agents")).filter((n) => n.endsWith(".md"))) {
      if (pinnedId.test(read(join(root, "agents", name)))) offenders.push(`agents/${name}`);
    }
    for (const dir of readdirSync(join(root, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      if (pinnedId.test(read(join(root, "skills", dir.name, "SKILL.md")))) offenders.push(`skills/${dir.name}`);
    }
    assert.equal(offenders.join(", "), "", `정식 모델 ID 가 박혀 있다: ${offenders.join(", ")}`);
  });

  register("초기화와 modify의 메인·위임·재시도 모델은 sonnet 하나로 통일된다", () => {
    const pinned = "sonnet";
    for (const name of ["harness-init", "safe-modify", "analyze-impact", "modify"]) {
      const text = read(join(root, "skills", name, "SKILL.md"));
      assert.equal(field(text, "model"), pinned, `${name} 스킬 모델`);
      const calls = [...text.matchAll(/model="([^"]+)"/g)].map(m => m[1]);
      if (name !== "modify") assert.ok(calls.length > 0, `${name} 호출 모델 누락`);
      assert.ok(calls.every(m => m === pinned), `${name} 호출/재시도 모델 override`);
    }
    for (const name of ["analyzer", "impact-analyzer", "writer"]) {
      assert.equal(field(read(join(root, "agents", `${name}.md`)), "model"), pinned, `${name} 기본 모델`);
    }
    assert.ok(read(join(root, "skills", "modify", "SKILL.md")).includes('Skill(skill="ax-navi:safe-modify"'), "modify 위임 유지");
    const init = read(join(root, "skills", "harness-init", "SKILL.md"));
    assert.ok(/\| Full \| `init` \(A \+ B 전체\) \| sonnet \|/.test(init), "Full 분석 범위 유지");
    const writer = read(join(root, "agents", "writer.md"));
    assert.ok([...writer.matchAll(/^model: (.+)$/gm)].every(m => m[1].trim() === pinned), "생성 에이전트 모델 고정");
  });

  register("매니페스트의 에이전트·스킬 수가 실제 파일 수와 일치한다", () => {
    const plugin = JSON.parse(read(join(root, ".claude-plugin", "plugin.json")));
    const marketplace = JSON.parse(read(join(root, ".claude-plugin", "marketplace.json")));
    assert.ok(plugin.description.includes("19 agents + 17 workflow skills"));
    assert.ok(marketplace.plugins[0].description.includes("19개 에이전트 + 17개 워크플로우 스킬"));
  });

  register("역할 맵이 전체 스킬·에이전트를 포함하고 리포트 경로가 reports로 통일된다", () => {
    const roleMap = read(join(root, "docs", "role-map.md"));
    const sourceTexts = [...agentFiles(), ...skillFiles()].map(read);
    for (const path of [...agentFiles(), ...skillFiles()]) {
      const name = field(read(path), "name");
      assert.ok(roleMap.includes(`\`${name}\``), `역할 맵 누락: ${name}`);
    }
    assert.ok(sourceTexts.every((text) => !/_workspace\/(decoded_|tests_)/.test(text)), "옛 리포트 경로가 남아 있음");
  });

  register("소스를 수정하지 않는 에이전트는 tools 선언으로 Edit 계열 도구를 제외한다", () => {
    const readOnly = ["feature-finder", "logic-tracer", "impact-analyzer", "sql-reviewer", "legacy-decoder", "change-safety",
      "pattern-conformance", "doc-syncer", "harness-evaluator", "qa", "validator", "migration-planner", "spec-clarifier"];
    for (const name of readOnly) {
      const tools = field(read(join(root, "agents", `${name}.md`)), "tools").split(",").map((t) => t.trim());
      assert.ok(tools.length > 0 && tools[0], `${name} tools 선언 누락`);
      for (const banned of ["Edit", "MultiEdit", "NotebookEdit"]) assert.ok(!tools.includes(banned), `${name}가 ${banned}를 허용함`);
      for (const required of ["Read", "Grep", "Glob", "Write"]) assert.ok(tools.includes(required), `${name}에 ${required} 누락`);
    }
    assert.ok(field(read(join(root, "agents", "spec-clarifier.md")), "tools").includes("AskUserQuestion"), "spec-clarifier 인터뷰 도구");
  });

  register("QA/evaluator 계약이 전역 6종 스킬과 Boundary 1~7 운영 모델을 따른다", () => {
    const qa = read(join(root, "agents", "qa.md"));
    const evaluator = read(join(root, "agents", "harness-evaluator.md"));
    const writer = read(join(root, "agents", "writer.md"));
    const rootClaude = read(join(root, "CLAUDE.md"));
    assert.ok(!qa.includes("기존 절차 그대로") && !qa.includes("기존 절차."), "QA boundary에 실행 불가능한 stale 절차가 남음");
    assert.ok(!evaluator.includes("정적 배포 스킬 5종"), "evaluator가 폐기된 로컬 배포 5종 계약을 사용함");
    assert.ok(writer.includes("전역 워크플로우 6종") && writer.includes("프로젝트에 복사하지 않는다"), "writer 전역 스킬 계약");
    assert.ok(rootClaude.includes("Phase 3.7 온디맨드") && rootClaude.includes("Boundary 1~7"), "루트 운영 문서 QA 단계 drift");
  });

  /*
   * 작은 변경은 패턴·안전성 에이전트를 부르지 않고 오케스트레이터가 직접 확인한다. 두 에이전트가 하는
   * 일을 앞 단계와 규칙이 이미 해서, 같은 파일을 한 번 더 읽는 데 각 약 2분이 들었다(실측).
   * 다만 위험 신호가 보이면 반드시 normal 로 올려 독립 검증을 받게 한다 — 이 경로가 사라지면 안 된다.
   */
  register("safe-modify v2: 고친 뒤 평가는 직접 판단이 기본이고, change-safety 는 위험한 변경에서만 한 번 부른다", () => {
    const text = read(join(root, "skills", "safe-modify", "SKILL.md"));
    const phase3 = text.slice(text.indexOf("## Phase 3"), text.indexOf("## Phase 4"));
    assert.ok(phase3.includes("기본은 **직접 판단**"), "직접 판단이 기본이 아니다");
    for (const signal of ["SQL 문자열 결합", "innerHTML", "인증", "트랜잭션", "DDL", "외부 호출", "데이터 변경"]) {
      assert.ok(phase3.includes(signal), `위험 신호 목록에서 빠짐: ${signal}`);
    }
    assert.ok(phase3.includes("해당할 때만 `change-safety` 를 **한 번**"), "평가 서브에이전트를 위험한 변경으로 한정하지 않았다");
    assert.ok(phase3.includes('subagent_type="ax-navi:change-safety"'), "위험한 변경의 안전성 평가 호출이 사라졌다");
    assert.ok(/재평가 · 패턴 대조를 서브에이전트로 다시 부르지 않는다/.test(phase3), "재평가 연쇄를 막지 않는다");
    assert.ok(!text.includes('subagent_type="ax-navi:pattern-conformance"'), "pattern-conformance 서브에이전트를 부른다");
    assert.ok(/orchestrator: true/.test(text) && /review_limit: 1/.test(text), "지휘 절차 · 평가 한도를 frontmatter 로 밝히지 않았다");
  });
}
