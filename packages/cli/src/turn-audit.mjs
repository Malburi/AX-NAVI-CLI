/*
 * 턴 뒤 감사 — 마지막 방어선.
 *
 * 승인 게이트(write-guard)는 명령을 글자로 본다. 글자로 못 알아보는 쓰기(빌드 도구가 소스를 고치는 경우,
 * 모델이 만든 스크립트가 다시 스크립트를 부르는 경우 등)는 남는다. 그래서 턴이 끝나면 실제 파일을 본다:
 * 턴 전 git 상태와 비교해 **바뀐 소스 파일 중 승인받지 않은 것**을 사람에게 보여 주고 되돌릴지 묻는다.
 *
 * 같은 자리에서 레거시 인코딩을 지킨다. 셸로 고치면 EUC-KR 보존 훅을 거치지 않는다 — 원래 EUC-KR 이던 파일이
 * UTF-8 로 바뀌었으면 손실 없이 EUC-KR 로 되돌려 쓴다. 이미 글자가 깨졌으면(U+FFFD) 알리고 되돌리기를 권한다.
 *
 * git 저장소가 아니면 감사하지 않는다(기준이 없다) — 그 사실을 숨기지 않고 알린다.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { classifyTarget } from "../../core/src/safety/write-guard.mjs";
import { decodeLegacy, encodeLegacy, legacyEncodingOf } from "../../provider-claude-cli/src/legacy-encoding.mjs";

/** 턴 전 내용을 들고 있을 파일 하나 · 전체 상한. 넘으면 해시만 든다(되돌리기는 git HEAD 로만). */
const KEEP_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_TOTAL_BYTES = 64 * 1024 * 1024;

const sha1 = (/** @type {Buffer} */ b) => createHash("sha1").update(b).digest("hex");

/**
 * @typedef {object} FileState
 * @property {string | null} hash   null 이면 파일이 없다
 * @property {Buffer | null} bytes  턴 전 내용(상한 안일 때만)
 */

/**
 * @typedef {object} Snapshot
 * @property {Map<string, { root: string, top: string, dirty: Map<string, FileState> }>} repos  루트 → 턴 전 더러운 파일들(저장소 최상위 기준 상대경로)
 * @property {string[]} skipped  git 저장소가 아니라 감사하지 못하는 루트
 */

/**
 * @param {string} root
 * @returns {{ top: string, files: string[] } | null}  저장소 최상위와 더러운 파일(최상위 기준, 추적 안 하는 새 파일 포함). git 이 아니면 null
 */
function dirtyFiles(root) {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const out = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "-uall"], { encoding: "buffer", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
    /** @type {string[]} */
    const files = [];
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i += 1) {
      const entry = parts[i] ?? "";
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2);
      files.push(entry.slice(3));
      if (status[0] === "R" || status[0] === "C") i += 1; // 이름 바꾸기는 옛 이름이 뒤따른다
    }
    return { top: resolve(top), files };
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @returns {Buffer | null}
 */
function readOrNull(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

/**
 * 턴 전 상태를 찍는다.
 * @param {string[]} roots
 * @returns {Snapshot}
 */
export function takeSnapshot(roots) {
  /** @type {Snapshot} */
  const snap = { repos: new Map(), skipped: [] };
  let kept = 0;
  for (const root of roots) {
    const info = dirtyFiles(root);
    if (!info) { snap.skipped.push(root); continue; }
    const { top, files } = info;
    /** @type {Map<string, FileState>} */
    const dirty = new Map();
    for (const rel of files) {
      const bytes = readOrNull(join(top, rel));
      const keep = bytes && bytes.length <= KEEP_FILE_BYTES && kept + bytes.length <= KEEP_TOTAL_BYTES;
      if (keep) kept += /** @type {Buffer} */ (bytes).length;
      dirty.set(rel, { hash: bytes ? sha1(bytes) : null, bytes: keep ? bytes : null });
    }
    snap.repos.set(root, { root, top, dirty });
  }
  return snap;
}

/**
 * @typedef {object} Change
 * @property {string} root
 * @property {string} rel
 * @property {string} path
 * @property {"modified" | "added" | "deleted"} kind
 */

/**
 * 턴 전과 비교해 바뀐 소스 파일. 산출물(_workspace 등)은 뺀다.
 * @param {Snapshot} snap
 * @param {string[]} roots
 * @returns {Change[]}
 */
export function changesSince(snap, roots) {
  /** @type {Change[]} */
  const changes = [];
  for (const [root, repo] of snap.repos) {
    const now = dirtyFiles(root)?.files ?? [];
    const candidates = new Set([...repo.dirty.keys(), ...now]);
    for (const rel of candidates) {
      const path = resolve(repo.top, rel);
      if (classifyTarget(path, roots).kind !== "source") continue;
      const bytes = readOrNull(path);
      const hash = bytes ? sha1(bytes) : null;
      const before = repo.dirty.get(rel);
      if (before) {
        if (before.hash === hash) continue;
        changes.push({ root, rel, path, kind: hash === null ? "deleted" : before.hash === null ? "added" : "modified" });
      } else {
        /* 턴 전에는 깨끗했다 — 지금 더러우면 이번 턴에 바뀐 것이다. */
        const tracked = headBytes(root, rel) !== null;
        changes.push({ root, rel, path, kind: hash === null ? "deleted" : tracked ? "modified" : "added" });
      }
    }
  }
  return changes;
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {Buffer | null}
 */
function headBytes(root, rel) {
  try {
    return execFileSync("git", ["-C", root, "show", `HEAD:${rel.replace(/\\/g, "/")}`], { encoding: "buffer", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * 턴 전 내용. 턴 전에 더러웠으면 찍어 둔 바이트, 깨끗했으면 HEAD.
 * @param {Snapshot} snap
 * @param {Change} change
 * @returns {Buffer | null | undefined}  undefined = 알 수 없음(상한을 넘어 안 찍었다)
 */
function beforeBytes(snap, change) {
  const before = snap.repos.get(change.root)?.dirty.get(change.rel);
  if (!before) return headBytes(change.root, change.rel);
  if (before.hash === null) return null;
  return before.bytes ?? undefined;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
/** @param {Buffer} b */
const isUtf8 = (b) => { try { utf8.decode(b); return true; } catch { return false; } };
/** @param {string} s */
const replacementCount = (s) => (s.match(/�/g) ?? []).length;

/**
 * @typedef {object} EncodingNote
 * @property {Change} change
 * @property {string} encoding
 * @property {"restored" | "broken"} result  restored = 손실 없이 원래 인코딩으로 되돌려 씀 · broken = 글자가 이미 깨짐
 * @property {string} [detail]
 */

/**
 * 원래 레거시 인코딩이던 파일이 UTF-8 로 바뀌었으면 되돌린다.
 * @param {Snapshot} snap
 * @param {Change[]} changes
 * @returns {EncodingNote[]}
 */
export function repairEncoding(snap, changes) {
  /** @type {EncodingNote[]} */
  const notes = [];
  for (const change of changes) {
    if (change.kind !== "modified") continue;
    const before = beforeBytes(snap, change);
    if (!before) continue;
    const encoding = legacyEncodingOf(before, change.path);
    if (!encoding) continue;
    const after = readOrNull(change.path);
    if (!after) continue;
    const beforeBad = replacementCount(decodeLegacy(before, encoding));
    if (isUtf8(after) && after.some((b) => b >= 0x80)) {
      const text = after.toString("utf8");
      if (replacementCount(text) > beforeBad) { notes.push({ change, encoding, result: "broken", detail: "UTF-8 로 바뀌며 글자가 깨졌습니다" }); continue; }
      const encoded = encodeLegacy(text, encoding);
      if (!encoded.ok) { notes.push({ change, encoding, result: "broken", detail: `${encoded.line}줄의 '${encoded.char}' 를 ${encoding} 로 쓸 수 없습니다` }); continue; }
      writeFileSync(change.path, encoded.bytes);
      notes.push({ change, encoding, result: "restored" });
      continue;
    }
    if (replacementCount(decodeLegacy(after, encoding)) > beforeBad) notes.push({ change, encoding, result: "broken", detail: "글자가 깨졌습니다" });
  }
  return notes;
}

/**
 * 바뀐 파일을 턴 전으로 되돌린다.
 * @param {Snapshot} snap
 * @param {Change[]} changes
 * @returns {{ reverted: Change[], failed: Array<{ change: Change, reason: string }> }}
 */
export function revertChanges(snap, changes) {
  /** @type {Change[]} */
  const reverted = [];
  /** @type {Array<{ change: Change, reason: string }>} */
  const failed = [];
  for (const change of changes) {
    const before = beforeBytes(snap, change);
    try {
      if (before === undefined) { failed.push({ change, reason: "턴 전 내용이 너무 커서 보관하지 않았습니다" }); continue; }
      if (before === null) { if (existsSync(change.path)) rmSync(change.path); }
      else writeFileSync(change.path, before);
      reverted.push(change);
    } catch (error) {
      failed.push({ change, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { reverted, failed };
}

/**
 * @typedef {object} TurnAudit
 * @property {Change[]} unapproved   승인 없이 바뀐 소스 파일
 * @property {Change[]} viaShell     승인된 셸 명령(대상 확인 불가) 뒤에 바뀐 파일
 * @property {Change[]} approved     승인된 수정
 * @property {EncodingNote[]} encoding
 * @property {string[]} skipped      git 이 아니라 감사하지 못한 루트
 */

/**
 * @param {Snapshot} snap
 * @param {string[]} roots
 * @param {{ files: Set<string>, shellUnknown: boolean }} approved  승인기 기록(소문자 절대경로)
 * @returns {TurnAudit}
 */
export function auditTurn(snap, roots, approved) {
  const changes = changesSince(snap, roots);
  const encoding = repairEncoding(snap, changes);
  /** @type {Change[]} */
  const unapproved = [];
  /** @type {Change[]} */
  const viaShell = [];
  /** @type {Change[]} */
  const ok = [];
  for (const change of changes) {
    if (approved.files.has(resolve(change.path).toLowerCase())) ok.push(change);
    else if (approved.shellUnknown) viaShell.push(change);
    else unapproved.push(change);
  }
  return { unapproved, viaShell, approved: ok, encoding, skipped: snap.skipped };
}

/**
 * 화면에 낼 줄들.
 * @param {TurnAudit} audit
 * @param {string} cwd
 * @returns {string[]}
 */
export function describeAudit(audit, cwd) {
  const name = (/** @type {Change} */ c) => `${relative(cwd, c.path) || c.path}${c.kind === "added" ? " (새 파일)" : c.kind === "deleted" ? " (삭제)" : ""}`;
  /** @type {string[]} */
  const lines = [];
  if (audit.unapproved.length) {
    lines.push(`승인 없이 바뀐 소스 파일 ${audit.unapproved.length}개`);
    for (const c of audit.unapproved.slice(0, 12)) lines.push(`  ${name(c)}`);
    if (audit.unapproved.length > 12) lines.push(`  … 외 ${audit.unapproved.length - 12}개`);
  }
  if (audit.viaShell.length) lines.push(`승인한 셸 명령 뒤에 바뀐 파일 ${audit.viaShell.length}개: ${audit.viaShell.slice(0, 6).map(name).join(", ")}${audit.viaShell.length > 6 ? " …" : ""}`);
  for (const note of audit.encoding) {
    lines.push(note.result === "restored"
      ? `${name(note.change)} — UTF-8 로 바뀐 것을 원래 인코딩(${note.encoding})으로 되돌려 썼습니다`
      : `${name(note.change)} — ${note.encoding} 파일의 ${note.detail ?? "글자가 깨졌습니다"}. 되돌리기를 권합니다`);
  }
  return lines;
}

/**
 * 턴 전 상태를 파일로 남길 수 있게 — 플러그인 훅은 질문을 받을 때(UserPromptSubmit)와 답이 끝날 때(Stop)가
 * 서로 다른 프로세스라 메모리로 넘길 수 없다. 바이트는 base64 로 담는다.
 * @param {Snapshot} snap
 * @returns {string}
 */
export function serializeSnapshot(snap) {
  return JSON.stringify({
    skipped: snap.skipped,
    repos: [...snap.repos.values()].map((repo) => ({
      root: repo.root, top: repo.top,
      dirty: [...repo.dirty.entries()].map(([rel, st]) => [rel, st.hash, st.bytes ? st.bytes.toString("base64") : null]),
    })),
  });
}

/**
 * @param {string} text
 * @returns {Snapshot}
 */
export function deserializeSnapshot(text) {
  const raw = JSON.parse(text);
  /** @type {Snapshot} */
  const snap = { repos: new Map(), skipped: raw.skipped ?? [] };
  for (const repo of raw.repos ?? []) {
    /** @type {Map<string, FileState>} */
    const dirty = new Map();
    for (const [rel, hash, b64] of repo.dirty ?? []) dirty.set(rel, { hash, bytes: b64 ? Buffer.from(b64, "base64") : null });
    snap.repos.set(repo.root, { root: repo.root, top: repo.top, dirty });
  }
  return snap;
}
