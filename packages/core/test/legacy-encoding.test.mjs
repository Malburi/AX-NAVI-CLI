/*
 * EUC-KR 등 레거시 인코딩 파일을 읽고 고쳐도 인코딩과 한글이 지켜지는지 검증.
 *
 * 실측: EUC-KR 쿼리 XML 을 Claude 의 Edit 이 UTF-8 로 다시 써서 한글 설명이 전부 U+FFFD 로 사라졌다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeLegacy, encodingPostToolUse, encodingPreToolUse, legacyEncodingOf } from "../../provider-claude-cli/src/legacy-encoding.mjs";
import { delegatedSettings } from "../../provider-claude-cli/src/index.mjs";

// "한글" = C7D1 B1DB, "리스트" = B8AE BDBA C6AE (EUC-KR)
const HANGUL = [0xc7, 0xd1, 0xb1, 0xdb];
const LIST = [0xb8, 0xae, 0xbd, 0xba, 0xc6, 0xae];
const ascii = (/** @type {string} */ s) => [...Buffer.from(s, "latin1")];
const eucKrXml = () => Buffer.from([
  ...ascii('<?xml version="1.0" encoding="EUC-KR"?>\r\n<q>\r\n  <description> '), ...LIST, ...ascii("</description>\r\n  <!-- "), ...HANGUL, ...ascii(" -->\r\n  SELECT A FROM T\r\n</q>\r\n"),
]);

function project() {
  const root = mkdtempSync(join(tmpdir(), "ax-enc-"));
  const file = join(root, "query.xml");
  writeFileSync(file, eucKrXml());
  return { root, file };
}

test("인코딩 판정 — UTF-8·ASCII 는 건드리지 않고, 선언이 없으면 EUC-KR 로 본다", () => {
  assert.equal(legacyEncodingOf(Buffer.from("plain ascii")), null);
  assert.equal(legacyEncodingOf(Buffer.from("한글 UTF-8", "utf8")), null);
  assert.equal(legacyEncodingOf(eucKrXml()), "euc-kr");
  assert.equal(legacyEncodingOf(Buffer.from(HANGUL)), "euc-kr", "선언 없는 레거시");
});

test("EUC-KR 표는 한글을 원래 바이트로 되돌린다", () => {
  const out = encodeLegacy("한글 리스트", "euc-kr");
  assert.ok(out.ok);
  assert.deepEqual([...(/** @type {any} */ (out).bytes)], [...HANGUL, 0x20, ...LIST]);
});

test("읽기는 UTF-8 사본으로 돌리고, 고친 사본은 원본에 EUC-KR 로 되돌려 쓴다 — 다른 한글은 그대로", () => {
  const { root, file } = project();
  try {
    const pre = /** @type {any} */ (encodingPreToolUse({ tool_name: "Read", tool_input: { file_path: file }, cwd: root }));
    const shadow = pre.hookSpecificOutput.updatedInput.file_path;
    assert.ok(shadow.includes(join(".axnavi", "encoding")), "사본이 작업 폴더의 .axnavi/encoding 아래가 아니다");
    const text = readFileSync(shadow, "utf8");
    assert.match(text, /<description> 리스트<\/description>/, "사본에서 한글이 보이지 않는다");

    // Edit 이 사본에 한 일을 흉내 낸다.
    const edited = text.replace("SELECT A FROM T", "SELECT A, B FROM T -- 승인일자");
    assert.ok(/** @type {any} */ (encodingPreToolUse({ tool_name: "Edit", tool_input: { file_path: file }, cwd: root })).hookSpecificOutput.updatedInput.file_path === shadow);
    writeFileSync(shadow, edited, "utf8");
    const post = /** @type {any} */ (encodingPostToolUse({ tool_name: "Edit", tool_input: { file_path: shadow }, cwd: root }));
    assert.match(post.hookSpecificOutput.additionalContext, /euc-kr/);

    const bytes = readFileSync(file);
    assert.equal(legacyEncodingOf(bytes), "euc-kr", "원본이 UTF-8 로 바뀌었다");
    const decoded = new TextDecoder("euc-kr").decode(bytes);
    assert.equal(decoded, edited, "원본에 고친 내용이 그대로 들어가지 않았다");
    assert.ok(!decoded.includes("�"));
    assert.ok(bytes.includes(Buffer.from(LIST)), "기존 한글 바이트가 바뀌었다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("원본이 그대로면 사본을 다시 쓰지 않는다 — 다시 쓰면 Edit 이 '읽은 뒤 바뀌었다' 로 실패한다", () => {
  const { root, file } = project();
  try {
    const first = /** @type {any} */ (encodingPreToolUse({ tool_name: "Read", tool_input: { file_path: file }, cwd: root })).hookSpecificOutput.updatedInput.file_path;
    const before = statSync(first).mtimeMs;
    const again = /** @type {any} */ (encodingPreToolUse({ tool_name: "Edit", tool_input: { file_path: file }, cwd: root })).hookSpecificOutput.updatedInput.file_path;
    assert.equal(again, first);
    assert.equal(statSync(again).mtimeMs, before, "사본을 다시 썼다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EUC-KR 로 쓸 수 없는 글자가 들어가면 원본을 건드리지 않고 사본을 되돌린 뒤 알린다", () => {
  const { root, file } = project();
  try {
    const shadow = /** @type {any} */ (encodingPreToolUse({ tool_name: "Read", tool_input: { file_path: file }, cwd: root })).hookSpecificOutput.updatedInput.file_path;
    const original = readFileSync(file);
    writeFileSync(shadow, readFileSync(shadow, "utf8").replace("SELECT", "SELECT 😀"), "utf8");
    const post = /** @type {any} */ (encodingPostToolUse({ tool_name: "Edit", tool_input: { file_path: shadow }, cwd: root }));
    assert.equal(post.decision, "block");
    assert.match(post.reason, /반영되지 않았습니다/);
    assert.ok(readFileSync(file).equals(original), "원본이 바뀌었다");
    assert.ok(!readFileSync(shadow, "utf8").includes("😀"), "사본을 되돌리지 않았다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UTF-8 파일은 그대로 두고, 왕복되지 않는 깨진 레거시 파일은 읽기만 허용하고 수정은 막는다", () => {
  const root = mkdtempSync(join(tmpdir(), "ax-enc-"));
  try {
    const utf8 = join(root, "a.jsp");
    writeFileSync(utf8, "<p>한글</p>", "utf8");
    assert.deepEqual(encodingPreToolUse({ tool_name: "Edit", tool_input: { file_path: utf8 }, cwd: root }), {});

    const broken = join(root, "b.xml");
    writeFileSync(broken, Buffer.from([...ascii("x "), 0xc7, 0x0a, ...HANGUL])); // 짝 없는 첫 바이트
    const read = /** @type {any} */ (encodingPreToolUse({ tool_name: "Read", tool_input: { file_path: broken }, cwd: root }));
    assert.equal(read.hookSpecificOutput.permissionDecision, "allow");
    const edit = /** @type {any} */ (encodingPreToolUse({ tool_name: "Edit", tool_input: { file_path: broken }, cwd: root }));
    assert.equal(edit.hookSpecificOutput.permissionDecision, "deny");
    assert.match(edit.hookSpecificOutput.permissionDecisionReason, /인코딩 보존 불가/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude -p 설정에 인코딩 훅이 걸리고, 플러그인 훅은 axnavi 실행에서 비킨다", () => {
  const s = /** @type {any} */ (delegatedSettings([], "node fg.mjs", "node enc.mjs"));
  assert.equal(s.hooks.PreToolUse[1].matcher, "Read|Edit|Write|MultiEdit");
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, "node enc.mjs pre");
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, "node enc.mjs post");
  assert.ok(!("PostToolUse" in /** @type {any} */ (delegatedSettings([], "x")).hooks), "명령이 없는데 훅을 걸었다");

  const { root, file } = project();
  try {
    const script = fileURLToPath(new URL("../../provider-claude-cli/src/legacy-encoding-hook.mjs", import.meta.url));
    const input = JSON.stringify({ tool_name: "Read", tool_input: { file_path: file }, cwd: root });
    const plugin = spawnSync(process.execPath, [script, "pre", "plugin"], { input, encoding: "utf8", env: { ...process.env, AXNAVI_ENCODING_HOOK: "1" } });
    assert.equal(plugin.stdout, "", "axnavi 가 이미 건 훅을 플러그인 훅이 한 번 더 했다");
    const direct = spawnSync(process.execPath, [script, "pre", "plugin"], { input, encoding: "utf8", env: { ...process.env, AXNAVI_ENCODING_HOOK: "" } });
    assert.match(JSON.parse(direct.stdout).hookSpecificOutput.updatedInput.file_path, /encoding/, "플러그인 사용자에게 훅이 동작하지 않는다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
