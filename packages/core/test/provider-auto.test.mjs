/*
 * auto 연결 순서 — 구독(claude.ai 로그인)은 본인 claude CLI 위임으로만 쓴다.
 * Anthropic 은 승인 없이 제3자 제품(Agent SDK 에이전트 포함)이 구독 로그인을 쓰는 것을 허용하지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUBSCRIPTION_SDK_WARNING, autoChoice, selectProvider, sdkInstalled } from "../../cli/src/provider.mjs";

test("auto — 키가 없으면 SDK 가 깔려 있어도 agent-sdk 가 아니라 claude-cli 를 고른다", () => {
  assert.equal(autoChoice({ hasKey: false, anthropicSdk: true, agentSdk: true, cli: true }), "claude-cli");
  assert.equal(autoChoice({ hasKey: false, anthropicSdk: true, agentSdk: true, cli: false }), null);
});

test("auto — 키가 있으면 Messages API, 그 SDK 가 없으면 agent-sdk(키 인증), 둘 다 없으면 멈춘다", () => {
  assert.equal(autoChoice({ hasKey: true, anthropicSdk: true, agentSdk: true, cli: true }), "anthropic");
  assert.equal(autoChoice({ hasKey: true, anthropicSdk: false, agentSdk: true, cli: true }), "agent-sdk");
  assert.equal(autoChoice({ hasKey: true, anthropicSdk: false, agentSdk: false, cli: true }), null);
});

test("agent-sdk 를 키 없이 명시하면 막지는 않되 구독 정책 경고를 붙인다", { skip: !sdkInstalled() && "Agent SDK 미설치" }, () => {
  const keep = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const sub = selectProvider({ provider: "agent-sdk" });
    assert.ok(!("error" in sub));
    assert.match(sub.short, /구독 로그인\(주의\)/);
    assert.ok(sub.note.includes(SUBSCRIPTION_SDK_WARNING));
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const keyed = selectProvider({ provider: "agent-sdk" });
    assert.ok(!("error" in keyed));
    assert.equal(keyed.short, "agent-sdk · API 키");
    assert.ok(!keyed.note.includes("⚠"));
  } finally {
    if (keep.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = keep.k;
    if (keep.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = keep.t;
  }
});
