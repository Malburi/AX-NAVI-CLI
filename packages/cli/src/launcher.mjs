/*
 * axnavi 런처 — 인덱스를 확인하고, AX Navi 플러그인 · 훅 · 설정을 실어 Claude Code 를 띄운다.
 *
 * 왜 런처인가. 비교 실험에서 axnavi 의 가치는 인덱스와 영향도에서 나왔고 자체 대화 화면에서 나오지 않았다.
 * 자체 화면(REPL · 선택 창 · 승인 창)은 수천 줄이고 계속 문제를 냈다 — 최근에는 인덱스를 다시 만드는 8분 30초
 * 동안 커서와 키 입력이 멈췄다. 실행기의 런타임 일(인덱스 신선도 · 사전 영향도 · 셸 소스 쓰기 승인 · 평가 1번 ·
 * EUC-KR 보존 · 고친 뒤 HOLD)은 이미 Claude Code 플러그인 훅으로 옮겨 두었다(packages/plugin/src/hooks.mjs).
 * 그래서 대화 화면은 Claude Code 것을 그대로 쓰고, 런처는 준비와 실행만 한다. 자체 화면은 `axnavi classic`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { discoverRoots, resolveProjectPaths } from "../../core/src/index.mjs";
import { pairInfo } from "../../core/src/config/roots.mjs";
import { hostPlugins } from "../../provider-agent-sdk/src/host-settings.mjs";
import { resolveClaudeBin } from "../../provider-claude-cli/src/index.mjs";
import { ensureFreshIndexesAsync } from "./freshness.mjs";
import { REPO_ROOT, ui } from "./runtime.mjs";

/**
 * Claude Code 실행 파일. 사용자가 설치한 claude 가 먼저다 — 그 사람의 로그인 · 설정을 그대로 쓴다.
 * 없으면 axnavi 와 함께 깔린 SDK 내장 실행 파일(폐쇄망 설치에서도 돈다).
 * @param {{ installed?: () => string | null, bundled?: () => string | null }} [probe]  시험에서 바꿔 끼운다
 * @returns {{ bin: string, source: "installed" | "bundled" } | null}
 */
export function pickClaudeBin(probe = {}) {
  const installed = (probe.installed ?? installedClaude)();
  if (installed) return { bin: installed, source: "installed" };
  const bundled = (probe.bundled ?? bundledClaude)();
  if (bundled) return { bin: bundled, source: "bundled" };
  return null;
}

/** @returns {string | null} */
function installedClaude() {
  const bin = resolveClaudeBin();
  if (!bin) return null;
  /* 윈도가 아니면 resolveClaudeBin 은 이름만 준다 — PATH 에 있는지는 실행해 보기 전엔 모른다. 실행 단계에서 실패를 알린다. */
  return bin;
}

/** @returns {string | null} */
export function bundledClaude() {
  const require = createRequire(import.meta.url);
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const names = [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`];
  for (const name of names) {
    try {
      const dir = dirname(require.resolve(`${name}/package.json`, { paths: [REPO_ROOT] }));
      if (existsSync(join(dir, exe))) return join(dir, exe);
    } catch { /* 이 플랫폼 패키지가 없다 */ }
  }
  return null;
}

/**
 * Claude Code 에 넘길 인자. 순수 함수 — 시험으로 고정한다.
 * @param {object} a
 * @param {string} a.pluginDir         AX Navi 플러그인 루트(axnavi 설치 루트)
 * @param {string[]} a.partnerRoots    함께 열 짝 저장소(작업 폴더 밖)
 * @param {string | null} a.settingsFile  마켓플레이스판 ax-navi 를 끄는 설정 파일(없으면 null)
 * @param {string[]} a.userArgs        사용자가 준 Claude Code 인자
 * @returns {string[]}
 */
export function buildLaunchArgs({ pluginDir, partnerRoots, settingsFile, userArgs }) {
  return [
    "--plugin-dir", pluginDir,
    ...partnerRoots.flatMap((root) => ["--add-dir", root]),
    ...(settingsFile ? ["--settings", settingsFile] : []),
    ...userArgs,
  ];
}

/**
 * 이미 설치된 마켓플레이스판 AX Navi 플러그인 — 런처가 같은 플러그인을 직접 싣으니 끈다(스킬 · 훅이 두 벌 돈다).
 * 사용자의 다른 플러그인은 건드리지 않는다.
 * @param {string[]} installed  hostPlugins() 결과
 * @returns {string[]}
 */
export function conflictingPlugins(installed) {
  return installed.filter((name) => /^ax-navi@/.test(name));
}

/**
 * axnavi 자체 옵션을 빼고 나머지를 Claude Code 인자로 넘긴다.
 * @param {string[]} argv
 * @returns {{ root: string, indexDir?: string, tier?: string, claudeArgs: string[] }}
 */
export function splitLauncherArgs(argv) {
  /** @type {{ root: string, indexDir?: string, tier?: string, claudeArgs: string[] }} */
  const out = { root: process.cwd(), claudeArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--root") out.root = argv[++i] ?? out.root;
    else if (arg === "--index-dir") out.indexDir = argv[++i];
    else if (arg === "--tier") out.tier = argv[++i];
    else out.claudeArgs.push(arg);
  }
  return out;
}

/**
 * 한 글자 키를 기다린다(Esc · Ctrl+C 는 null). TTY 가 아니면 기본값.
 * @param {string} question
 * @param {string} fallback
 * @returns {Promise<string>}
 */
function askKey(question, fallback) {
  if (!process.stdin.isTTY) return Promise.resolve(fallback);
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); done((answer || fallback).trim()); });
  });
}

/**
 * Esc · Ctrl+C 로 끊을 수 있는 동안 fn 을 돈다(인덱스 갱신 건너뛰기).
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withSkipKeys(fn) {
  const ctrl = new AbortController();
  const onSig = () => ctrl.abort();
  process.on("SIGINT", onSig);
  const tty = Boolean(process.stdin.isTTY);
  /** @param {Buffer} buf */
  const onKey = (buf) => { if (buf.includes(0x1b) || buf.includes(0x03)) ctrl.abort(); };
  if (tty) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onKey); }
  try {
    return await fn(ctrl.signal);
  } finally {
    process.off("SIGINT", onSig);
    if (tty) { process.stdin.off("data", onKey); process.stdin.setRawMode(false); process.stdin.pause(); }
  }
}

/*
 * 바깥 Claude Code 세션이 남긴 표식. 이것을 물려받으면 띄운 Claude Code 가 자기를 하위 세션으로 알고
 * 대화를 저장하지 않는다(실측: "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker") —
 * 그러면 axnavi -c · --resume 이 이어갈 대화가 없다. AXNAVI_ENCODING_HOOK 은 axnavi 실행기가 켜는 값이라
 * 물려받으면 플러그인 훅이 스스로 비켜 버린다.
 */
const PARENT_SESSION_ENV = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "AXNAVI_ENCODING_HOOK"];

/**
 * 띄울 Claude Code 에 넘길 환경 — 바깥 세션 표식만 뺀다. 사용자 설정(ANTHROPIC_* · CLAUDE_EFFORT 등)은 그대로.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function launchEnv(env) {
  const out = { ...env };
  for (const key of PARENT_SESSION_ENV) delete out[key];
  return out;
}

/**
 * 찾은 저장소에 pair_config 의 짝 저장소를 더한다(있는 폴더만, 중복 없이).
 * discoverRoots 는 선 자리에 인덱스가 있으면 거기서 멈춘다 — 백엔드 폴더에서 띄우면 프론트엔드가 빠져
 * Claude Code 가 짝 저장소를 읽을 권한(--add-dir)도, 신선도 확인도 받지 못했다(실측: "읽기 권한이 없어 인덱스 결과만").
 * @param {import("../../core/types/paths.js").ProjectPaths[]} roots
 * @param {(dir: string) => string[]} [partnersOf]  시험에서 바꿔 끼운다
 */
export function withPairPartners(roots, partnersOf = (dir) => pairInfo(dir).partners.filter((p) => existsSync(p))) {
  const seen = new Set(roots.map((p) => resolve(p.root).toLowerCase()));
  const out = [...roots];
  for (const p of roots) {
    for (const partner of partnersOf(p.root)) {
      const key = resolve(partner).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(resolveProjectPaths(partner));
    }
  }
  return out;
}

/**
 * 런처 본체.
 * @param {string[]} argv  bin.mjs 가 넘긴 인자(하위 명령이 아닌 것)
 * @param {string} version
 * @returns {Promise<number>}
 */
export async function launch(argv, version) {
  const opts = splitLauncherArgs(argv);
  const paths = resolveProjectPaths(opts.root, opts.indexDir);
  const discovery = discoverRoots(opts.root);
  const roots = withPairPartners(discovery.roots.length ? discovery.roots.map((r) => r.paths) : [paths]);
  const interactive = !opts.claudeArgs.some((a) => a === "-p" || a === "--print");
  const say = (/** @type {string} */ line) => process.stderr.write(`${line}\n`);

  /* ② 실행 파일부터 — 없으면 준비할 이유가 없다 */
  const picked = pickClaudeBin();
  if (!picked) {
    say(`${ui.red("Claude Code 실행 파일을 찾지 못했습니다.")}`);
    say(ui.dim("  npm i -g @anthropic-ai/claude-code 로 설치하거나, axnavi 를 선택 의존성까지 포함해 다시 설치하세요."));
    say(ui.dim("  자체 대화 화면으로 쓰려면: axnavi classic"));
    return 1;
  }

  /* ① 배너 · 인덱스 */
  const indexed = roots.filter((p) => existsSync(join(p.indexDir ?? join(p.root, "_workspace", "index"), "_meta.json")));
  if (interactive) {
    say(`${ui.cyan("AX Navi")} ${ui.dim(`v${version}`)}  ${roots.map((p) => `${basename(p.root)}${indexed.includes(p) ? "" : ui.dim("(인덱스 없음)")}`).join(" · ")}`);
  }
  if (!indexed.length && interactive) {
    const answer = await askKey(`  인덱스가 없습니다. ${ui.cyan("1")} 지금 만들기(AI 0원, 수십 초)  ${ui.cyan("2")} 그냥 시작  [1/2] `, "2");
    if (answer === "1") {
      const { cmdIndex } = await import("./commands.mjs");
      for (const p of roots) await cmdIndex(p.root, "build", { ...(opts.tier ? { tier: opts.tier } : {}) });
    } else {
      say(ui.dim("  Claude Code 에서 \"하네스 초기화 해줘\" 또는 \"인덱스만 만들어줘\" 라고 하면 만들 수 있습니다."));
    }
  } else if (indexed.length) {
    const tty = Boolean(process.stderr.isTTY) && interactive;
    let label = "";
    const notes = await withSkipKeys((signal) => ensureFreshIndexesAsync(
      indexed.map((p) => ({ root: p.root, ...(p.indexDir ? { indexDir: p.indexDir } : {}), primary: p.root === (discovery.primary?.root ?? paths.root) })),
      {
        signal,
        onStart: (r, why) => {
          label = `인덱스 갱신 중 — ${basename(r)} (${why})`;
          process.stderr.write(tty ? ui.dim(`  ${label} · 0초 · Esc 로 건너뛰기`) : ui.dim(`  ${label}\n`));
        },
        onTick: (_r, sec) => { if (tty) process.stderr.write(`\r\x1b[2K${ui.dim(`  ${label} · ${sec}초 · Esc 로 건너뛰기`)}`); },
      },
    ));
    for (const n of notes) {
      if (n.state === "rebuilt" && tty) process.stderr.write(`\r\x1b[2K${ui.dim(`  인덱스 갱신 완료 — ${basename(n.root)} · ${Math.round((n.ms ?? 0) / 1000)}초`)}\n`);
      if (n.state === "failed") process.stderr.write(`\r\x1b[2K${ui.yellow(`  ! 인덱스 ${basename(n.root)}: ${n.reason}`)}\n`);
      if (n.state === "skipped" && n.reason.startsWith("중단")) process.stderr.write(`\r\x1b[2K${ui.yellow(`  인덱스 갱신을 건너뛰었습니다 — 옛 인덱스로 진행합니다 (${basename(n.root)})`)}\n`);
    }
  }

  /* ③ 인자 · 설정 */
  const conflicts = conflictingPlugins(hostPlugins());
  let settingsFile = null;
  if (conflicts.length) {
    settingsFile = join(mkdtempSync(join(tmpdir(), "axnavi-launch-")), "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ enabledPlugins: Object.fromEntries(conflicts.map((n) => [n, false])) }), "utf8");
  }
  const cwd = discovery.primary?.root ?? paths.root;
  const partnerRoots = roots.map((p) => p.root).filter((r) => r !== cwd);
  const args = buildLaunchArgs({ pluginDir: REPO_ROOT, partnerRoots, settingsFile, userArgs: opts.claudeArgs });
  if (interactive) say(ui.dim(`  Claude Code 를 띄웁니다${picked.source === "bundled" ? " (axnavi 내장 실행 파일)" : ""} — /ax-navi: 로 시작하는 명령이나 말로 부탁하세요.\n`));

  /* ④ 실행 — 화면 · 키 입력은 Claude Code 가 가진다 */
  return new Promise((done) => {
    const child = spawn(picked.bin, args, { stdio: "inherit", cwd, env: launchEnv(process.env) });
    const ignore = () => { /* Ctrl+C 는 Claude Code 가 받는다 */ };
    process.on("SIGINT", ignore);
    child.on("error", (error) => {
      process.off("SIGINT", ignore);
      say(ui.red(`Claude Code 를 띄우지 못했습니다 — ${error.message}`));
      done(1);
    });
    child.on("close", (code) => { process.off("SIGINT", ignore); done(code ?? 0); });
  });
}
