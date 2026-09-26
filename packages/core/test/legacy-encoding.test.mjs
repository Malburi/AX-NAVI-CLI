/*
 * EUC-KR 등 레거시 인코딩 파일을 읽고 고쳐도 인코딩과 한글이 지켜지는지 검증.
 *
 * 실측: EUC-KR 쿼리 XML 을 Claude 의 Edit 이 UTF-8 로 다시 써서 한글 설명이 전부 U+FFFD 로 사라졌다.
 * 첫 방식(경로를 사본으로 바꿈)은 Edit 이 "읽지 않았다" 로 실패하고 승인 창을 건너뛰어, 도구가 도는 동안만
 * 제자리에서 UTF-8 로 바꿨다가 되돌리는 방식으로 바꿨다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeLegacy,
  encodeLegacy,
  encodingCleanup,
  encodingPostToolUse,
  encodingPreToolUse,
  legacyEncodingOf,
  restoreAll,
  stateFor,
} from "../../provider-claude-cli/src/legacy-encoding.mjs";
import { delegatedSettings } from "../../provider-claude-cli/src/index.mjs";

// "한글" = C7D1 B1DB, "리스트" = B8AE BDBA C6AE (EUC-KR)
const HANGUL = [0xc7, 0xd1, 0xb1, 0xdb];
const LIST = [0xb8, 0xae, 0xbd, 0xba, 0xc6, 0xae];
const ascii = (/** @type {string} */ s) => [...Buffer.from(s, "latin1")];
const eucKrXml = () => Buffer.from([
  ...ascii('<?xml version="1.0" encoding="EUC-KR"?>\r\n<q>\r\n  <description> '), ...LIST, ...ascii("</description>\r\n  <!-- "), ...HANGUL, ...ascii(" -->\r\n  SELECT A FROM T\r\n</q>\r\n"),
]);

function project(bytes = eucKrXml(), name = "query.xml") {
  const root = mkdtempSync(join(tmpdir(), "ax-enc-"));
  const file = join(root, name);
  writeFileSync(file, bytes);
  return { root, file };
}
const ev = (/** @type {string} */ tool, /** @type {string} */ file, /** @type {string} */ cwd) => ({ tool_name: tool, tool_input: { file_path: file }, cwd });

test("인코딩 판정 — UTF-8·ASCII·바이너리는 건드리지 않고, 선언이 없으면 EUC-KR 로 본다", () => {
  assert.equal(legacyEncodingOf(Buffer.from("plain ascii")), null);
  assert.equal(legacyEncodingOf(Buffer.from("한글 UTF-8", "utf8")), null);
  assert.equal(legacyEncodingOf(eucKrXml()), "euc-kr");
  assert.equal(legacyEncodingOf(Buffer.from(HANGUL)), "euc-kr", "선언 없는 레거시");
  assert.equal(legacyEncodingOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xc7]), "a.png"), null, "이미지를 텍스트로 풀었다");
  assert.equal(legacyEncodingOf(Buffer.from([0xc7, 0xd1, 0x00, 0x01]), "a.bin"), null, "NUL 이 있는 파일을 텍스트로 풀었다");
  assert.equal(legacyEncodingOf(Buffer.from('<%@ page pageEncoding="EUC-KR" %><p>x</p>')), "euc-kr", "한글이 아직 없는 EUC-KR 선언 파일을 UTF-8 로 봤다");
  const mostlyUtf8 = Buffer.concat([Buffer.from("가나다라마바사아자차카타파하".repeat(20), "utf8"), Buffer.from([0xc7])]);
  assert.equal(legacyEncodingOf(mostlyUtf8), null, "떠도는 바이트 하나로 UTF-8 파일 전체를 EUC-KR 로 풀었다");
});

test("CP949 확장 한글(갂·똠·햏)까지 원래 바이트로 풀고 묶는다", () => {
  assert.deepEqual([.../** @type {any} */ (encodeLegacy("한글 리스트", "euc-kr")).bytes], [...HANGUL, 0x20, ...LIST]);
  const ext = /** @type {any} */ (encodeLegacy("갂똠햏", "euc-kr"));
  assert.ok(ext.ok, "확장 한글을 묶지 못했다");
  assert.deepEqual([...ext.bytes].slice(0, 2), [0x81, 0x41], "갂 = 0x8141 (MS949)");
  assert.equal(decodeLegacy(ext.bytes, "euc-kr"), "갂똠햏", "확장 한글이 왕복되지 않는다");
});

test("Big5·Shift_JIS 는 원본에 흔한 조합으로 묶는다", () => {
  assert.deepEqual([.../** @type {any} */ (encodeLegacy("十", "big5")).bytes], [0xa4, 0x51], "Big5 十 은 A451");
  assert.deepEqual([.../** @type {any} */ (encodeLegacy("髙", "shift_jis")).bytes], [0xfb, 0xfc], "IBM 확장 한자는 ED/EE 행이 아니라 FA–FC 행");
});

test("읽기 — 도는 동안만 UTF-8 이고, 끝나면 원본 바이트와 수정 시각이 그대로다", () => {
  const { root, file } = project();
  try {
    const before = readFileSync(file);
    const mtime = Math.floor(statSync(file).mtimeMs); // Claude 는 ms 단위로 본다
    assert.deepEqual(encodingPreToolUse(ev("Read", file, root)), {}, "읽기에 허용·거부를 내렸다 — 승인 흐름은 평소대로여야 한다");
    assert.match(readFileSync(file, "utf8"), /<description> 리스트<\/description>/, "도는 동안 한글이 UTF-8 로 보이지 않는다");
    assert.equal(Math.floor(statSync(file).mtimeMs), mtime, "변환하며 수정 시각이 바뀌었다 — Edit 이 '읽은 뒤 바뀌었다' 로 막힌다");
    encodingPostToolUse(ev("Read", file, root));
    assert.ok(readFileSync(file).equals(before), "원본 바이트가 바뀌었다");
    assert.equal(Math.floor(statSync(file).mtimeMs), mtime);
    assert.ok(!existsSync(stateFor(file, root).marker), "표식이 남았다");
    assert.match(readFileSync(join(root, ".axnavi", ".gitignore"), "utf8"), /^encoding\/$/m, "백업 폴더를 커밋에서 빼지 않았다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("수정 — 고친 내용을 원래 인코딩으로 쓰고, 다른 한글은 그대로 둔다", () => {
  const { root, file } = project();
  try {
    encodingPreToolUse(ev("Edit", file, root));
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace("SELECT A FROM T", "SELECT A, B FROM T -- 승인일자"), "utf8"); // Edit 이 한 일
    const post = /** @type {any} */ (encodingPostToolUse(ev("Edit", file, root)));
    assert.match(post.hookSpecificOutput.additionalContext, /euc-kr/);
    const bytes = readFileSync(file);
    assert.equal(legacyEncodingOf(bytes), "euc-kr", "원본이 UTF-8 로 바뀌었다");
    assert.equal(decodeLegacy(bytes, "euc-kr"), text.replace("SELECT A FROM T", "SELECT A, B FROM T -- 승인일자"));
    assert.ok(bytes.includes(Buffer.from(LIST)), "기존 한글 바이트가 바뀌었다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("한글 주석을 지워 ASCII 만 남아도 수정이 되살아나지 않는다(옛 사본이 원본을 덮던 결함)", () => {
  const { root, file } = project();
  try {
    encodingPreToolUse(ev("Edit", file, root));
    writeFileSync(file, "SELECT 1\r\n", "utf8");
    encodingPostToolUse(ev("Edit", file, root));
    assert.equal(readFileSync(file, "latin1"), "SELECT 1\r\n", "방금 한 수정이 사라졌다");
    // 다음 수정은 이제 UTF-8/ASCII 파일이라 변환하지 않는다 — 원본을 그대로 둔다
    encodingPreToolUse(ev("Edit", file, root));
    writeFileSync(file, "SELECT 2\r\n", "utf8");
    encodingPostToolUse(ev("Edit", file, root));
    assert.equal(readFileSync(file, "latin1"), "SELECT 2\r\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EUC-KR 로 쓸 수 없는 글자가 들어가면 원본으로 되돌리고 모델에게 알린다", () => {
  const { root, file } = project();
  try {
    const original = readFileSync(file);
    encodingPreToolUse(ev("Edit", file, root));
    writeFileSync(file, readFileSync(file, "utf8").replace("SELECT", "SELECT 😀"), "utf8");
    const post = /** @type {any} */ (encodingPostToolUse(ev("Edit", file, root)));
    assert.equal(post.decision, "block");
    assert.match(post.reason, /반영되지 않았습니다/);
    assert.ok(readFileSync(file).equals(original), "원본으로 되돌리지 않았다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("도구가 실패·거부되거나 끝나면 남은 변환을 되돌린다", () => {
  const { root, file } = project();
  try {
    const original = readFileSync(file);
    encodingPreToolUse(ev("Edit", file, root));
    assert.ok(!readFileSync(file).equals(original), "변환되지 않았다");
    encodingCleanup(ev("Edit", file, root)); // PostToolUseFailure·PermissionDenied
    assert.ok(readFileSync(file).equals(original), "실패한 도구 뒤에 UTF-8 로 남았다");
    encodingPreToolUse(ev("Read", file, root));
    encodingCleanup({ cwd: root }); // Stop·SessionEnd
    assert.ok(readFileSync(file).equals(original), "종료 때 되돌리지 않았다");
    encodingPreToolUse(ev("Read", file, root));
    restoreAll(root); // 실행 종료 시 provider 가 부른다
    assert.ok(readFileSync(file).equals(original));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("저장소에 심은 표식으로 밖의 파일을 덮어쓰지 못한다", () => {
  const { root } = project();
  const outside = mkdtempSync(join(tmpdir(), "ax-enc-out-"));
  try {
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "SAFE");
    const planted = join(root, ".axnavi", "encoding", "x.json");
    mkdirSync(join(root, ".axnavi", "encoding"), { recursive: true });
    writeFileSync(planted, JSON.stringify({ file: victim, encoding: "euc-kr", utf8Hash: "x", legacyHash: "y" }));
    writeFileSync(planted.replace(/\.json$/, ".orig"), "PWNED");
    restoreAll(root);
    assert.equal(readFileSync(victim, "utf8"), "SAFE", "심은 표식이 밖의 파일을 덮었다");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("왕복되지 않는 깨진 파일과 너무 큰 파일은 읽기만 두고 수정은 막는다", () => {
  const root = mkdtempSync(join(tmpdir(), "ax-enc-"));
  try {
    const broken = join(root, "b.xml");
    writeFileSync(broken, Buffer.from([...ascii("x "), 0xc7, 0x0a, ...HANGUL, 0xff, 0xff]));
    assert.deepEqual(encodingPreToolUse(ev("Read", broken, root)), {});
    const edit = /** @type {any} */ (encodingPreToolUse(ev("Edit", broken, root)));
    assert.equal(edit.hookSpecificOutput.permissionDecision, "deny");
    assert.match(edit.hookSpecificOutput.permissionDecisionReason, /인코딩 보존 불가/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("원본에 되돌려 쓰지 못하면(읽기 전용) 조용히 넘기지 않고 알린다", { skip: process.platform !== "win32" && process.getuid?.() === 0 }, () => {
  const { root, file } = project();
  try {
    encodingPreToolUse(ev("Edit", file, root));
    writeFileSync(file, readFileSync(file, "utf8").replace("SELECT", "SELECT B,"), "utf8");
    chmodSync(file, 0o444);
    const post = /** @type {any} */ (encodingPostToolUse(ev("Edit", file, root)));
    assert.equal(post.decision, "block", "쓰기 실패를 삼켰다");
    assert.match(post.reason, /되돌려 쓰지 못했습니다/);
  } finally {
    try { chmodSync(file, 0o666); } catch { /* 없음 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude -p 설정에 인코딩 훅과 뒷정리 훅이 걸리고, 플러그인 훅은 axnavi 실행에서 비킨다", () => {
  const s = /** @type {any} */ (delegatedSettings([], "node fg.mjs", "node enc.mjs"));
  assert.equal(s.hooks.PreToolUse[1].matcher, "Read|Edit|Write|MultiEdit");
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, "node enc.mjs pre");
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, "node enc.mjs post");
  for (const e of ["PostToolUseFailure", "PermissionDenied", "Stop", "SessionEnd"]) assert.equal(s.hooks[e][0].hooks[0].command, "node enc.mjs cleanup", `${e} 뒷정리가 없다`);
  assert.ok(!("PostToolUse" in /** @type {any} */ (delegatedSettings([], "x")).hooks), "명령이 없는데 훅을 걸었다");

  const plugin = JSON.parse(readFileSync(new URL("../../../hooks/hooks.json", import.meta.url), "utf8"));
  for (const e of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "SessionEnd"]) assert.ok(plugin.hooks[e], `플러그인 훅에 ${e} 가 없다`);

  const { root, file } = project();
  try {
    const original = readFileSync(file);
    const script = fileURLToPath(new URL("../../provider-claude-cli/src/legacy-encoding-hook.mjs", import.meta.url));
    const input = JSON.stringify(ev("Read", file, root));
    spawnSync(process.execPath, [script, "pre", "plugin"], { input, encoding: "utf8", env: { ...process.env, AXNAVI_ENCODING_HOOK: "1" } });
    assert.ok(readFileSync(file).equals(original), "axnavi 가 이미 건 훅을 플러그인 훅이 한 번 더 했다");
    spawnSync(process.execPath, [script, "pre", "plugin"], { input, encoding: "utf8", env: { ...process.env, AXNAVI_ENCODING_HOOK: "" } });
    assert.match(readFileSync(file, "utf8"), /리스트/, "플러그인 사용자에게 훅이 동작하지 않는다");
    spawnSync(process.execPath, [script, "post", "plugin"], { input, encoding: "utf8", env: { ...process.env, AXNAVI_ENCODING_HOOK: "" } });
    assert.ok(readFileSync(file).equals(original), "플러그인 훅이 되돌리지 않았다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
