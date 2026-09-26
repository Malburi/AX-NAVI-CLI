/*
 * 레거시 인코딩(EUC-KR 등) 파일을 읽고 고칠 때 인코딩을 지킨다.
 *
 * 실측(2026-09-26, eduLms 복사본 safe-modify): `encoding="EUC-KR"` 로 저장된 MyBatis 쿼리 XML 을
 * Claude 의 Edit 이 UTF-8 로 다시 써서, 파일 안의 한글 설명이 전부 U+FFFD(`占쏙옙`)로 바뀌어 사라졌다.
 * Read 도 같은 바이트를 UTF-8 로 읽어 모델은 한글 주석·라벨을 깨진 채로 봤다. 한국 레거시 저장소는
 * JSP·Struts·쿼리 XML 을 EUC-KR 로 두는 일이 흔하다.
 *
 * 방식 — 도구가 도는 동안만 제자리에서 UTF-8 로 바꿨다가 되돌린다.
 *   도구 직전(Pre)   원본 바이트를 백업하고, 파일을 UTF-8 로 풀어 제자리에 쓴다. 수정 시각은 원래대로 돌린다.
 *   도구 직후(Post)  아무것도 안 바뀌었으면 백업 바이트를 그대로 되돌린다(무손실). 바뀌었으면 원래 인코딩으로
 *                    묶어 쓴다. 수정 시각은 도구가 남긴 그대로 둔다.
 *   실패·거부·종료   PostToolUseFailure·PermissionDenied·Stop·SessionEnd 와 실행 종료 시 남은 것을 되돌린다.
 *
 * 경로를 사본으로 바꾸던 첫 방식은 버렸다. Claude 는 Read 를 바뀐 경로(사본)로 기록하고 Edit 은 원래 경로로
 * 검사해 "File has not been read yet" 으로 실패했고(실측), 경로를 바꾸려면 허용 결정까지 훅이 내려야 해서
 * "매번 묻기" 모드에서도 승인 창을 건너뛰었다. 제자리 변환은 경로를 건드리지 않으므로 둘 다 생기지 않는다.
 * 수정 시각을 유지하는 이유: Claude 는 읽은 뒤 파일의 수정 시각이 바뀌면 "읽은 뒤 바뀌었다" 로 Edit 을 막는다.
 *
 * 판정 사다리는 agents/lib/build-index.mjs 의 decodeSource 와 같다(BOM → 선언 → 유효한 UTF-8 → EUC-KR).
 * 인덱서는 의존성 0 인 단독 스크립트라 가져다 쓰지 않고 필요한 만큼만 옮겼다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { ensureAxnaviIgnore } from "../../core/src/context/sessions.mjs"; // 원본 백업이 커밋되지 않게

const ALIASES = new Map([
  ["cp949", "euc-kr"], ["ms949", "euc-kr"], ["ksc5601", "euc-kr"], ["ks_c_5601", "euc-kr"], ["ks_c_5601-1987", "euc-kr"], ["uhc", "euc-kr"],
  ["cp932", "shift_jis"], ["ms932", "shift_jis"], ["sjis", "shift_jis"], ["windows-31j", "shift_jis"],
  ["cp950", "big5"], ["ms950", "big5"],
  ["cp1252", "windows-1252"], ["ansi", "windows-1252"],
]);
/* 다시 묶을 수 있는 인코딩. gb18030 은 4바이트 조합이 있어 이 표 방식으로는 못 묶는다. */
const ENCODABLE = new Set(["euc-kr", "shift_jis", "big5", "windows-1252"]);
const DECLARATION = /\b(?:encoding|pageEncoding|charset)\s*=\s*["']?([\w][\w.:-]*)/i;
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
/* 텍스트가 아닌 것. 이미지·PDF 를 EUC-KR 로 풀면 Claude 의 이미지·PDF 읽기가 망가진다(리뷰 실측). */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tif", ".tiff", ".pdf", ".zip", ".jar", ".war", ".ear",
  ".class", ".gz", ".tgz", ".7z", ".rar", ".exe", ".dll", ".so", ".pyc", ".xls", ".xlsx", ".doc", ".docx", ".ppt",
  ".pptx", ".hwp", ".mp3", ".mp4", ".avi", ".mov", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pbl", ".mrd", ".ipynb",
]);
/* 이보다 크면 제자리 변환을 하지 않는다(메모리·지연). 그런 파일의 수정은 막는다 — 막지 않으면 UTF-8 로 깨진다. */
const MAX_BYTES = 32 * 1024 * 1024;

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
 * 레거시 인코딩이면 그 이름을, UTF-8·UTF-16·바이너리면 null 을 돌려준다.
 * @param {Buffer} buffer
 * @param {string} [path]  확장자로 바이너리를 거른다
 * @returns {string | null}
 */
export function legacyEncodingOf(buffer, path = "") {
  if (BINARY_EXT.has(extname(path).toLowerCase())) return null;
  if (buffer.subarray(0, 8000).includes(0)) return null; // NUL 이 있으면 텍스트가 아니다
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) return null;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return null;
  const declared = canonical(DECLARATION.exec(buffer.subarray(0, 2048).toString("latin1"))?.[1]);
  const legacyDeclared = declared && declared !== "utf-8" && ENCODABLE.has(declared) ? declared : null;
  let ascii = true;
  for (const b of buffer) if (b >= 0x80) { ascii = false; break; }
  /*
   * 한글이 아직 없는 EUC-KR 선언 파일도 레거시로 본다. 안 그러면 모델이 넣은 한글이 UTF-8 로 저장되고,
   * 서버는 선언대로 EUC-KR 로 읽어 화면에서 깨진다(리뷰 지적).
   */
  if (ascii) return legacyDeclared;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return null; // 유효한 UTF-8 이면 선언이 레거시여도 실제 저장은 UTF-8 이다(인덱서와 같은 판단)
  } catch { /* 레거시이거나 섞였다 */ }
  /*
   * 거의 UTF-8 인데 떠도는 바이트가 조금 있는 파일은 UTF-8 로 본다. 1바이트 때문에 파일 전체를 EUC-KR 로 풀면
   * UTF-8 한글이 모두 깨져 보이고 수정도 막힌다(리뷰 실측).
   */
  if (!legacyDeclared) {
    const text = new TextDecoder("utf-8").decode(buffer);
    let bad = 0;
    let good = 0;
    for (const ch of text) {
      if (ch === "�") bad += 1;
      else if (ch.charCodeAt(0) >= 0x80) good += 1;
    }
    if (bad <= 3 && good >= bad * 50) return null;
  }
  return legacyDeclared ?? (declared && declared !== "utf-8" ? declared : "euc-kr");
}

/* ─────────────────────────── 인코딩 표 ─────────────────────────── */

/** @type {Map<string, { decode: Map<number, string>, encode: Map<number, number[]> }>} */
const tables = new Map();

/*
 * CP949(UHC) 확장 한글. Node 의 `TextDecoder("euc-kr")`(ICU) 는 KS X 1001 완성형 2,350자만 풀고,
 * 윈도(MS949)가 저장한 나머지 8,822자(갂·똠·햏 등)는 U+FFFD 로 만든다(실측 0x8141 → FFFD).
 * UHC 는 KS X 1001 에 없는 완성형 한글을 유니코드 순서대로 아래 자리에 채운 것이라 규칙으로 만든다.
 *   lead 0x81–0xA0 : trail 0x41–0x5A, 0x61–0x7A, 0x81–0xFE (178자리)
 *   lead 0xA1–0xC6 : trail 0x41–0x5A, 0x61–0x7A, 0x81–0xA0 (84자리, 0xC6 은 0x52 까지)
 * @param {Map<number, number[]>} kscEncode  KS X 1001 로 이미 묶이는 글자
 * @returns {Array<[number, number, number]>}  [lead, trail, 유니코드]
 */
function uhcExtension(kscEncode) {
  /** @type {Array<[number, number]>} */
  const slots = [];
  const trails = (/** @type {number} */ lead) => {
    const out = [];
    for (let t = 0x41; t <= 0x5a; t += 1) out.push(t);
    for (let t = 0x61; t <= 0x7a; t += 1) out.push(t);
    for (let t = 0x81; t <= (lead <= 0xa0 ? 0xfe : 0xa0); t += 1) out.push(t);
    return out;
  };
  for (let lead = 0x81; lead <= 0xc6; lead += 1) for (const t of trails(lead)) slots.push([lead, t]);
  /** @type {Array<[number, number, number]>} */
  const out = [];
  let i = 0;
  for (let code = 0xac00; code <= 0xd7a3 && i < slots.length; code += 1) {
    if (kscEncode.has(code)) continue;
    const [lead, trail] = /** @type {[number, number]} */ (slots[i]);
    out.push([lead, trail, code]);
    i += 1;
  }
  return out;
}

/**
 * 바이트 → 글자, 글자 → 바이트 표. Node 의 TextEncoder 는 UTF-8 만 만들므로 디코더로 가능한 조합을 풀어
 * 거꾸로 세운다. 같은 글자가 여러 조합에서 나오면 WHATWG 인코더 규칙을 따른다 — 틀린 쪽을 고르면 원본이
 * 왕복되지 않아 수정이 거부된다(리뷰 실측: Big5 `十`, Shift_JIS IBM 확장 한자).
 * @param {string} encoding
 */
function tableFor(encoding) {
  const cached = tables.get(encoding);
  if (cached) return cached;
  const decoder = new TextDecoder(encoding);
  /** @type {Map<number, string>} */
  const decode = new Map();
  /** @type {Map<number, number[]>} */
  const encode = new Map();
  const one = (/** @type {number[]} */ bytes) => {
    const text = decoder.decode(Uint8Array.from(bytes));
    return [...text].length === 1 && text !== "�" ? text : null;
  };
  // Big5: 0xA1 미만 lead(HKSCS)는 인코더가 쓰지 않고, 아래 글자는 마지막 조합을 쓴다(WHATWG index Big5 pointer).
  const big5Last = new Set([0x2550, 0x255e, 0x2561, 0x256a, 0x5341, 0x5345]);
  const put = (/** @type {number[]} */ bytes, /** @type {string} */ ch) => {
    const code = /** @type {number} */ (ch.codePointAt(0));
    if (code < 0x80) return;
    if (encoding === "shift_jis" && (bytes[0] === 0xed || bytes[0] === 0xee)) return; // NEC 선정 IBM 확장 행
    if (encoding === "big5" && /** @type {number} */ (bytes[0]) < 0xa1 && bytes.length === 2) return;
    if (!encode.has(code) || (encoding === "big5" && big5Last.has(code))) encode.set(code, bytes);
  };
  for (let b = 0x80; b <= 0xff; b += 1) {
    const ch = one([b]);
    if (ch) { decode.set(b, ch); put([b], ch); }
  }
  if (encoding !== "windows-1252") {
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) {
        const ch = one([lead, trail]);
        if (!ch) continue;
        decode.set(lead * 256 + trail, ch);
        put([lead, trail], ch);
      }
    }
  }
  if (encoding === "euc-kr") {
    for (const [lead, trail, code] of uhcExtension(encode)) {
      const key = lead * 256 + trail;
      if (decode.has(key)) continue;
      const ch = String.fromCodePoint(code);
      decode.set(key, ch);
      encode.set(code, [lead, trail]);
    }
  }
  const table = { decode, encode };
  tables.set(encoding, table);
  return table;
}

/**
 * @param {Buffer} buffer
 * @param {string} encoding
 */
export function decodeLegacy(buffer, encoding) {
  // EUC-KR 만 직접 푼다(CP949 확장 한글 때문에). 나머지는 Node 디코더로 충분하다.
  if (encoding !== "euc-kr") return new TextDecoder(encoding).decode(buffer);
  const { decode } = tableFor(encoding);
  let out = "";
  for (let i = 0; i < buffer.length; i += 1) {
    const b = /** @type {number} */ (buffer[i]);
    if (b < 0x80) { out += String.fromCharCode(b); continue; }
    const pair = i + 1 < buffer.length ? decode.get(b * 256 + /** @type {number} */ (buffer[i + 1])) : undefined;
    if (pair) { out += pair; i += 1; continue; }
    out += decode.get(b) ?? "�";
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} encoding
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, char: string, line: number }}
 */
export function encodeLegacy(text, encoding) {
  const { encode } = tableFor(encoding);
  // 글자당 최대 2바이트라 미리 잡아 둔다. 숫자 배열에 push 하면 8.8MB 파일에 600MB 를 썼다(리뷰 실측).
  const out = Buffer.allocUnsafe(text.length * 2);
  let n = 0;
  let line = 1;
  for (const ch of text) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    if (code === 0x0a) line += 1;
    if (code < 0x80) { out[n++] = code; continue; }
    const bytes = encode.get(code);
    if (!bytes) return { ok: false, char: ch, line };
    for (const b of bytes) out[n++] = b;
  }
  return { ok: true, bytes: out.subarray(0, n) };
}

/* ─────────────────────────── 제자리 변환 ─────────────────────────── */

const sha1 = (/** @type {Buffer} */ b) => createHash("sha1").update(b).digest("hex");

/**
 * 원본 하나의 상태를 적어 두는 곳. 작업 폴더 안이면 `.axnavi/encoding/<같은 상대 경로>.json`,
 * 밖이면 임시 폴더. 백업 바이트는 같은 이름의 `.orig` 에 둔다.
 * @param {string} file 절대 경로
 * @param {string} cwd
 */
export function stateFor(file, cwd) {
  const rel = relative(cwd, file);
  const inside = rel && !rel.startsWith("..") && !isAbsolute(rel);
  const base = inside ? join(cwd, ".axnavi", "encoding", rel) : join(tmpdir(), "axnavi-encoding", sha1(Buffer.from(file)).slice(0, 16), "file");
  return { marker: `${base}.json`, backup: `${base}.orig`, root: inside ? join(cwd, ".axnavi") : null };
}

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 도구 전에 원본을 UTF-8 로 바꾼다. 이미 바꿔 둔 상태(앞선 도구가 되돌리지 못함)면 먼저 되돌린다.
 * @param {string} file
 * @param {string} cwd
 * @param {boolean} forWrite
 * @returns {{ converted: boolean, encoding?: string, refuse?: string }}
 */
export function convertForTool(file, cwd, forWrite) {
  const state = stateFor(file, cwd);
  if (existsSync(state.marker)) restoreFile(file, cwd); // 남은 것부터 정리한다
  if (!existsSync(file)) return { converted: false };
  const size = statSync(file).size;
  if (size > MAX_BYTES) {
    const head = readFileSync(file).subarray(0, 64 * 1024);
    const enc = legacyEncodingOf(head, file);
    return forWrite && enc ? { converted: false, refuse: `${file} 는 ${enc} 파일인데 ${Math.round(size / 1048576)}MB 로 너무 커서 인코딩을 지키며 고칠 수 없습니다. 이 파일은 수정하지 말고 보고에 남기세요.` } : { converted: false };
  }
  const buffer = readFileSync(file);
  const encoding = legacyEncodingOf(buffer, file);
  if (!encoding) return { converted: false };
  if (!ENCODABLE.has(encoding)) {
    return forWrite ? { converted: false, refuse: `${file} 는 ${encoding} 로 저장돼 있어 인코딩을 지키며 고칠 수 없습니다. 이 파일은 수정하지 말고 보고에 "인코딩 보존 불가"로 남기세요.` } : { converted: false };
  }
  const text = decodeLegacy(buffer, encoding);
  const back = encodeLegacy(text, encoding);
  const roundTrips = !text.includes("�") && back.ok && back.bytes.equals(buffer);
  if (!roundTrips) {
    // 깨진 바이트가 섞인 파일. 고치면 원본 글자가 바뀐다 — 읽기는 예전처럼 두고 수정만 막는다.
    return forWrite ? { converted: false, refuse: `${file} 는 ${encoding} 로 저장돼 있는데 원본 바이트가 온전히 왕복되지 않아(깨진 바이트 또는 표에 없는 조합) 고치면 원본 글자가 바뀝니다. 이 파일은 수정하지 말고 보고에 "인코딩 보존 불가"로 남기세요.` } : { converted: false };
  }
  const utf8 = Buffer.from(text, "utf8");
  const { atimeMs, mtimeMs } = statSync(file);
  const atime = atimeMs / 1000; // 초 단위 숫자로 넘긴다 — Date 는 1ms 아래를 잘라 수정 시각이 조금 바뀐다
  const mtime = mtimeMs / 1000;
  mkdirSync(dirname(state.marker), { recursive: true });
  if (state.root) ensureAxnaviIgnore(state.root);
  writeFileSync(state.backup, buffer);
  writeFileSync(state.marker, JSON.stringify({ file, encoding, utf8Hash: sha1(utf8), legacyHash: sha1(buffer) }), "utf8");
  writeFileSync(file, utf8);
  utimesSync(file, atime, mtime); // 읽은 뒤 바뀐 것으로 보이지 않게
  return { converted: true, encoding };
}

/**
 * 도구 뒤에 원래 인코딩으로 되돌린다.
 * @param {string} file
 * @param {string} cwd
 * @returns {{ ok: true, changed: boolean, encoding?: string } | { ok: false, reason: string }}
 */
export function restoreFile(file, cwd, state = stateFor(file, cwd)) {
  const marker = readJson(state.marker);
  if (!marker || marker.file !== file) return { ok: true, changed: false };
  const drop = () => {
    rmSync(state.marker, { force: true });
    rmSync(state.backup, { force: true });
  };
  if (!existsSync(file)) { drop(); return { ok: true, changed: false }; } // 도구가 지웠다
  const current = readFileSync(file);
  const { atimeMs, mtimeMs } = statSync(file);
  const atime = atimeMs / 1000; // 초 단위 숫자로 넘긴다 — Date 는 1ms 아래를 잘라 수정 시각이 조금 바뀐다
  const mtime = mtimeMs / 1000;
  /** @type {Buffer} */
  let bytes;
  let changed = false;
  if (sha1(current) === marker.utf8Hash) {
    bytes = readFileSync(state.backup); // 그대로면 원본 바이트를 그대로 — 무손실
  } else if (sha1(current) === marker.legacyHash) {
    drop(); // 이미 되돌려져 있다
    return { ok: true, changed: false };
  } else {
    changed = true;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(current);
    } catch {
      drop(); // UTF-8 이 아닌 무언가를 도구가 직접 썼다(스크립트 등). 그 결과를 존중한다.
      return { ok: true, changed: true };
    }
    const encoded = encodeLegacy(text, marker.encoding);
    if (!encoded.ok) {
      try {
        writeFileSync(file, readFileSync(state.backup));
        utimesSync(file, atime, mtime);
      } catch { /* 아래 안내로 알린다 */ }
      drop();
      return { ok: false, reason: `axnavi: 이 수정은 원본에 반영되지 않았습니다. ${file} 는 ${marker.encoding} 파일인데 새 내용 ${encoded.line}번째 줄의 "${encoded.char}" 를 ${marker.encoding} 로 쓸 수 없어 원래 내용으로 되돌렸습니다. 그 글자를 ${marker.encoding} 에 있는 글자로 바꿔, 파일을 다시 읽은 뒤 고치세요.` };
    }
    bytes = encoded.bytes;
  }
  try {
    writeFileSync(file, bytes);
    utimesSync(file, atime, mtime); // 도구가 남긴 수정 시각 그대로 — Claude 의 기록과 맞춘다
  } catch (error) {
    // 읽기 전용 원본 등. 조용히 넘기면 모델은 반영된 줄 안다(리뷰 지적).
    return { ok: false, reason: `axnavi: ${file} 를 원래 인코딩(${marker.encoding})으로 되돌려 쓰지 못했습니다(${/** @type {Error} */ (error).code ?? error}). 파일이 읽기 전용이거나 잠겨 있을 수 있습니다. 이 파일의 수정 결과를 신뢰하지 말고 보고에 남기세요.` };
  }
  drop();
  return { ok: true, changed, encoding: marker.encoding };
}

/**
 * 남은 변환을 모두 되돌린다(실패·거부·종료 때).
 * @param {string} cwd
 */
export function restoreAll(cwd) {
  const dirs = [join(cwd, ".axnavi", "encoding"), join(tmpdir(), "axnavi-encoding")];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    /** @param {string} d */
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".json")) {
          const marker = readJson(p);
          if (typeof marker?.file !== "string" || !isAbsolute(marker.file)) continue;
          /*
           * 표식에 적힌 경로를 그대로 믿지 않는다. 그 경로에서 다시 계산한 표식 자리가 이 파일이어야 한다 —
           * 안 그러면 저장소에 심은 표식 하나로 밖의 파일을 덮어쓸 수 있다(리뷰 실측).
           */
          const expected = [stateFor(marker.file, cwd).marker, stateFor(marker.file, join(tmpdir(), "\0none")).marker];
          if (!expected.includes(p)) continue;
          try {
            restoreFile(marker.file, cwd, { marker: p, backup: p.replace(/\.json$/, ".orig"), root: null });
          } catch { /* 다음 것 */ }
        }
      }
    };
    try {
      walk(dir);
    } catch { /* 폴더를 못 읽으면 넘어간다 */ }
  }
}

/* ─────────────────────────── 훅 ─────────────────────────── */

/** @param {any} event */
function targetOf(event) {
  const input = event?.tool_input;
  const path = typeof input?.file_path === "string" ? input.file_path : null;
  const cwd = typeof event?.cwd === "string" && event.cwd ? event.cwd : process.cwd();
  if (!path) return { cwd, file: null };
  return { cwd, file: isAbsolute(path) ? path : resolve(cwd, path) };
}

/**
 * PreToolUse — 레거시 인코딩 파일이면 도구가 도는 동안 UTF-8 로 바꿔 둔다.
 * 허용 여부는 건드리지 않는다(승인 흐름은 평소대로). 고칠 수 없는 파일의 수정만 막는다.
 * @param {any} event
 */
export function encodingPreToolUse(event) {
  if (!FILE_TOOLS.has(event?.tool_name)) return {};
  const { cwd, file } = targetOf(event);
  if (!file) return {};
  let result;
  try {
    result = convertForTool(file, cwd, WRITE_TOOLS.has(event.tool_name));
  } catch {
    return {}; // 변환을 못 하면 예전처럼 진행한다 — 읽기까지 막지는 않는다
  }
  if (result.refuse) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `axnavi: ${result.refuse}` } };
  }
  return {};
}

/**
 * PostToolUse — 원래 인코딩으로 되돌린다.
 * @param {any} event
 */
export function encodingPostToolUse(event) {
  if (!FILE_TOOLS.has(event?.tool_name)) return {};
  const { cwd, file } = targetOf(event);
  if (!file) return {};
  const result = restoreFile(file, cwd);
  if (!result.ok) return { decision: "block", reason: result.reason };
  if (result.changed && WRITE_TOOLS.has(event.tool_name)) {
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `axnavi: ${file} 는 원래 인코딩(${result.encoding})으로 저장했습니다.` } };
  }
  return {};
}

/**
 * PostToolUseFailure·PermissionDenied·Stop·SessionEnd — 도구가 끝나지 못했어도 되돌린다.
 * @param {any} event
 */
export function encodingCleanup(event) {
  const { cwd, file } = targetOf(event);
  try {
    if (file) restoreFile(file, cwd);
    else restoreAll(cwd);
  } catch { /* 정리는 최선만 */ }
  return {};
}
