#!/usr/bin/env node
/*
 * AX Navi Claude Code 플러그인의 훅 — CLI(axnavi) 실행기가 하던 런타임 일을 Claude Code 플러그인 안에서 한다.
 *
 *   node packages/plugin/src/hooks.mjs session-start   SessionStart     인덱스 신선도 확인 · 바뀐 저장소만 다시 만든다
 *   node hooks.mjs prompt          UserPromptSubmit 턴 전 상태 기록 · 평가 횟수 초기화 · 사전 영향도를 맥락으로 넣는다
 *   node hooks.mjs pre-tool        PreToolUse       셸로 소스를 쓰면 승인 요청 · 디스크 전체 검색 차단 · 평가 서브에이전트 1번
 *   node hooks.mjs stop            Stop             UTF-8 로 바뀐 EUC-KR 되돌리기 · 고친 뒤 위치 읽기 화면이 남으면 이어서 처리하게 한다
 *
 * 입력은 stdin 의 훅 JSON, 출력은 Claude Code 훅 규약의 JSON 이다. 어떤 실패도 작업을 막지 않는다 — 훅이 죽으면
 * 아무것도 쓰지 않고 끝낸다(그대로 진행). axnavi CLI 가 띄운 실행(AXNAVI_ENCODING_HOOK=1)에서는 비킨다 — CLI 가 같은
 * 일을 이미 자기 런타임에서 한다.
 *
 * Edit · Write 승인은 Claude Code 자신의 권한 모드에 맡긴다. 여기서 더하는 것은 그 모드가 못 보는 셸 쓰기뿐이다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 플러그인 루트 — 이 파일은 <root>/packages/plugin/src/hooks.mjs 다. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const event = process.argv[2] ?? "";
if (process.env["AXNAVI_ENCODING_HOOK"] === "1") process.exit(0);

/** 이 세션의 상태 폴더(턴 전 상태 · 평가 횟수). */
function stateDir(/** @type {any} */ input) {
  const id = String(input?.session_id || "default").replace(/[^\w.-]/g, "_").slice(0, 80);
  const dir = join(tmpdir(), "axnavi-plugin", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 작업 폴더 + pair_config 의 짝 저장소(인덱스가 있는 것). 첫째가 기준 저장소다. */
function projectRoots(/** @type {string} */ cwd) {
  const found = [resolve(cwd)];
  try {
    const text = readFileSync(join(cwd, "_workspace", "pair_config.md"), "utf8");
    for (const m of text.matchAll(/^partner_root(?:\[\d+\])?:\s*(.+)$/gm)) {
      const value = (m[1] ?? "").trim();
      if (value && value !== "unknown") found.push(resolve(value));
    }
  } catch { /* 짝 설정 없음 */ }
  return [...new Set(found)];
}
const hasIndex = (/** @type {string} */ root) => existsSync(join(root, "_workspace", "index", "_meta.json"));

/** @param {any} input */
async function sessionStart(input) {
  const roots = projectRoots(input?.cwd || process.cwd()).filter(hasIndex);
  if (!roots.length) return null;
  const { ensureFreshIndexes } = await import("../../cli/src/freshness.mjs");
  const notes = ensureFreshIndexes(roots.map((root, i) => ({ root, primary: i === 0 })));
  const rebuilt = notes.filter((n) => n.state === "rebuilt");
  const lines = [
    `AX Navi: 인덱스 ${roots.length}개 확인${rebuilt.length ? ` · 다시 만든 저장소 ${rebuilt.map((n) => n.root.split(/[\\/]/).at(-1)).join(", ")}` : " · 최신"}. 이 세션에서는 build-index --check-stale 을 다시 돌리지 않아도 된다.`,
  ];
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } };
}

/** @param {any} input */
async function prompt(input) {
  const cwd = input?.cwd || process.cwd();
  const dir = stateDir(input);
  const roots = projectRoots(cwd).filter((r) => existsSync(join(r, ".git")) || existsSync(r));
  /* 턴 전 상태 — Stop 이 이번 턴에 바뀐 파일을 가린다 */
  try {
    const { takeSnapshot, serializeSnapshot } = await import("../../cli/src/turn-audit.mjs");
    writeFileSync(join(dir, "snapshot.json"), serializeSnapshot(takeSnapshot(roots)));
  } catch { rmSync(join(dir, "snapshot.json"), { force: true }); }
  /* 평가 서브에이전트 횟수는 요청마다 새로 센다 */
  writeFileSync(join(dir, "review.txt"), "0");
  /* 사전 영향도 */
  const text = String(input?.prompt ?? "");
  if (!hasIndex(cwd) || !text.trim()) return null;
  try {
    const { precomputeImpact } = await import("../../cli/src/precompute.mjs");
    const block = precomputeImpact(cwd, text);
    if (!block) return null;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${block}\n위 사전 영향도는 AX Navi 인덱스의 사실이다. 영향도 · 수정이면 출발점으로 삼아 원문으로 검증 · 보완하라.` } };
  } catch {
    return null;
  }
}

/** @param {any} input */
async function preTool(input) {
  const tool = String(input?.tool_name ?? "");
  const ti = input?.tool_input ?? {};
  if (tool === "Agent" || tool === "Task") {
    const { reviewBudgetDecision } = await import("../../core/src/safety/review-budget.mjs");
    const file = join(stateDir(input), "review.txt");
    let used = 0;
    try { used = Number(readFileSync(file, "utf8")) || 0; } catch { used = 0; }
    const state = { limit: 1, used };
    const decision = reviewBudgetDecision(ti, state);
    if (state.used !== used) writeFileSync(file, String(state.used));
    return decision.hookSpecificOutput ? decision : null;
  }
  if (tool === "Bash" || tool === "PowerShell") {
    const { diskScanDecision } = await import("../../provider-claude-cli/src/disk-scan-guard.mjs");
    const disk = diskScanDecision(ti);
    if (disk.hookSpecificOutput) return disk;
    const { writeGuardDecision } = await import("../../core/src/safety/write-guard.mjs");
    const cwd = input?.cwd || process.cwd();
    const decision = writeGuardDecision(tool, ti, { cwd, roots: projectRoots(cwd), pluginRoot: PLUGIN_ROOT });
    return decision.hookSpecificOutput ? decision : null;
  }
  return null;
}

/** @param {any} input */
async function stop(input) {
  const dir = stateDir(input);
  const file = join(dir, "snapshot.json");
  if (!existsSync(file)) return null;
  const cwd = input?.cwd || process.cwd();
  const { changesSince, deserializeSnapshot, repairEncoding } = await import("../../cli/src/turn-audit.mjs");
  const snap = deserializeSnapshot(readFileSync(file, "utf8"));
  const roots = [...snap.repos.keys()];
  const changes = changesSince(snap, roots);
  if (!changes.length) return null;
  /** @type {string[]} */
  const notes = [];
  for (const n of repairEncoding(snap, changes)) {
    notes.push(n.result === "restored"
      ? `AX Navi: ${n.change.rel} — UTF-8 로 바뀐 것을 원래 인코딩(${n.encoding})으로 되돌려 썼습니다.`
      : `AX Navi: ${n.change.rel} — ${n.encoding} 파일의 ${n.detail ?? "글자가 깨졌습니다"}. git 으로 되돌리기를 권합니다.`);
  }
  const { describePostVerify, postVerify } = await import("../../cli/src/post-verify.mjs");
  const pv = postVerify(snap, changes, roots.filter(hasIndex).map((root, i) => ({ root, primary: root === resolve(cwd) || i === 0 })));
  const lines = describePostVerify(pv, cwd);
  if (pv.verdict === "hold" && !input?.stop_hook_active) {
    /* 한 번만 이어서 처리하게 한다(stop_hook_active 면 다시 막지 않는다 — 무한 반복 방지). */
    return { decision: "block", reason: [...lines, "남은 화면을 함께 고치거나, 고치지 않을 거면 SELECT 변경을 되돌리고 그 사실을 보고하라. 결정을 GO 로 보고하지 마라.", ...notes].join("\n") };
  }
  const message = [...notes, ...(lines.length ? lines.map((l) => `AX Navi: ${l}`) : [])];
  return message.length ? { systemMessage: message.join("\n") } : null;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  /** @type {any} */
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { return; }
  try {
    const handler = { "session-start": sessionStart, prompt, "pre-tool": preTool, stop }[event];
    const out = handler ? await handler(input) : null;
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    /* 훅이 죽어 작업이 막히는 것보다 그대로 진행하는 편이 낫다 */
  }
});
