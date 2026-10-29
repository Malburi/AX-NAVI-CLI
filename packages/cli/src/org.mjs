/*
 * `axnavi org` — HNIX AX 플랫폼에서 조직 설정 배포본을 받는다.
 *
 * 켜는 법은 Insight 보내기와 같다: HNIX_AX_SERVER 와 HNIX_AX_KEY(각자의 플랫폼 키, 권한 무관).
 * 없으면 아무것도 하지 않는다(폐쇄망·개인 사용에서 외부 호출 0건).
 *
 * 시작할 때 자동으로(마지막으로 받은 지 10분이 지났으면) 받는다. 서버에 닿지 않으면 지난 배포본을
 * 그대로 쓰고 실행을 막지 않는다. 바뀌지 않았으면 서버가 304 로 답한다(ETag = 배포본 hash).
 */
import { installOrgBundle, readOrgState, touchOrgState } from "../../core/src/config/org.mjs";
import { insightTarget } from "./insight.mjs";
import { ui } from "./runtime.mjs";

const AUTO_EVERY_MS = 10 * 60_000;

/**
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number, fetchFn?: typeof fetch, version?: string }} [opts]
 * @returns {Promise<{ status: "off" } | { status: "same", hash: string } | { status: "updated", hash: string, profiles: { name: string, version: number }[], written: number, removed: number, ideRules: number, ideSkills: number, skipped: string[] } | { status: "error", message: string }>}
 */
export async function pullOrg(opts = {}) {
  const env = opts.env ?? process.env;
  const target = insightTarget(env);
  if (!target) return { status: "off" };
  const prev = readOrgState(env);
  const f = opts.fetchFn ?? fetch;
  try {
    const r = await f(`${target.server}/api/v1/axnavi/bundle`, {
      headers: { authorization: `Bearer ${target.key}`, "user-agent": `axnavi/${opts.version ?? "dev"}`, ...(prev.hash ? { "if-none-match": `"${prev.hash}"` } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (r.status === 304 && prev.hash) {
      touchOrgState(env);
      return { status: "same", hash: prev.hash };
    }
    if (!r.ok) return { status: "error", message: `서버가 ${r.status} 로 답했습니다${r.status === 401 ? " — HNIX_AX_KEY 를 확인하세요" : ""}.` };
    const bundle = /** @type {import("../../core/src/config/org.mjs").OrgBundle} */ (await r.json());
    const res = installOrgBundle(bundle, { env, server: target.server });
    return { status: "updated", hash: bundle.hash, profiles: bundle.profiles ?? [], ...res };
  } catch (error) {
    return { status: "error", message: /** @type {Error} */ (error).message };
  }
}

/** 시작할 때 — 10분이 지났을 때만, 짧게 기다리고, 실패해도 조용히 @param {NodeJS.ProcessEnv} [env] */
export async function autoPullOrg(env = process.env) {
  if (!insightTarget(env) || env["AXNAVI_ORG_AUTO"] === "0") return null;
  const s = readOrgState(env);
  if (s.fetchedAt && Date.now() - Date.parse(s.fetchedAt) < AUTO_EVERY_MS) return null;
  return pullOrg({ env, timeoutMs: 2500 });
}

/** @param {string} sub @param {{ version?: string }} [opts] */
export async function cmdOrg(sub = "status", opts = {}) {
  if (sub === "pull") {
    const r = await pullOrg({ ...(opts.version ? { version: opts.version } : {}) });
    if (r.status === "off") {
      process.stdout.write(`${ui.dim("HNIX_AX_SERVER 와 HNIX_AX_KEY 가 없어 받지 않았습니다 — 조직 설정 배포를 쓰려면 둘 다 설정하세요.")}\n`);
      return 0;
    }
    if (r.status === "error") {
      process.stderr.write(`${ui.red("받지 못했습니다")}: ${r.message}\n`);
      return 1;
    }
    if (r.status === "same") {
      process.stdout.write(`바뀐 것이 없습니다 (${r.hash.slice(0, 10)})\n`);
      return 0;
    }
    process.stdout.write(`받았습니다 — ${r.profiles.map((p) => `${p.name} v${p.version}`).join(", ") || "해당 묶음 없음"} · 파일 ${r.written}개${r.removed ? ` · 지움 ${r.removed}` : ""}${r.ideRules || r.ideSkills ? ` · IDE 규칙 ${r.ideRules}·스킬 ${r.ideSkills}` : ""}\n`);
    if (r.skipped.length) process.stdout.write(`${ui.yellow("넣을 수 없는 경로라 건너뜀")}: ${r.skipped.join(", ")}\n`);
    return 0;
  }
  if (sub === "status") {
    const s = readOrgState();
    if (!s.hash) {
      process.stdout.write(`${ui.dim("받은 조직 설정이 없습니다 — axnavi org pull")}\n`);
      return 0;
    }
    process.stdout.write(
      [
        `배포본 ${s.hash.slice(0, 10)} · ${s.server ?? ""} · 받은 시각 ${s.fetchedAt ?? "-"}`,
        `묶음: ${s.profiles.map((p) => `${p.name} v${p.version}`).join(", ") || "없음"}`,
        `파일: ${s.files.join(", ") || "없음"}`,
        ...(s.ideRules.length || s.ideSkills.length ? [`IDE: 규칙 ${s.ideRules.join(", ") || "-"} · 스킬 ${s.ideSkills.join(", ") || "-"}`] : []),
      ].join("\n") + "\n",
    );
    return 0;
  }
  process.stderr.write("사용법: axnavi org [pull|status]\n");
  return 2;
}
