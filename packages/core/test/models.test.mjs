/*
 * 조직이 정한 모델을 따르는가, 그리고 못 쓰는 모델을 만나면 무엇을 하라고 알려 주는가.
 *
 * 실측: 사내 게이트웨이 PC 에서 harness-init 이 이렇게 막혔다.
 *
 *   API Error: 400 'claude-sonnet-5' 모델은 사용할 수 없습니다.
 *   사용 가능한 모델: claude-haiku-4-5-20251001, claude-opus-4-7, claude-opus-4-8, claude-sonnet-4-6
 *
 * 지킬 선
 * - 자동으로 바꿔 끼우지 않는다. 안내만 한다 — 어떤 모델로 대신할지는 조직의 결정이다.
 * - 두 실행 경로가 같은 등급에서 같은 조직 설정을 따른다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelUnavailableHint, suggestMapping } from "../../cli/src/models.mjs";
import { modelForTier } from "../../provider-anthropic/src/index.mjs";

const REAL =
  "API Error: 400 'claude-sonnet-5' 모델은 사용할 수 없습니다. 사용 가능한 모델: " +
  "claude-haiku-4-5-20251001, claude-opus-4-7, claude-opus-4-8, claude-sonnet-4-6";

test("실제로 겪은 오류에서 계열별로 가장 새 모델을 고른다", () => {
  const offered = ["claude-haiku-4-5-20251001", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"];
  assert.deepEqual(suggestMapping(offered), [
    { env: "ANTHROPIC_DEFAULT_SONNET_MODEL", model: "claude-sonnet-4-6" },
    { env: "ANTHROPIC_DEFAULT_OPUS_MODEL", model: "claude-opus-4-8" },
    { env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", model: "claude-haiku-4-5-20251001" },
  ]);
});

test("날짜 꼬리는 버전으로 세지 않는다", () => {
  const [pick] = suggestMapping(["claude-sonnet-4-6", "claude-sonnet-4-5-20250929"]);
  assert.equal(pick?.model, "claude-sonnet-4-6", "날짜가 큰 쪽을 새 모델로 봤다");
});

test("오류를 알아보고 붙여 넣을 설정을 그대로 보여 준다", () => {
  const lines = modelUnavailableHint(REAL);
  assert.ok(lines, "모델 오류를 못 알아봤다");
  const text = lines.join("\n");
  assert.match(text, /claude-sonnet-5 를/, "막힌 모델을 밝히지 않았다");
  assert.match(text, /"ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6"/);
  assert.match(text, /"ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8"/);
  assert.match(text, /조직이 정합니다/, "자동으로 정한 것처럼 보이면 안 된다");
});

test("붙여 넣을 설정은 올바른 JSON 조각이다", () => {
  const lines = modelUnavailableHint(REAL) ?? [];
  const start = lines.findIndex((l) => l.trim() === "\"env\": {");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "}");
  const body = lines.slice(start + 1, end).join("\n");
  assert.doesNotThrow(() => JSON.parse(`{${body}}`), "쉼표·따옴표가 틀려 그대로 붙이면 설정이 깨진다");
});

test("영어 API 오류도 알아본다", () => {
  assert.ok(modelUnavailableHint("400 model: claude-sonnet-5 is not available for your organization"));
  assert.ok(modelUnavailableHint("invalid model 'claude-x'"));
});

test("목록이 없으면 어떤 변수를 쓰는지만 알려 준다", () => {
  const lines = modelUnavailableHint("모델은 사용할 수 없습니다") ?? [];
  assert.match(lines.join("\n"), /ANTHROPIC_DEFAULT_SONNET_MODEL/);
});

test("모델과 상관없는 오류에는 끼어들지 않는다", () => {
  for (const reason of ["API Error: 529 Overloaded", "rate limit exceeded", "ENOENT: no such file", ""]) {
    assert.equal(modelUnavailableHint(reason), null, reason);
  }
});

test("API 키 경로도 조직이 정한 모델을 따른다 — 두 경로가 같은 등급에서 달라지면 안 된다", () => {
  const env = {
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_OPUS_MODEL: " claude-opus-4-8 ",
  };
  assert.equal(modelForTier("standard", env), "claude-sonnet-4-6");
  assert.equal(modelForTier("deep", env), "claude-opus-4-8", "앞뒤 공백을 안 걸렀다");
  assert.equal(modelForTier("fast", env), "claude-haiku-4-5", "지정이 없으면 기본값");
  assert.equal(modelForTier("standard", {}), "claude-sonnet-5");
  assert.equal(modelForTier("standard", { ANTHROPIC_DEFAULT_SONNET_MODEL: "  " }), "claude-sonnet-5", "빈 값을 모델로 썼다");
});
