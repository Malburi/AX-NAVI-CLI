/*
 * 새 판이 나왔는지 보고, 원하면 올려 준다.
 *
 * 플러그인일 때는 마켓플레이스가 갱신해 줬다. npm 전역 설치는 그런 것이 없어서,
 * 알려 주지 않으면 사용자는 몇 달 전 판을 계속 쓰면서 이미 고친 버그를 다시 겪는다.
 *
 * 설계에서 정한 선
 * - **시작을 막지 않는다.** 확인은 백그라운드로 하고, 늦게 오면 그냥 버린다.
 *   사내망에서 이 요청이 20초씩 걸리는 일이 실제로 있고, 그때 CLI 가 멈춰 보이면 안 된다.
 * - **하루에 한 번만 본다.** 매 실행마다 물으면 느리고 시끄럽다. 결과를 파일에 적어 둔다.
 * - **조용히 실패한다.** 폐쇄망에서는 확인 자체가 안 된다. 그건 오류가 아니다 —
 *   아무 말도 하지 않는 것이 맞다.
 * - 알리기만 하고 **스스로 올리지 않는다.** 전역 설치를 사용자 모르게 바꾸는 것은
 *   되돌리기 어려운 변경이다. 명령 한 줄을 보여 주고 `axnavi upgrade` 로 실행한다.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

const REPO = "Malburi/AX-NAVI-CLI";
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags`;
/** 설치에 쓰는 주소. git clone 경로는 사내망에서 막히므로 tarball 을 쓴다. */
export const installUrl = (/** @type {string} */ tag) =>
  `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`;

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

/** 확인 결과를 적어 두는 곳. 프로젝트가 아니라 사용자 홈이다 — 저장소마다 물을 일이 아니다. */
const statePath = () => join(homedir(), ".axnavi", "update-check.json");

/**
 * 버전 비교. `0.1.0-alpha.5` 같은 꼬리표까지 본다.
 *
 * semver 라이브러리를 쓰지 않는 이유는 이 저장소의 의존성이 0이기 때문이다.
 * 우리가 실제로 쓰는 모양(x.y.z 와 -alpha.N)만 다룬다.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} a 가 더 새것이면 양수
 */
export function compareVersions(a, b) {
  const parse = (/** @type {string} */ v) => {
    const [core = "", tail = ""] = v.replace(/^v/, "").split("-");
    const nums = core.split(".").map((n) => Number(n) || 0);
    // 꼬리표가 없는 쪽이 더 나중이다 — 1.0.0 은 1.0.0-alpha.9 보다 뒤다.
    const pre = tail ? Number(tail.split(".").pop()) || 0 : Infinity;
    return { nums, pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  return x.pre > y.pre ? 1 : -1;
}

/**
 * 가장 최근 태그를 묻는다. 실패하면 null.
 * @returns {Promise<string | null>}
 */
export async function resolveLatestTag() {
  const viaApi = await latestFromApi();
  if (viaApi) return viaApi;
  /*
   * Node 의 fetch 는 HTTPS_PROXY 같은 프록시 환경변수를 보지 않는다(Node 24 에서도 NODE_USE_ENV_PROXY=1 이
   * 있어야 본다). 외부 직접 연결이 막힌 사내망에서는 늘 "확인하지 못했습니다" 가 떴다(리뷰 실측).
   * git 은 https_proxy 와 http.proxy 설정을 따르므로 태그 목록을 git 으로 한 번 더 물어본다.
   */
  return latestFromGit();
}

/** @param {Iterable<string>} names */
function pickLatest(names) {
  /*
   * 목록의 첫 번째가 최신이라고 믿지 않는다 — GitHub 은 이름 순으로 주기도 한다.
   * 직접 비교해서 고른다.
   */
  let best = null;
  for (const name of names) {
    if (!/^v?\d+\.\d+\.\d+/.test(name)) continue;
    if (!best || compareVersions(name, best) > 0) best = name;
  }
  return best;
}

async function latestFromApi() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(TAGS_URL, {
      signal: controller.signal,
      headers: { "user-agent": "axnavi", accept: "application/vnd.github+json" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const tags = await res.json();
    if (!Array.isArray(tags) || !tags.length) return null;
    return pickLatest(tags.map((t) => (typeof t?.name === "string" ? t.name : "")));
  } catch {
    // 폐쇄망·프록시·시간 초과. 전부 정상적인 경우다.
    return null;
  }
}

function latestFromGit() {
  return new Promise((done) => {
    execFile("git", ["ls-remote", "--tags", "--refs", `https://github.com/${REPO}.git`], { timeout: TIMEOUT_MS * 2, windowsHide: true }, (error, stdout) => {
      if (error) return done(null);
      const names = String(stdout).split(/\r?\n/).map((line) => line.split("refs/tags/")[1] ?? "").filter(Boolean);
      done(pickLatest(names));
    });
  });
}

/**
 * 새 판이 있으면 알린다. **시작을 막지 않는다.**
 *
 * @param {string} current  지금 쓰는 판
 * @param {(line: string) => void} notify  알릴 자리. 늦게 와도 여기로 한 줄만 보낸다
 * @returns {void}
 */
export function checkForUpdate(current, notify) {
  const path = statePath();
  try {
    if (existsSync(path)) {
      const seen = JSON.parse(readFileSync(path, "utf8"));
      if (Date.now() - (seen.at ?? 0) < CHECK_EVERY_MS) {
        // 최근에 봤다. 그때 본 결과가 아직 유효하면 그것만 알린다.
        if (seen.latest && compareVersions(seen.latest, current) > 0) notify(seen.latest);
        return;
      }
    }
  } catch {
    // 못 읽으면 그냥 새로 본다.
  }

  // 여기서부터는 기다리지 않는다. 결과가 오면 알리고, 안 오면 아무 일도 없다.
  void resolveLatestTag().then((latest) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ at: Date.now(), latest }), "utf8");
    } catch {
      // 기록을 못 남겨도 알리는 것 자체는 할 수 있다.
    }
    if (latest && compareVersions(latest, current) > 0) notify(latest);
  });
}

/**
 * 실제로 올린다.
 *
 * **파일을 먼저 내려받고, 그 파일로 설치한다.** npm 에 주소를 바로 넘기지 않는 이유가 둘이다.
 *
 *   - npm 12 는 주소로 받는 설치를 기본으로 막는다(allow-remote=none → EALLOWREMOTE).
 *   - 사내 PC 에서 보안 프로그램이 node.exe 의 외부 연결만 막는 일이 있다. 실측(2026-09-28):
 *     같은 PC 에서 PowerShell 은 codeload.github.com 에 붙어 파일을 받았는데, npm 은
 *     `connect EACCES 20.200.245.246:443` 으로 거부됐다. 프록시 설정은 없었다.
 *
 * 그래서 운영체제 도구(Windows 는 PowerShell, 그 밖에는 curl)로 받는다. 설치 자체는 npm 에
 * 맡긴다 — 전역 설치 경로·권한·셈(shim) 을 흉내 내는 건 npm 이 이미 하는 일이다. 의존성은
 * npm 이 설정된 레지스트리(사내 Nexus 등)에서 받는다.
 * 내려받기가 안 되면 예전처럼 주소로 설치를 한 번 더 시도한다.
 *
 * @param {string} tag
 * @param {(line: string) => void} say
 * @returns {number} 종료 코드
 */
export function runUpgrade(tag, say) {
  const url = installUrl(tag);
  const file = join(tmpdir(), `axnavi-${tag}.tgz`);
  say(`내려받는 중입니다 — ${url}`);
  const fetched = download(url, file);

  const target = fetched.ok ? file : null;
  const args = target ? ["i", "-g", target] : installArgs(tag);
  if (!fetched.ok) say(`내려받지 못했습니다(${fetched.reason}). 주소로 바로 설치해 봅니다.`);
  say("설치 중입니다.");
  const out = runNpm(args);
  if (target) {
    try {
      rmSync(target, { force: true });
    } catch {
      // 임시 파일을 못 지워도 설치 결과와는 상관없다.
    }
  }
  if (out.status === 0) {
    say(`${tag} 로 올렸습니다. 다시 시작하면 적용됩니다.`);
    return 0;
  }
  /*
   * 실패하면 삼키지 않는다. 권한·프록시 문제는 사용자가 직접 봐야 고칠 수 있다.
   * 그리고 손으로 칠 명령을 그대로 보여 준다.
   */
  say((out.stderr || out.stdout || "").trim().split(String.fromCharCode(10)).slice(-4).join(String.fromCharCode(10)));
  say("직접 실행해 보세요:");
  for (const line of manualCommands(tag)) say(`  ${line}`);
  return out.status ?? 1;
}

/**
 * 파일을 내려받을 운영체제 명령. node 의 네트워크를 쓰지 않는다(위 runUpgrade 주석).
 *
 * @param {string} url
 * @param {string} file
 * @param {NodeJS.Platform} [platform]
 * @returns {{ cmd: string, args: string[] }}
 */
export function downloadCommand(url, file, platform = process.platform) {
  if (platform === "win32") {
    // 작은따옴표 문자열 안의 작은따옴표는 두 번 써서 넣는다(PowerShell 규칙).
    const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`;
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile", "-NonInteractive", "-Command",
        // 진행 막대를 끄지 않으면 PowerShell 5.1 에서 내려받기가 몇 배 느려진다.
        `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri ${q(url)} -OutFile ${q(file)} -UseBasicParsing`,
      ],
    };
  }
  return { cmd: "curl", args: ["-fsSL", "--retry", "2", "-o", file, url] };
}

/**
 * @param {string} url
 * @param {string} file
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function download(url, file) {
  const { cmd, args } = downloadCommand(url, file);
  const out = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 180_000 });
  if (out.error) return { ok: false, reason: out.error.message };
  if (out.status !== 0) return { ok: false, reason: failureReason(out.stderr || out.stdout || "") || `exit ${out.status}` };
  // 프록시가 돌려준 오류 페이지를 설치 파일로 넘기지 않는다. tar.gz 는 1f 8b 로 시작한다.
  try {
    const head = readFileSync(file).subarray(0, 2);
    if (head[0] !== 0x1f || head[1] !== 0x8b) return { ok: false, reason: "받은 파일이 설치 파일이 아닙니다" };
  } catch {
    return { ok: false, reason: "받은 파일이 없습니다" };
  }
  return { ok: true };
}

/**
 * 내려받기 오류에서 사람이 읽을 한 줄.
 *
 * PowerShell 오류는 첫 줄이 메시지이고 뒤는 위치·오류 ID 다. 마지막 줄을 쓰면
 * `FullyQualifiedErrorId : WebCmdletWebResponseException…` 만 보여 무엇이 틀렸는지 모른다(실측).
 *
 * @param {string} text
 * @returns {string}
 */
export function failureReason(text) {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return first.replace(/^Invoke-WebRequest\s*:\s*/i, "").replace(/^curl:\s*\(\d+\)\s*/, "").slice(0, 160);
}

/**
 * npm 을 부른다.
 *
 * Windows 에서 npm.cmd 는 셸을 거쳐야 돈다. 인자를 따로 넘기면서 shell 을 켜면 node 가
 * DEP0190(인자가 이스케이프되지 않는다) 경고를 화면에 찍으므로, 따옴표를 붙인 명령 한 줄로 넘긴다.
 *
 * @param {string[]} args
 */
function runNpm(args) {
  if (process.platform !== "win32") return spawnSync("npm", args, { encoding: "utf8" });
  return spawnSync(`npm ${args.map(quoteForCmd).join(" ")}`, { encoding: "utf8", shell: true });
}

/**
 * cmd.exe 에 넘길 인자 하나. 공백·특수문자가 있으면 큰따옴표로 감싼다.
 * @param {string} arg
 */
export function quoteForCmd(arg) {
  return /^[\w\-.:\\/=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * 자동 업그레이드가 안 될 때 손으로 칠 명령.
 * @param {string} tag
 * @returns {string[]}
 */
export function manualCommands(tag) {
  const url = installUrl(tag);
  if (process.platform === "win32") {
    return [
      `Invoke-WebRequest "${url}" -OutFile "$env:TEMP\\axnavi.tgz" -UseBasicParsing`,
      `npm i -g "$env:TEMP\\axnavi.tgz"`,
    ];
  }
  return [`curl -fsSL -o /tmp/axnavi.tgz ${url}`, "npm i -g /tmp/axnavi.tgz"];
}

/**
 * 설치에 넘길 npm 인자.
 *
 * `--allow-remote=all` 을 붙인다. npm 12 부터 `allow-remote` 기본값이 `none` 이라, URL 로 받는
 * 설치가 `EALLOWREMOTE` 로 거부된다(2026-09-28 실측, npm 12.0.2 — 설정 파일 어디에도 없는 기본값이었다).
 * npm 문서가 권하는 대로 의도한 URL 설치에만 명령 단위로 연다. 사용자 설정은 건드리지 않는다.
 * 이 옵션을 모르는 옛 npm 은 경고만 하고 설치를 계속한다.
 *
 * @param {string} tag
 * @returns {string[]}
 */
export function installArgs(tag) {
  return ["i", "-g", "--allow-remote=all", installUrl(tag)];
}

/**
 * 지금 설치된 판.
 *
 * package.json 에서 읽는다. 소스에 박아 두면 배포본과 갈라진다 — 실측으로
 * 배포본은 alpha.1 인데 --version 은 alpha.0 을 말한 적이 있다.
 *
 * @returns {string}
 */
export function readVersion() {
  try {
    const manifest = new URL("../../../package.json", import.meta.url);
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "0.0.0";
  } catch {
    // 버전을 못 읽었다고 실행을 막을 이유는 없다. 모른다고 말한다.
    return "(버전 미상)";
  }
}
