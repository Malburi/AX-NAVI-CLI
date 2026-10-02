/*
 * 인덱스 신선도 — 모델이 아니라 런타임이 확인한다.
 *
 * v1 은 스킬 본문 6곳이 모델에게 `build-index.mjs --check-stale` 을 Bash 로 돌리게 했다. 실행마다 도구 호출
 * 한두 번과 그 출력을 읽는 토큰이 들었고, 모델이 건너뛰면 낡은 인덱스로 답했다. 확인은 결정적인 일이라
 * 실행 전에 여기서 한다. 바뀐 파일이 있으면 그 자리에서 다시 만든다(LLM 0원).
 *
 * 짝 저장소가 바뀌었으면 기준 저장소도 다시 만든다 — 기준 저장소의 디스패치 연결(partner_links)이 짝 저장소
 * 인덱스를 읽어 만들어지기 때문이다. 그래서 짝 저장소를 먼저, 기준 저장소를 나중에 만든다.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildIndex, clearIndexCache, indexStaleness, resolveIndexDir } from "../../indexer/index.mjs";

/**
 * @typedef {object} FreshnessNote
 * @property {string} root
 * @property {"fresh" | "rebuilt" | "failed" | "skipped"} state
 * @property {string} reason
 * @property {number} [ms]
 */

/**
 * @param {string} root
 * @param {string} [indexDir]
 * @returns {"Auto" | "Standard" | "Full"}
 */
function tierOf(root, indexDir) {
  try {
    const meta = JSON.parse(readFileSync(join(resolveIndexDir(root, indexDir), "_meta.json"), "utf8"));
    return meta.tier === "Full" || meta.tier === "Standard" ? meta.tier : "Auto";
  } catch {
    return "Auto";
  }
}

/**
 * 인덱스가 있는 저장소만 본다(없으면 만들지 않는다 — 처음 만드는 일은 사용자가 정한다).
 * @param {Array<{ root: string, indexDir?: string, primary?: boolean }>} roots
 * @param {{ onStart?: (root: string, reason: string) => void, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {FreshnessNote[]}
 */
export function ensureFreshIndexes(roots, opts = {}) {
  const env = opts.env ?? process.env;
  if (env["AXNAVI_NO_AUTO_INDEX"] === "1") return roots.map((r) => ({ root: r.root, state: "skipped", reason: "AXNAVI_NO_AUTO_INDEX=1" }));
  /** @type {FreshnessNote[]} */
  const notes = [];
  const ordered = [...roots.filter((r) => !r.primary), ...roots.filter((r) => r.primary)];
  let partnerRebuilt = false;
  for (const item of ordered) {
    const dir = resolveIndexDir(item.root, item.indexDir);
    if (!existsSync(join(dir, "_meta.json"))) { notes.push({ root: item.root, state: "skipped", reason: "인덱스 없음" }); continue; }
    let stale;
    try {
      stale = indexStaleness(item.root, item.indexDir);
    } catch (error) {
      notes.push({ root: item.root, state: "failed", reason: `신선도 확인 실패: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const mustRebuild = stale.stale || (item.primary && partnerRebuilt);
    if (!mustRebuild) { notes.push({ root: item.root, state: "fresh", reason: stale.reason }); continue; }
    const reason = stale.stale ? stale.reason : "짝 저장소가 바뀌어 연결을 다시 만듭니다";
    opts.onStart?.(item.root, reason);
    const started = Date.now();
    try {
      buildIndex({ root: item.root, mode: "incremental", tier: tierOf(item.root, item.indexDir), ...(item.indexDir ? { indexDir: item.indexDir } : {}) });
      notes.push({ root: item.root, state: "rebuilt", reason, ms: Date.now() - started });
      if (!item.primary) partnerRebuilt = true;
    } catch (error) {
      notes.push({ root: item.root, state: "failed", reason: `다시 만들지 못함: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (notes.some((n) => n.state === "rebuilt")) clearIndexCache();
  return notes;
}

/*
 * 화면이 멈춰 보이지 않게 — 다시 만들기를 별도 프로세스로 돌리는 판.
 *
 * buildIndex 는 동기 함수라 같은 프로세스에서 돌리면 끝날 때까지 이벤트 루프가 서서 회전자도 커서도 키 입력도
 * 멈춘다. 실측(사용자 PC, 인덱서 판이 바뀐 직후의 첫 /modify): 8분 30초 동안 "인덱스 갱신 중" 한 줄만 떠 있었다.
 * 자식 프로세스로 돌리고, 그동안 onTick 으로 경과 시간을 알린다. signal 이 끊기면 자식을 끝내고 옛 인덱스로 진행한다.
 */

const BUILD_INDEX = fileURLToPath(new URL("../../../agents/lib/build-index.mjs", import.meta.url));

/**
 * @param {Array<{ root: string, indexDir?: string, primary?: boolean }>} roots
 * @param {{ onStart?: (root: string, reason: string) => void, onTick?: (root: string, seconds: number) => void, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<FreshnessNote[]>}
 */
export async function ensureFreshIndexesAsync(roots, opts = {}) {
  const env = opts.env ?? process.env;
  if (env["AXNAVI_NO_AUTO_INDEX"] === "1") return roots.map((r) => ({ root: r.root, state: /** @type {const} */ ("skipped"), reason: "AXNAVI_NO_AUTO_INDEX=1" }));
  /** @type {FreshnessNote[]} */
  const notes = [];
  const ordered = [...roots.filter((r) => !r.primary), ...roots.filter((r) => r.primary)];
  let partnerRebuilt = false;
  for (const item of ordered) {
    if (opts.signal?.aborted) { notes.push({ root: item.root, state: "skipped", reason: "중단" }); continue; }
    const dir = resolveIndexDir(item.root, item.indexDir);
    if (!existsSync(join(dir, "_meta.json"))) { notes.push({ root: item.root, state: "skipped", reason: "인덱스 없음" }); continue; }
    let stale;
    try {
      stale = indexStaleness(item.root, item.indexDir);
    } catch (error) {
      notes.push({ root: item.root, state: "failed", reason: `신선도 확인 실패: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!(stale.stale || (item.primary && partnerRebuilt))) { notes.push({ root: item.root, state: "fresh", reason: stale.reason }); continue; }
    const reason = stale.stale ? stale.reason : "짝 저장소가 바뀌어 연결을 다시 만듭니다";
    opts.onStart?.(item.root, reason);
    const started = Date.now();
    const args = [BUILD_INDEX, "--root", item.root, "--mode", "incremental", "--tier", tierOf(item.root, item.indexDir), "--quiet", ...(item.indexDir ? ["--index-dir", item.indexDir] : [])];
    const code = await new Promise((done) => {
      const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      const tick = setInterval(() => opts.onTick?.(item.root, Math.round((Date.now() - started) / 1000)), 1000);
      const stop = () => child.kill();
      opts.signal?.addEventListener("abort", stop, { once: true });
      child.on("close", (c) => { clearInterval(tick); opts.signal?.removeEventListener("abort", stop); done(c === 0 ? 0 : (err.trim().split("\n").at(-1) || `exit ${c}`)); });
      child.on("error", (e) => { clearInterval(tick); done(e.message); });
    });
    if (code === 0) {
      notes.push({ root: item.root, state: "rebuilt", reason, ms: Date.now() - started });
      if (!item.primary) partnerRebuilt = true;
    } else {
      notes.push({ root: item.root, state: opts.signal?.aborted ? "skipped" : "failed", reason: opts.signal?.aborted ? "중단 — 옛 인덱스로 진행" : `다시 만들지 못함: ${code}` });
    }
  }
  if (notes.some((n) => n.state === "rebuilt")) clearIndexCache();
  return notes;
}
