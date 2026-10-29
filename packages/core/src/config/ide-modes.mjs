/*
 * IDE 사용자 정의 모드 배포 — 조직 설정의 modes/<slug>.json 을 AX-NAVI IDE(Roo 계열)의 전역 custom_modes.yaml 에 넣는다.
 *
 * IDE 는 전역 모드를 custom_modes.yaml 하나에서만 읽으므로, 사용자가 만든 모드와 한 파일에 같이 둔다.
 * YAML 라이브러리 없이 줄 단위로 다룬다:
 *   - 우리가 넣는 모드는 한 줄짜리 흐름 매핑(JSON 은 YAML 이다)으로, 표시 주석 사이에 둔다.
 *   - 지난번에 넣은 slug 의 항목은 표시 주석이 사라졌어도(IDE 가 파일을 다시 쓰면 주석이 없어진다) slug 로 찾아 지운다.
 *   - 사용자가 같은 slug 로 만든 모드가 있으면 그것을 두고 우리 것은 넣지 않는다.
 * 파일 모양을 알아볼 수 없으면(customModes: 가 맨 앞에 없음) 손대지 않고 이유를 돌려준다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BEGIN = "# axnavi-org:begin — 조직 설정에서 배포한 모드(axnavi org pull 이 관리, 직접 고치지 마세요)";
const END = "# axnavi-org:end";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * 전역 모드 파일 위치. AXNAVI_IDE_MODES_FILE > AXNAVI_IDE_ROO_DIR/custom_modes.yaml(시험·사내 배치) > IDE 설정 폴더.
 * IDE 설정 폴더는 IDE 를 한 번 이상 띄워 확장 폴더가 있을 때만 쓴다.
 * @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export function ideModesFile(env = process.env) {
  const get = (/** @type {string} */ k) => env[k] ?? process.env[k];
  if (get("AXNAVI_ORG_IDE") === "0") return null;
  if (get("AXNAVI_IDE_MODES_FILE")) return /** @type {string} */ (get("AXNAVI_IDE_MODES_FILE"));
  if (get("AXNAVI_IDE_ROO_DIR")) return join(/** @type {string} */ (get("AXNAVI_IDE_ROO_DIR")), "custom_modes.yaml");
  const base =
    process.platform === "win32"
      ? join(get("APPDATA") || join(homedir(), "AppData", "Roaming"), "AX-NAVI IDE")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "AX-NAVI IDE")
        : join(get("XDG_CONFIG_HOME") || join(homedir(), ".config"), "AX-NAVI IDE");
  const ext = join(base, "User", "globalStorage", "hnix.axnavi");
  return existsSync(ext) ? join(ext, "settings", "custom_modes.yaml") : null;
}

/**
 * 배포본의 모드 JSON 하나를 검사해 IDE 가 읽는 모양으로 — 틀리면 null.
 * @param {string} slug @param {string} body @returns {Record<string, unknown> | null}
 */
export function parseOrgMode(slug, body) {
  let m;
  try {
    m = JSON.parse(body);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m) || m.slug !== slug || !SLUG_RE.test(slug)) return null;
  if (typeof m.name !== "string" || typeof m.roleDefinition !== "string" || !Array.isArray(m.groups)) return null;
  /** @type {Record<string, unknown>} */
  const out = { slug, name: m.name, roleDefinition: m.roleDefinition };
  for (const k of ["whenToUse", "description", "customInstructions", "iconName"]) if (typeof m[k] === "string") out[k] = m[k];
  out.groups = m.groups;
  return out;
}

/** 줄의 들여쓰기 칸 수 @param {string} l */
const indentOf = (l) => /** @type {RegExpMatchArray} */ (l.match(/^ */))[0].length;

/**
 * custom_modes.yaml 본문에 조직 모드를 넣는다.
 * @param {string | null} text 지금 파일(없으면 null)
 * @param {Record<string, unknown>[]} modes 넣을 모드
 * @param {string[]} previous 지난번에 우리가 넣은 slug
 * @returns {{ text: string, installed: string[], kept: string[] } | { error: string }}
 */
export function mergeIdeModes(text, modes, previous) {
  const nl = text?.includes("\r\n") ? "\r\n" : "\n";
  let lines = (text ?? "customModes: []").split(/\r?\n/);
  // 1) 지난번 표시 구간 통째로 지운다
  const b = lines.findIndex((l) => l.trim().startsWith("# axnavi-org:begin"));
  const e = lines.findIndex((l, i) => i > b && l.trim() === END);
  if (b >= 0 && e > b) lines.splice(b, e - b + 1);

  const head = lines.findIndex((l) => /^customModes:\s*(\[\s*\])?\s*(#.*)?$/.test(l));
  if (head < 0) return { error: "custom_modes.yaml 맨 앞에 customModes: 가 없어 손대지 않았습니다" };
  const inlineEmpty = /^customModes:\s*\[\s*\]/.test(/** @type {string} */ (lines[head]));
  if (inlineEmpty) lines[head] = "customModes:";

  // 2) 목록 항목 나누기 — 항목은 같은 들여쓰기의 '- ' 로 시작하고, 더 깊은 줄은 그 항목에 붙는다
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    const l = /** @type {string} */ (lines[i]);
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    if (indentOf(l) === 0 && !l.startsWith("-")) {
      end = i;
      break;
    }
  }
  const firstItem = lines.slice(head + 1, end).find((l) => /^\s*- /.test(l) || /^\s*-$/.test(l));
  const pad = firstItem ? " ".repeat(indentOf(firstItem)) : "  ";
  /** @type {{ start: number, stop: number, slug: string | null }[]} */
  const items = [];
  for (let i = head + 1; i < end; i++) {
    const l = /** @type {string} */ (lines[i]);
    if (l.startsWith(`${pad}-`) && indentOf(l) === pad.length) items.push({ start: i, stop: i + 1, slug: null });
    else if (items.length && (l.trim() === "" || indentOf(l) > pad.length)) /** @type {{stop:number}} */ (items[items.length - 1]).stop = i + 1;
  }
  for (const it of items) {
    const body = lines.slice(it.start, it.stop).join("\n");
    const m = body.match(/(?:^|[\s{,])"?slug"?\s*:\s*["']?([A-Za-z0-9-]+)["']?/);
    it.slug = m ? /** @type {string} */ (m[1]) : null;
  }
  // 3) 지난번 우리 slug 는 표시가 없어져도 지운다(뒤에서부터)
  const prev = new Set(previous);
  for (const it of [...items].reverse()) if (it.slug && prev.has(it.slug)) lines.splice(it.start, it.stop - it.start);
  const userSlugs = new Set(items.filter((it) => it.slug && !prev.has(it.slug)).map((it) => it.slug));

  /** @type {string[]} */
  const installed = [];
  /** @type {string[]} */
  const kept = [];
  const block = [];
  for (const m of modes) {
    const slug = String(m["slug"]);
    if (userSlugs.has(slug)) {
      kept.push(slug);
      continue;
    }
    block.push(`${pad}- ${JSON.stringify(m)}`);
    installed.push(slug);
  }
  if (block.length) lines.splice(head + 1, 0, `${pad}${BEGIN}`, ...block, `${pad}${END}`);
  // 항목이 하나도 없으면 빈 목록으로 되돌린다
  const hasItem = lines.some((l, i) => i > head && /^\s*-( |$)/.test(l));
  if (!hasItem) lines[head] = "customModes: []";
  let out = lines.join(nl);
  if (!out.endsWith(nl)) out += nl;
  return { text: out, installed, kept };
}

/**
 * 조직 모드를 IDE 파일에 반영한다 — 파일이 없고 넣을 모드도 없으면 아무것도 하지 않는다.
 * @param {{ slug: string, body: string }[]} files @param {string[]} previous @param {NodeJS.ProcessEnv} [env]
 * @returns {{ file: string | null, installed: string[], kept: string[], invalid: string[], error?: string }}
 */
export function installIdeModes(files, previous, env = process.env) {
  const file = ideModesFile(env);
  /** @type {string[]} */
  const invalid = [];
  const modes = files.flatMap((f) => {
    const m = parseOrgMode(f.slug, f.body);
    if (!m) invalid.push(f.slug);
    return m ? [m] : [];
  });
  if (!file) return { file: null, installed: [], kept: [], invalid };
  const exists = existsSync(file);
  if (!exists && !modes.length) return { file, installed: [], kept: [], invalid };
  const r = mergeIdeModes(exists ? readFileSync(file, "utf8") : null, modes, previous);
  if ("error" in r) return { file, installed: [], kept: [], invalid, error: r.error };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, r.text, "utf8");
  return { file, installed: r.installed, kept: r.kept, invalid };
}
