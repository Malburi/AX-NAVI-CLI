/*
 * 이 환경에서 쓸 수 있는 모델을 스스로 찾아 쓰는가.
 *
 * 실측: 사내 게이트웨이·Bedrock PC 에서 첫 질문부터 이렇게 막혔다.
 *
 *   API Error: 400 'claude-sonnet-5' 모델은 사용할 수 없습니다.
 *   사용 가능한 모델: claude-haiku-4-5-20251001, claude-opus-4-7, claude-opus-4-8, claude-sonnet-4-6
 *
 * 지킬 선
 * - 사용자가 설정을 만지지 않아도 같은 계열의 쓸 수 있는 모델로 돈다.
 * - 조직·사용자가 직접 정한 값은 덮지 않는다.
 * - 배운 것은 환경별로 기억하고, 오래되면 버린다(막혔던 모델이 나중에 열릴 수 있다).
 * - 두 실행 경로가 같은 등급에서 같은 모델을 쓴다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLearnedModels, environmentKey, learnFromError, modelUnavailableHint, suggestMapping } from "../../cli/src/models.mjs";
import { modelForTier } from "../../provider-anthropic/src/index.mjs";

/** @param {(store: string) => void} fn */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "models-"));
  try {
    fn(join(dir, "models.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
});

test("모델이 막히면 같은 계열의 쓸 수 있는 모델을 배워 환경변수에 얹는다", () => {
  withStore((storePath) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    const learned = learnFromError(REAL, { env, storePath, ours: new Set() });
    assert.ok(learned, "배우지 못했다");
    assert.equal(learned.rejected, "claude-sonnet-5");
    assert.equal(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-4-6");
    assert.equal(env["ANTHROPIC_DEFAULT_OPUS_MODEL"], "claude-opus-4-8");
    assert.equal(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "claude-haiku-4-5-20251001");
  });
});

test("배운 모델은 다음 실행에서 처음부터 쓴다 — 다시 막히지 않는다", () => {
  withStore((storePath) => {
    learnFromError(REAL, { env: {}, storePath, ours: new Set(), now: 1000 });
    /** @type {NodeJS.ProcessEnv} */
    const next = {};
    const applied = applyLearnedModels({ env: next, storePath, now: 2000 });
    assert.equal(next["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-4-6");
    assert.equal(Object.keys(applied).length, 3);
  });
});

test("오래된 기억은 버린다 — 막혔던 모델이 열렸는데 계속 옛 모델로 돌면 안 된다", () => {
  withStore((storePath) => {
    learnFromError(REAL, { env: {}, storePath, ours: new Set(), now: 0 });
    /** @type {NodeJS.ProcessEnv} */
    const later = {};
    assert.deepEqual(applyLearnedModels({ env: later, storePath, now: 8 * 24 * 3600 * 1000 }), {});
    assert.equal(later["ANTHROPIC_DEFAULT_SONNET_MODEL"], undefined);
  });
});

test("사용자가 직접 정한 값은 덮지 않는다", () => {
  withStore((storePath) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
    };
    // 바꿀 수 있는 게 하나도 없으면 null — 호출부는 다시 돌리지 않고 안내를 보여 준다.
    assert.equal(learnFromError(REAL, { env, storePath, ours: new Set() }), null);
    assert.equal(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-5", "사용자 값을 덮었다");

    /** @type {NodeJS.ProcessEnv} */
    const pinned = { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6" };
    applyLearnedModels({ env: pinned, storePath });
    assert.equal(pinned["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-4-6");
  });
});

test("우리가 얹은 값은 새로 배운 값으로 바꾼다", () => {
  withStore((storePath) => {
    const ours = new Set(["ANTHROPIC_DEFAULT_SONNET_MODEL"]);
    /** @type {NodeJS.ProcessEnv} */
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5" };
    assert.ok(learnFromError(REAL, { env, storePath, ours }));
    assert.equal(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-4-6");
  });
});

test("같은 모델을 이미 쓰고 있으면 다시 돌리지 않는다 — 같은 오류가 되풀이된다", () => {
  withStore((storePath) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    const ours = new Set();
    assert.ok(learnFromError(REAL, { env, storePath, ours }));
    assert.equal(learnFromError(REAL, { env, storePath, ours }), null);
  });
});

test("계열이 아예 없으면 가까운 계열로 채운다", () => {
  const mapping = suggestMapping(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  assert.deepEqual(mapping.find((m) => m.env === "ANTHROPIC_DEFAULT_OPUS_MODEL"), {
    env: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    model: "claude-sonnet-4-6",
  });
});

test("연결 대상이 다르면 따로 배운다", () => {
  assert.notEqual(
    environmentKey({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "ap-northeast-2" }),
    environmentKey({ ANTHROPIC_BASE_URL: "https://gw.example" }),
  );
  assert.equal(environmentKey({}), "default");
  withStore((storePath) => {
    learnFromError(REAL, { env: { CLAUDE_CODE_USE_BEDROCK: "1" }, storePath, ours: new Set() });
    /** @type {NodeJS.ProcessEnv} */
    const other = {};
    assert.deepEqual(applyLearnedModels({ env: other, storePath }), {}, "다른 환경의 기억을 썼다");
    assert.ok(readFileSync(storePath, "utf8").includes("bedrock"));
  });
});

test("목록이 없는 모델 오류는 배울 수 없다 — 안내로 넘긴다", () => {
  withStore((storePath) => {
    assert.equal(learnFromError("모델은 사용할 수 없습니다", { env: {}, storePath, ours: new Set() }), null);
  });
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
