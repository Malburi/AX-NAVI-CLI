/*
 * 조직 설정(플랫폼 배포본) — 받은 묶음을 깔고, 정책·MCP·양식·규칙·IDE 에 반영되는지.
 * 요점: 우리가 깐 것만 지우고, 넣을 수 없는 경로는 건너뛰고, 정책은 좁히기만 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectContext, installOrgBundle, loadUserMcpServers, orgRulesText, readOrgState, resolveProjectPaths } from "../src/index.mjs";
import { templateDirs } from "../src/sdlc/templates.mjs";
import { loadAuthPolicy } from "../../cli/src/auth-policy.mjs";
import { pullOrg } from "../../cli/src/org.mjs";

const home = mkdtempSync(join(tmpdir(), "axorg-"));
process.env.AXNAVI_ORG_DIR = join(home, "org");
process.env.AXNAVI_IDE_ROO_DIR = join(home, "roo");
process.env.AXNAVI_TRUST_FILE = join(home, "trusted-mcp.json");
// PC 공용 정책은 없는 위치로
process.env.AXNAVI_POLICY_FILE = join(home, "no-machine-policy.json");

const bundleV1 = {
  hash: "h1",
  profiles: [{ name: "all-company", version: 1 }],
  files: {
    "policy.json": JSON.stringify({ allowedRoutes: ["subscription", "gateway"], preferred: "gateway", gateway: { baseUrl: "http://ax.local:8700/v1" }, message: "조직 정책" }),
    "mcp.json": JSON.stringify({ mcpServers: { hnix: { type: "http", url: "${HNIX_AX_SERVER}/mcp", headers: { Authorization: "Bearer ${HNIX_AX_KEY}" } } } }),
    "templates/sdd.md": "---\nkind: sdd\nrequired: [개요]\n---\n# 조직 설계서\n",
    "rules/coding.md": "# 코딩 규칙\n- SQL 은 바인드 변수로만",
    "skills/sr-fix/SKILL.md": "---\nname: sr-fix\ndescription: SR 절차\n---\n본문",
    "../escape.md": "밖으로",
  },
};

test("배포본 깔기 — 넣을 수 없는 경로는 건너뛰고, IDE 전역 규칙·스킬에도 놓는다", () => {
  const r = installOrgBundle(bundleV1, { server: "http://ax.local:8700" });
  assert.deepEqual(r.skipped, ["../escape.md"]);
  assert.equal(r.written, 5);
  assert.equal(existsSync(join(home, "escape.md")), false);
  assert.equal(readFileSync(join(home, "roo", "rules", "axnavi-org-coding.md"), "utf8"), bundleV1.files["rules/coding.md"]);
  assert.ok(existsSync(join(home, "roo", "skills", "sr-fix", "SKILL.md")));
  const s = readOrgState();
  assert.equal(s.hash, "h1");
  assert.deepEqual(s.ideSkills, ["sr-fix"]);
});

test("정책 — 허용 경로는 좁히고, PC 공용 정책이 없으면 선호·게이트웨이도 조직 배포본을 따른다", () => {
  const r = loadAuthPolicy({ env: process.env });
  assert.ok("policy" in r);
  if (!("policy" in r)) return;
  assert.deepEqual(r.policy.allowedRoutes, ["subscription", "gateway"]);
  assert.equal(r.policy.preferred, "gateway");
  assert.equal(r.policy.gateway?.baseUrl, "http://ax.local:8700/v1");
  // PC 공용 정책이 정한 선호는 조직 배포본이 바꾸지 못한다
  const machine = join(home, "machine-policy.json");
  writeFileSync(machine, JSON.stringify({ preferred: "subscription" }));
  const m = loadAuthPolicy({ env: { ...process.env, AXNAVI_POLICY_FILE: machine } });
  assert.ok("policy" in m && m.policy.preferred === "subscription");
});

test("MCP — 조직 서버는 허용 없이 쓰고, 같은 이름의 저장소 설정은 쓰지 않는다", () => {
  const root = mkdtempSync(join(tmpdir(), "axorgp-"));
  const axnaviDir = join(root, ".axnavi");
  mkdirSync(axnaviDir, { recursive: true });
  const env = { HNIX_AX_SERVER: "http://ax.local:8700", HNIX_AX_KEY: "hx-k" };
  const only = loadUserMcpServers({ axnaviDir }, env);
  assert.deepEqual(only.orgServers, ["hnix"]);
  assert.equal(only.servers["hnix"]?.url, "http://ax.local:8700/mcp");
  assert.equal(only.servers["hnix"]?.headers?.["Authorization"], "Bearer hx-k");
  writeFileSync(join(axnaviDir, "mcp.json"), JSON.stringify({ mcpServers: { hnix: { url: "https://evil/mcp" } } }));
  // 저장소 파일은 허용 전이라 안 쓰이고, 조직 서버는 그대로
  const r = loadUserMcpServers({ axnaviDir }, env);
  assert.equal(r.servers["hnix"]?.url, "http://ax.local:8700/mcp");
});

test("양식·규칙 — 조직 배포본 양식 자리, 에이전트 지침의 <조직 규칙>", () => {
  const dirs = templateDirs({ axnaviDir: join(home, "p", ".axnavi") }, process.env).map((d) => d.label);
  assert.deepEqual(dirs, ["프로젝트", "조직 배포본", "내장"]);
  assert.match(orgRulesText() ?? "", /<조직 규칙>[\s\S]*바인드 변수/);
  const ctx = buildProjectContext({ paths: resolveProjectPaths(mkdtempSync(join(tmpdir(), "axorgc-"))) });
  assert.match(ctx, /<\/프로젝트>\n\n<조직 규칙>/);
});

test("새 배포본 — 빠진 파일·IDE 규칙·스킬은 지우고, 사용자 것은 건드리지 않는다", () => {
  mkdirSync(join(home, "roo", "rules"), { recursive: true });
  writeFileSync(join(home, "roo", "rules", "my-own.md"), "내 규칙");
  const r = installOrgBundle({ hash: "h2", profiles: [{ name: "all-company", version: 2 }], files: { "rules/style.md": "# 스타일" } });
  assert.equal(r.removed, 5);
  assert.equal(existsSync(join(home, "org", "mcp.json")), false);
  assert.equal(existsSync(join(home, "roo", "rules", "axnavi-org-coding.md")), false);
  assert.equal(existsSync(join(home, "roo", "skills", "sr-fix")), false);
  assert.ok(existsSync(join(home, "roo", "rules", "axnavi-org-style.md")));
  assert.ok(existsSync(join(home, "roo", "rules", "my-own.md")));
});

test("받기 — 꺼져 있으면 아무것도 안 하고, 304 면 그대로, 401 은 키 안내", async () => {
  assert.deepEqual(await pullOrg({ env: {} }), { status: "off" });
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const calls = [];
  /** @param {number} status @param {unknown} [body] */
  const fake = (status, body) => /** @type {typeof fetch} */ (async (url, init) => {
    calls.push({ url: String(url), headers: /** @type {Record<string, string>} */ (init?.headers ?? {}) });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  const env = { ...process.env, HNIX_AX_SERVER: "http://ax.local:8700/", HNIX_AX_KEY: "hx-k" };
  const same = await pullOrg({ env, fetchFn: fake(304) });
  assert.equal(same.status, "same");
  assert.equal(calls[0]?.url, "http://ax.local:8700/api/v1/axnavi/bundle");
  assert.equal(calls[0]?.headers["if-none-match"], '"h2"');
  assert.equal(calls[0]?.headers["authorization"], "Bearer hx-k");
  const bad = await pullOrg({ env, fetchFn: fake(401) });
  assert.ok(bad.status === "error" && /HNIX_AX_KEY/.test(bad.message));
  const up = await pullOrg({ env, fetchFn: fake(200, { hash: "h3", profiles: [{ name: "team-a", version: 1 }], files: { "templates/srs.md": "x" } }) });
  assert.ok(up.status === "updated" && up.written === 1);
  assert.equal(readOrgState().hash, "h3");
});
