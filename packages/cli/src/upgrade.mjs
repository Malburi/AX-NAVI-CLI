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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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
    /*
     * 목록의 첫 번째가 최신이라고 믿지 않는다 — GitHub 은 이름 순으로 주기도 한다.
     * 직접 비교해서 고른다.
     */
    let best = null;
    for (const t of tags) {
      const name = typeof t?.name === "string" ? t.name : null;
      if (!name) continue;
      if (!best || compareVersions(name, best) > 0) best = name;
    }
    return best;
  } catch {
    // 폐쇄망·프록시·시간 초과. 전부 정상적인 경우다.
    return null;
  }
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
 * npm 을 그대로 부른다. 우리가 파일을 옮기려 들면 전역 설치 경로·권한·셈(shim) 을
 * 전부 흉내 내야 하고, 그건 npm 이 이미 하는 일이다.
 *
 * @param {string} tag
 * @param {(line: string) => void} say
 * @returns {number} 종료 코드
 */
export function runUpgrade(tag, say) {
  const url = installUrl(tag);
  say(`설치 중입니다 — ${url}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const out = spawnSync(npm, ["i", "-g", url], { encoding: "utf8", shell: process.platform === "win32" });
  if (out.status === 0) {
    say(`${tag} 로 올렸습니다. 다시 시작하면 적용됩니다.`);
    return 0;
  }
  /*
   * 실패하면 삼키지 않는다. 권한·프록시 문제는 사용자가 직접 봐야 고칠 수 있다.
   * 그리고 손으로 칠 명령을 그대로 보여 준다.
   */
  say((out.stderr || out.stdout || "").trim().split(String.fromCharCode(10)).slice(-4).join(String.fromCharCode(10)));
  say(`직접 실행해 보세요:  npm i -g ${url}`);
  return out.status ?? 1;
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
