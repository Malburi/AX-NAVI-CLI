/*
 * 레거시 인코딩(EUC-KR 등) 파일을 읽고 고칠 때 인코딩을 지킨다.
 *
 * 실측(2026-09-26, eduLms 복사본 safe-modify): `encoding="EUC-KR"` 로 저장된 MyBatis 쿼리 XML 을
 * Claude 의 Edit 이 UTF-8 로 다시 써서, 파일 안의 한글 설명이 전부 U+FFFD(`占쏙옙`)로 바뀌어 사라졌다.
 * Read 도 같은 바이트를 UTF-8 로 읽어 모델은 한글 주석·라벨을 깨진 채로 봤다. 한국 레거시 저장소는
 * JSP·Struts·쿼리 XML 을 EUC-KR 로 두는 일이 흔하다.
 *
 * 방식은 그림자 사본이다.
 *   Read·Edit·Write 직전  원본이 레거시 인코딩이면 UTF-8 로 푼 사본을 만들고 도구의 경로를 사본으로 바꾼다.
 *   Edit·Write 직후      사본을 원래 인코딩으로 다시 묶어 원본에 쓴다. 묶을 수 없는 글자가 있으면 원본을
 *                        건드리지 않고 사본을 되돌린 뒤 모델에게 알린다.
 * 도구의 짝 맞추기·"먼저 읽어라" 검사는 Claude 가 사본에 대해 그대로 한다. 사본은 원본이 바뀌지 않았으면
 * 다시 만들지 않는다 — 다시 쓰면 수정 시각이 바뀌어 Edit 이 "읽은 뒤 바뀌었다" 로 실패한다.
 *
 * 판정 사다리는 agents/lib/build-index.mjs 의 decodeSource 와 같다(BOM → 선언 → 유효한 UTF-8 → EUC-KR).
 * 인덱서는 의존성 0 인 단독 스크립트라 가져다 쓰지 않고 필요한 만큼만 옮겼다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const ALIASES = new Map([
  ["cp949", "euc-kr"], ["ms949", "euc-kr"], ["ksc5601", "euc-kr"], ["ks_c_5601", "euc-kr"], ["ks_c_5601-1987", "euc-kr"],
  ["cp932", "shift_jis"], ["ms932", "shift_jis"], ["sjis", "shift_jis"],
  ["cp950", "big5"], ["ms950", "big5"],
  ["cp1252", "windows-1252"], ["ansi", "windows-1252"],
]);
/* 다시 묶을 수 있는 인코딩. gb18030 은 4바이트 조합이 있어 이 표 방식으로는 못 묶는다. */
const ENCODABLE = new Set(["euc-kr", "shift_jis", "big5", "windows-1252"]);
const DECLARATION = /\b(?:encoding|pageEncoding|charset)\s*=\s*["']?([\w][\w.:-]*)/i;
const MARKER = ".axnavi-encoding.json";
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** @param {string | undefined} label */
function canonical(label) {
  if (!label) return null;
  const lower = label.trim().toLowerCase();
  for (const candidate of [lower, ALIASES.get(lower)]) {
    if (!candidate) continue;
    try {
      return new TextDecoder(candidate).encoding;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/**
 * 레거시 인코딩이면 그 이름을, UTF-8·UTF-16·순수 ASCII 면 null 을 돌려준다.
 * @param {Buffer} buffer
 * @returns {string | null}
 */
export function legacyEncodingOf(buffer) {
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) return null;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return null; // 유효한 UTF-8 이면 선언이 레거시여도 실제 저장은 UTF-8 이다(인덱서와 같은 판단)
  } catch { /* 레거시 */ }
  const declared = canonical(DECLARATION.exec(buffer.subarray(0, 2048).toString("latin1"))?.[1]);
  return declared && declared !== "utf-8" ? declared : "euc-kr";
}

/** @type {Map<string, Map<number, number[]>>} */
const tables = new Map();

/*
 * 글자 → 바이트 표. Node 의 TextEncoder 는 UTF-8 만 만들므로 디코더로 가능한 바이트 조합을 전부 풀어
 * 거꾸로 세운다(EUC-KR 약 2만 4천 조합, 수십 ms). 같은 글자가 여러 조합에서 나오면 먼저 나온 것을 쓰고,
 * 원본이 다른 조합을 썼다면 왕복 검사(`roundTrips`)가 잡는다.
 * @param {string} encoding
 */
function tableFor(encoding) {
  const cached = tables.get(encoding);
  if (cached) return cached;
  const decoder = new TextDecoder(encoding);
  /** @type {Map<number, number[]>} */
  const table = new Map();
  const put = (/** @type {number[]} */ bytes) => {
    const text = decoder.decode(Uint8Array.from(bytes));
    const chars = [...text];
    if (chars.length !== 1 || text === "�") return;
    const code = /** @type {number} */ (text.codePointAt(0));
    if (code < 0x80 || table.has(code)) return;
    table.set(code, bytes);
  };
  for (let b = 0x80; b <= 0xff; b += 1) put([b]);
  if (encoding !== "windows-1252") {
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) put([lead, trail]);
    }
  }
  tables.set(encoding, table);
  return table;
}

/**
 * @param {string} text
 * @param {string} encoding
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, char: string, line: number }}
 */
export function encodeLegacy(text, encoding) {
  const table = tableFor(encoding);
  /** @type {number[]} */
  const out = [];
  let line = 1;
  for (const ch of text) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    if (code === 0x0a) line += 1;
    if (code < 0x80) { out.push(code); continue; }
    const bytes = table.get(code);
    if (!bytes) return { ok: false, char: ch, line };
    out.push(...bytes);
  }
  return { ok: true, bytes: Buffer.from(out) };
}

/** 풀었다 다시 묶었을 때 원본 바이트가 그대로 나오는가. 아니면 고쳐 쓰는 순간 원본이 바뀐다. */
function roundTrips(/** @type {Buffer} */ buffer, /** @type {string} */ encoding, /** @type {string} */ text) {
  if (!ENCODABLE.has(encoding) || text.includes("�")) return false;
  const back = encodeLegacy(text, encoding);
  return back.ok && back.bytes.equals(buffer);
}

const sha1 = (/** @type {Buffer} */ b) => createHash("sha1").update(b).digest("hex");

/**
 * 원본 경로에 대응하는 사본 경로. 작업 폴더 안이면 `.axnavi/encoding/` 아래 같은 상대 경로에 둔다
 * (승인 창·보고에 나오는 경로가 알아볼 만하도록). 밖이면 임시 폴더에 둔다.
 * @param {string} original 절대 경로
 * @param {string} cwd
 */
export function shadowPathFor(original, cwd) {
  const rel = relative(cwd, original);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return join(cwd, ".axnavi", "encoding", rel);
  return join(tmpdir(), "axnavi-encoding", sha1(Buffer.from(original)).slice(0, 16), basename(original));
}

/** @param {string} shadow */
function readMarker(shadow) {
  try {
    return JSON.parse(readFileSync(shadow + MARKER, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 원본이 레거시 인코딩이면 사본을 준비한다. 원본이 사본을 만든 뒤로 바뀌지 않았으면 사본을 그대로 둔다.
 * @param {string} original 절대 경로
 * @param {string} cwd
 * @returns {{ shadow: string, encoding: string, safe: boolean } | null}
 */
export function prepareShadow(original, cwd) {
  if (!existsSync(original)) return null;
  const buffer = readFileSync(original);
  const encoding = legacyEncodingOf(buffer);
  if (!encoding) return null;
  const shadow = shadowPathFor(original, cwd);
  const hash = sha1(buffer);
  const marker = readMarker(shadow);
  if (marker && marker.hash === hash && existsSync(shadow)) return { shadow, encoding: marker.encoding, safe: marker.safe };
  const text = new TextDecoder(encoding).decode(buffer);
  const safe = roundTrips(buffer, encoding, text);
  mkdirSync(dirname(shadow), { recursive: true });
  writeFileSync(shadow, text, "utf8");
  writeFileSync(shadow + MARKER, JSON.stringify({ original, encoding, hash, safe }), "utf8");
  return { shadow, encoding, safe };
}

/**
 * @param {any} event  훅 입력(tool_name, tool_input, cwd)
 */
function targetOf(event) {
  const input = event?.tool_input;
  const path = typeof input?.file_path === "string" ? input.file_path : null;
  if (!path) return null;
  const cwd = typeof event?.cwd === "string" && event.cwd ? event.cwd : process.cwd();
  return { input, cwd, path: isAbsolute(path) ? path : resolve(cwd, path) };
}

const isShadow = (/** @type {string} */ path) => existsSync(path + MARKER);

/**
 * PreToolUse — 레거시 인코딩 파일이면 도구가 사본을 보게 바꾼다.
 * @param {any} event
 * @returns {object}  바꿀 것이 없으면 빈 객체
 */
export function encodingPreToolUse(event) {
  if (!FILE_TOOLS.has(event?.tool_name)) return {};
  const target = targetOf(event);
  if (!target || isShadow(target.path)) return {};
  let prepared;
  try {
    prepared = prepareShadow(target.path, target.cwd);
  } catch {
    return {}; // 사본을 못 만들면 예전처럼 원본으로 진행한다 — 읽기까지 막지는 않는다
  }
  if (!prepared) return {};
  if (!prepared.safe && WRITE_TOOLS.has(event.tool_name)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `axnavi: ${target.path} 는 ${prepared.encoding} 로 저장돼 있는데, 원본 바이트가 이 인코딩으로 온전히 왕복되지 않아(깨진 바이트 또는 표에 없는 조합) 고치면 원본 글자가 바뀝니다. 이 파일은 수정하지 말고 보고에 "인코딩 보존 불가"로 남기세요.`,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `axnavi: ${prepared.encoding} 파일이라 UTF-8 사본으로 다루고, 고친 내용은 원본에 ${prepared.encoding} 로 되돌려 저장한다`,
      updatedInput: { ...target.input, file_path: prepared.shadow },
    },
  };
}

/**
 * PostToolUse — 사본을 고쳤으면 원래 인코딩으로 묶어 원본에 쓴다.
 * @param {any} event
 * @returns {object}
 */
export function encodingPostToolUse(event) {
  if (!WRITE_TOOLS.has(event?.tool_name)) return {};
  const target = targetOf(event);
  if (!target) return {};
  // 도구 입력이 사본 경로로 보이든 원본 경로로 보이든 같은 사본을 찾는다.
  const shadow = isShadow(target.path) ? target.path : shadowPathFor(target.path, target.cwd);
  const marker = readMarker(shadow);
  if (!marker || !existsSync(shadow)) return {};
  const text = readFileSync(shadow, "utf8");
  const encoded = encodeLegacy(text, marker.encoding);
  if (!encoded.ok) {
    // 원본은 그대로 두고 사본을 원본 상태로 되돌린다 — 안 그러면 다음 Read 가 반영 안 된 수정을 보여 준다.
    const original = readFileSync(marker.original);
    writeFileSync(shadow, new TextDecoder(marker.encoding).decode(original), "utf8");
    return {
      decision: "block",
      reason: `axnavi: 이 수정은 원본에 반영되지 않았습니다. ${marker.original} 는 ${marker.encoding} 파일인데 새 내용 ${encoded.line}번째 줄의 "${encoded.char}" 를 ${marker.encoding} 로 쓸 수 없습니다. 그 글자를 ${marker.encoding} 에 있는 글자로 바꿔 다시 고치세요. 파일을 다시 읽은 뒤 고쳐야 합니다.`,
    };
  }
  writeFileSync(marker.original, encoded.bytes);
  writeFileSync(shadow + MARKER, JSON.stringify({ ...marker, hash: sha1(encoded.bytes) }), "utf8");
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `axnavi: 수정 내용을 원본 ${marker.original} 에 ${marker.encoding} 인코딩으로 저장했습니다. 보고에는 원본 경로를 쓰세요.`,
    },
  };
}
