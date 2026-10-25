/*
 * 연결 고르기 — 개발자마다 가진 것이 다르다(개인 구독, Team·Enterprise 좌석, API 키, 아무것도 없음).
 * 요금제는 보지 않고 세 경로(구독 로그인 · API 키 · 사내 게이트웨이)로 나눈다.
 * 구독(claude.ai 로그인)은 본인 claude CLI 위임으로만 쓴다 — Anthropic 은 승인 없이 제3자 제품
 * (Agent SDK 에이전트 포함)이 구독 로그인을 쓰는 것을 허용하지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBSCRIPTION_SDK_WARNING, autoChoice, selectProvider, sdkInstalled } from "../../cli/src/provider.mjs";
import { billingLabel, loadAuthPolicy, preferredFromEnv } from "../../cli/src/auth-policy.mjs";
import { delegatedEnv, probeClaudeCli } from "../../provider-claude-cli/src/index.mjs";

const all = { anthropicSdk: true, agentSdk: true, cli: true, login: true, gateway: true };

test("auto — 키 → 구독 로그인 → 게이트웨이 순, 구독에는 Agent SDK 를 쓰지 않는다", () => {
  assert.deepEqual(autoChoice({ ...all, hasKey: true }), { provider: "anthropic", route: "key" });
  assert.deepEqual(autoChoice({ ...all, hasKey: false }), { provider: "claude-cli", route: "subscription" });
  // 로그인 기록이 없으면 구독을 건너뛰고 게이트웨이로 — 설치만 보고 고르면 첫 요청에서 "Not logged in"
  assert.deepEqual(autoChoice({ ...all, hasKey: false, login: false }), { provider: "openai", route: "gateway" });
  assert.deepEqual(autoChoice({ ...all, hasKey: false, cli: false }), { provider: "openai", route: "gateway" });
  assert.equal(autoChoice({ ...all, hasKey: false, cli: false, gateway: false }), null);
  // 폐쇄망 설치(SDK 없음) + 키 → 키를 넘긴 claude CLI
  assert.deepEqual(autoChoice({ ...all, hasKey: true, anthropicSdk: false, agentSdk: false }), { provider: "claude-cli", route: "key" });
  assert.deepEqual(autoChoice({ ...all, hasKey: true, anthropicSdk: false }), { provider: "agent-sdk", route: "key" });
});

test("선호(AXNAVI_AUTH·정책 preferred)가 먼저, 정책이 막은 경로는 건너뛴다", () => {
  assert.deepEqual(autoChoice({ ...all, hasKey: true, preferred: "subscription" }), { provider: "claude-cli", route: "subscription" });
  assert.deepEqual(autoChoice({ ...all, hasKey: true, preferred: "gateway" }), { provider: "openai", route: "gateway" });
  assert.deepEqual(autoChoice({ ...all, hasKey: true, allowed: ["subscription", "gateway"] }), { provider: "claude-cli", route: "subscription" });
  assert.equal(autoChoice({ ...all, hasKey: true, gateway: false, allowed: ["gateway"] }), null);
  assert.deepEqual(preferredFromEnv({ AXNAVI_AUTH: "Subscription" }), { preferred: "subscription" });
  assert.deepEqual(preferredFromEnv({ AXNAVI_AUTH: "auto" }), { preferred: null });
  assert.ok("error" in preferredFromEnv({ AXNAVI_AUTH: "max" }));
});

test("정책 — PC 공용 파일이 정하고 저장소 파일은 좁히기만, 읽지 못하면 실행하지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "ax-policy-"));
  try {
    const machine = join(dir, "machine.json");
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".axnavi"), { recursive: true });
    writeFileSync(machine, JSON.stringify({ allowedRoutes: ["subscription", "gateway"], preferred: "subscription", gateway: { baseUrl: "http://ax.local:8700/v1", model: "hnix-claude" }, message: "기밀 과제는 게이트웨이" }));
    // 저장소가 key 를 넓히려 하고 게이트웨이 주소를 바꾸려 해도 반영되지 않는다
    writeFileSync(join(repo, ".axnavi", "policy.json"), JSON.stringify({ allowedRoutes: ["gateway", "key"], preferred: "key", gateway: { baseUrl: "http://evil.example/v1" } }));
    const r = loadAuthPolicy({ root: repo, env: { AXNAVI_POLICY_FILE: machine } });
    assert.ok("policy" in r);
    assert.deepEqual(r.policy.allowedRoutes, ["gateway"]);
    assert.equal(r.policy.preferred, null); // subscription 은 저장소가 막았으므로 선호도 풀린다
    assert.equal(r.policy.gateway?.baseUrl, "http://ax.local:8700/v1");
    assert.equal(r.policy.sources.length, 2);

    writeFileSync(machine, "{ 깨진 json");
    const bad = loadAuthPolicy({ env: { AXNAVI_POLICY_FILE: machine } });
    assert.ok("error" in bad && /실행하지 않습니다/.test(bad.error));
    writeFileSync(machine, JSON.stringify({ allowedRoutes: ["max-plan"] }));
    assert.ok("error" in loadAuthPolicy({ env: { AXNAVI_POLICY_FILE: machine } }));
    // 파일이 없으면 제약 없음
    const none = loadAuthPolicy({ env: { AXNAVI_POLICY_FILE: join(dir, "없음.json") } });
    assert.ok("policy" in none && none.policy.allowedRoutes.length === 3 && none.policy.sources.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 환경변수를 바꿔 selectProvider 를 부르고 되돌린다
 * @param {Record<string, string | undefined>} vars @param {() => void} fn
 */
function withEnv(vars, fn) {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    return fn();
  } finally {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("게이트웨이만 허용하는 정책 — 정책의 주소와 개발자 키로 연결하고, 다른 경로를 명시하면 이유를 말한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "ax-policy-"));
  try {
    const machine = join(dir, "policy.json");
    writeFileSync(machine, JSON.stringify({ allowedRoutes: ["gateway"], gateway: { baseUrl: "http://ax.local:8700/v1", model: "hnix-local" }, message: "폐쇄망 — 사내 모델만" }));
    const base = { AXNAVI_POLICY_FILE: machine, AXNAVI_OPENAI_BASE_URL: undefined, AXNAVI_OPENAI_MODEL: undefined, AXNAVI_OPENAI_API_KEY: "hx-test", AXNAVI_PROVIDER: undefined, AXNAVI_AUTH: undefined, ANTHROPIC_API_KEY: "sk-ant-test" };
    withEnv(base, () => {
      const picked = selectProvider({});
      assert.ok(!("error" in picked), "error" in picked ? picked.error : "");
      assert.equal(picked.provider.id, "openai");
      assert.equal(picked.route, "gateway");
      assert.match(picked.billing, /조직 과금 \(http:\/\/ax\.local:8700\/v1\)/);
      const blocked = selectProvider({ provider: "anthropic" });
      assert.ok("error" in blocked && /조직 정책에서 허용하지 않습니다/.test(blocked.error) && /폐쇄망/.test(blocked.error));
    });
    withEnv({ ...base, AXNAVI_AUTH: "key" }, () => {
      const r = selectProvider({});
      assert.ok("error" in r && /AXNAVI_AUTH=key/.test(r.error));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("구독을 고르면 위임 프로세스에서 API 키를 뺀다 — claude -p 는 키가 있으면 키를 먼저 쓴다", () => {
  const env = delegatedEnv({ ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "t", PATH: "p" }, { unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, "p");
  assert.equal(delegatedEnv({ ANTHROPIC_API_KEY: "sk" }, {}).ANTHROPIC_API_KEY, "sk");
});

test("AXNAVI_AUTH=subscription + 환경에 API 키 → claude CLI(구독), 키는 넘기지 않는다", { skip: !probeClaudeCli().ok && "claude CLI 없음" }, () => {
  withEnv({ AXNAVI_POLICY_FILE: join(tmpdir(), "ax-없는-정책.json"), AXNAVI_AUTH: "subscription", ANTHROPIC_API_KEY: "sk-ant-test", AXNAVI_PROVIDER: undefined, CLAUDE_CODE_OAUTH_TOKEN: "oauth-test" }, () => {
    const picked = selectProvider({});
    assert.ok(!("error" in picked), "error" in picked ? picked.error : "");
    assert.equal(picked.provider.id, "claude-cli");
    assert.equal(picked.route, "subscription");
    assert.deepEqual(/** @type {any} */ (picked.provider).options.unsetEnv, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    assert.match(picked.billing, /구독 토큰/);
  });
});

test("과금 표시 — Bedrock·Vertex 는 Claude Code 설정을 따라간다", () => {
  assert.match(billingLabel("subscription", { CLAUDE_CODE_USE_BEDROCK: "1" }), /Bedrock/);
  assert.match(billingLabel("subscription", { CLAUDE_CODE_USE_VERTEX: "1" }), /Vertex/);
  assert.match(billingLabel("subscription", {}), /Pro·Max·Team·Enterprise/);
  assert.match(billingLabel("key", { ANTHROPIC_API_KEY: "x" }), /키 주인/);
});

test("agent-sdk 를 키 없이 명시하면 막지는 않되 구독 정책 경고를 붙인다", { skip: !sdkInstalled() && "Agent SDK 미설치" }, () => {
  withEnv({ AXNAVI_POLICY_FILE: join(tmpdir(), "ax-없는-정책.json"), ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, AXNAVI_AUTH: undefined }, () => {
    const sub = selectProvider({ provider: "agent-sdk" });
    assert.ok(!("error" in sub));
    assert.match(sub.short, /구독 로그인\(주의\)/);
    assert.ok(sub.note.includes(SUBSCRIPTION_SDK_WARNING));
    assert.equal(sub.route, "subscription");
  });
  withEnv({ AXNAVI_POLICY_FILE: join(tmpdir(), "ax-없는-정책.json"), ANTHROPIC_API_KEY: "sk-ant-test", AXNAVI_AUTH: undefined }, () => {
    const keyed = selectProvider({ provider: "agent-sdk" });
    assert.ok(!("error" in keyed));
    assert.equal(keyed.short, "agent-sdk · API 키");
    assert.equal(keyed.route, "key");
  });
});
