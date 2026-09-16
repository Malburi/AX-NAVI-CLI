/*
 * 슬래시 명령·자동완성 검증.
 *
 * Tab 키 자체는 TTY에서만 동작해 여기서 눌러 볼 수 없다. 그래서 readline에 넘기는
 * completer 함수와 명령 레지스트리를 순수 함수로 떼어 두고 그쪽을 고정한다 —
 * 실제 skills/ 를 읽어 만들기 때문에 스킬이 추가·삭제되면 여기서 먼저 드러난다.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadAllSkills } from "../src/skills/loader.mjs";
import { firstSentence, buildCommands, complete, menuItems, renderCommandMenu } from "../../cli/src/completion.mjs";
import { computeWindow } from "../../cli/src/autocomplete.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = join(REPO, "skills");

const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  bold: (/** @type {string} */ s) => s,
};

test("스킬 24종이 전부 슬래시 명령으로 산다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  assert.equal(commands.filter((c) => c.kind === "skill").length, 24);
});

test("대화를 다루는 내장 명령이 빠지지 않는다", async () => {
  // 수를 고정하면 명령 하나 늘릴 때마다 테스트를 고쳐야 한다 — 있어야 할 것만 본다.
  const names = new Set(buildCommands(await loadAllSkills(SKILLS))
    .filter((c) => c.kind === "builtin").map((c) => c.name));
  for (const need of ["help", "agents", "skills", "index", "status", "context", "new", "sessions", "resume"]) {
    assert.ok(names.has(need), `/${need} 가 없다`);
  }
});

test("원래 플러그인의 단축 7종이 그대로 슬래시 명령으로 산다", async () => {
  const names = new Set(buildCommands(await loadAllSkills(SKILLS)).map((c) => c.name));
  for (const alias of ["modify", "impact", "scaffold", "find", "flow", "sql", "wiki"]) {
    assert.ok(names.has(alias), `/${alias} 가 없다`);
  }
});

test("`/` 만 치면 전체 목록이 후보로 나온다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const [hits, prefix] = complete("/", { commands, agentNames: [] });
  assert.equal(prefix, "/");
  assert.equal(hits.length, commands.length);
  assert.ok(hits.includes("/help"));
  assert.ok(hits.includes("/modify"));
});

test("접두어로 좁혀진다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const [hits] = complete("/sk", { commands, agentNames: [] });
  assert.deepEqual(hits.sort(), ["/skills"]);

  const [wiki] = complete("/wi", { commands, agentNames: [] });
  assert.deepEqual(wiki.sort(), ["/wiki", "/wiki-hub"]);
});

test("맞는 게 없으면 빈 목록 — 엉뚱한 걸 채워 넣지 않는다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const [hits] = complete("/zzz", { commands, agentNames: [] });
  assert.deepEqual(hits, []);
});

test("/agent 뒤에는 에이전트 이름이 완성된다", () => {
  const ctx = { commands: buildCommands([]), agentNames: ["analyzer", "api-bridge", "qa"] };
  const [hits, prefix] = complete("/agent a", ctx);
  assert.equal(prefix, "a", "치환 대상은 인자 부분이어야 한다");
  assert.deepEqual(hits.sort(), ["analyzer", "api-bridge"]);
});

test("/index 뒤에는 하위 명령이 완성된다", () => {
  const ctx = { commands: buildCommands([]), agentNames: [] };
  const [hits] = complete("/index b", ctx);
  assert.deepEqual(hits, ["build"]);
});

test("슬래시로 시작하지 않으면 완성하지 않는다 — 자연어 입력을 방해하지 않는다", () => {
  const ctx = { commands: buildCommands([]), agentNames: ["analyzer"] };
  const [hits] = complete("주문 취소 로직", ctx);
  assert.deepEqual(hits, []);
});

test("메뉴에 명령·단축·스킬이 모두 들어간다", async () => {
  const menu = renderCommandMenu(buildCommands(await loadAllSkills(SKILLS)), plainUi);
  assert.match(menu, /명령/);
  assert.match(menu, /단축/);
  assert.match(menu, /\/modify/);
  assert.match(menu, /\/harness-init/);
  assert.match(menu, /Tab 자동완성/);
  // 별칭은 스킬 목록에 중복해서 나오지 않아야 한다.
  assert.equal((menu.match(/\/modify/g) ?? []).length, 1);
});

test("모든 스킬이 비지 않은 요약을 갖는다", async () => {
  // safe-modify는 description이 따옴표로 시작한다 — 벗기지 않으면 요약이 빈다.
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const empty = commands.filter((c) => c.kind === "skill" && c.summary.trim().length === 0);
  assert.deepEqual(empty.map((c) => c.name), [], "요약이 빈 스킬이 있다");
});

/* ---------- 인라인 메뉴 ---------- */

test("메뉴 후보에 설명이 함께 온다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const items = menuItems("/fi", { commands, agentNames: [] });
  assert.deepEqual(items.map((i) => i.value).sort(), ["/find", "/find-feature"]);
  assert.ok(items.every((i) => i.hint.length > 0), "설명이 빈 후보가 있다");
});

test("/agent 뒤 인자는 전체 입력으로 채워진다 — 부분 치환이 아니다", () => {
  const items = menuItems("/agent an", { commands: buildCommands([]), agentNames: ["analyzer", "qa"] });
  // 선택 = 입력 자체로 두는 설계라, 채울 값은 줄 전체여야 한다.
  assert.deepEqual(items.map((i) => i.value), ["/agent analyzer"]);
});

test("인자에 공백이 들어가면 제안을 멈춘다 — 자유 입력을 방해하지 않는다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  assert.deepEqual(menuItems("/find 결제 승인", { commands, agentNames: [] }), []);
});

test("창 계산 — 후보가 적으면 전부, 많으면 선택을 가운데 둔다", () => {
  assert.deepEqual(computeWindow(3, 0, 7), { start: 0, end: 3 });
  assert.deepEqual(computeWindow(20, 0, 7), { start: 0, end: 7 }, "맨 위에서는 위로 넘치지 않는다");
  assert.deepEqual(computeWindow(20, 10, 7), { start: 7, end: 14 }, "가운데 정렬");
  assert.deepEqual(computeWindow(20, 19, 7), { start: 13, end: 20 }, "맨 아래에서는 아래로 넘치지 않는다");
});

test("창은 어느 선택에서도 그 항목을 포함한다", () => {
  for (let i = 0; i < 24; i += 1) {
    const { start, end } = computeWindow(24, i, 7);
    assert.ok(i >= start && i < end, `선택 ${i}가 창 [${start},${end}) 밖이다`);
  }
});

/* ---------- 설명 요약 ---------- */

/*
 * 실행 머리말이 "오케스트레이터 스킬 — 에이전트 7종을 지휘한다" 라고 지어낸 적이 있다.
 * 본문에서 긁어모은 에이전트 수였을 뿐 스킬의 설명이 아니었고, 그러면 사용자는
 * frontmatter 에 적혀 있는 진짜 설명을 볼 기회를 잃는다.
 */
test("스킬 설명은 frontmatter 의 첫 문장을 쓴다 — 지어내지 않는다", async () => {
  const skills = await loadAllSkills(SKILLS);
  const init = skills.find((s) => s.name === "harness-init");
  assert.ok(init, "harness-init 을 못 찾았다");
  const summary = firstSentence(/** @type {any} */ (init).description, 120);
  assert.match(summary, /프로젝트를 심층 분석해/);
  assert.ok(!summary.includes("에이전트 7종"), "지어낸 문구가 남아 있다");
});

test("트리거 예시는 잘라 낸다 — 라우팅용이지 사람이 읽을 설명이 아니다", () => {
  const raw = '프로젝트를 분석하는 오케스트레이터. "하네스 초기화", "하네스 만들어줘" 요청 시 사용.';
  const summary = firstSentence(raw, 120);
  assert.match(summary, /오케스트레이터/);
  assert.ok(!summary.includes("하네스 초기화"), "트리거 목록이 그대로 붙었다");
});

test("길이 상한은 자리마다 다르게 준다 — 메뉴는 짧게, 실행 머리말은 길게", () => {
  const long = "가".repeat(200);
  assert.equal(firstSentence(long).length, 47, "메뉴 기본 상한(46자+말줄임)이 아니다");
  assert.equal(firstSentence(long, 120).length, 121);
});

/* ---------- 배포본 무결성 ---------- */

const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

/*
 * 배포된 도구에서 --version 이 거짓말을 하면 버그 제보를 받아도 어느 번호인지 모른다.
 * 실측으로 그랬다 — 배포본은 alpha.1 인데 --version 은 alpha.0 을 말했다.
 */
test("--version 이 package.json 과 같은 곳에서 온다", async () => {
  const bin = readFileSync(fileURLToPath(new URL("../../cli/src/bin.mjs", import.meta.url)), "utf8");
  assert.ok(!/const VERSION = "\d/.test(bin), "버전이 소스에 박혀 있다 — package.json 과 갈라진다");
  assert.match(bin, /readVersion\(\)/);
});

test("배포본에 에이전트·스킬·인덱스 스키마가 들어간다", () => {
  // CLI 는 자기 설치 경로에서 이것들을 읽는다. 빠지면 설치본이 아무것도 못 한다.
  for (const need of ["packages/", "agents/", "skills/", "docs/index-schema/"]) {
    assert.ok(manifest.files.includes(need), `files 에 ${need} 가 없다`);
  }
});

/*
 * 사내망에서 레지스트리가 막혀도 설치는 끝나야 한다.
 *
 * 실측: 이 저장소를 npm 으로 설치하려던 머신에서 GitHub·registry 연결이
 * EACCES 로 끊겼다. 그때 SDK 가 필수 의존이면 설치가 통째로 실패한다 —
 * 정작 주 경로인 claude CLI 위임은 SDK 를 한 줄도 안 쓰는데도.
 */
test("SDK 는 선택적 의존이다 — 없어도 설치가 끝난다", () => {
  assert.ok(!manifest.dependencies?.["@anthropic-ai/sdk"], "SDK 가 필수 의존으로 올라가 있다");
  assert.ok(manifest.optionalDependencies?.["@anthropic-ai/sdk"], "SDK 선언이 아예 없다");
});

test("SDK 를 최상위에서 import 하지 않는다 — 없으면 CLI 가 통째로 안 뜬다", () => {
  const src = readFileSync(fileURLToPath(new URL("../../provider-anthropic/src/index.mjs", import.meta.url)), "utf8");
  assert.ok(!/^import .*@anthropic-ai\/sdk/m.test(src), "정적 import 가 남아 있다");
  assert.match(src, /await import\("@anthropic-ai\/sdk"\)/);
});

test("전역 설치로 부를 이름이 정해져 있다", () => {
  assert.equal(manifest.bin?.axnavi, "packages/cli/src/bin.mjs");
  assert.ok(!manifest.private, "private 면 게시할 수 없다");
});
