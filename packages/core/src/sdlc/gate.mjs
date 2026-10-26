/*
 * 단계 게이트 — 요구 → 설계 → 개발 → 테스트. 뒤 단계 게이트는 앞 단계 검사를 모두 다시 본다.
 *
 *   필수(required) 실패 → STOP  (산출물 없음·필수 절 미작성·리뷰 STOP·치명 보안 결함)
 *   권고(recommended) 실패 → HOLD (미승인 문서·채우지 못한 자리·ADR 없음·리뷰 HOLD·높음 보안 결함)
 *   모두 통과 → GO
 *
 * 종료 코드는 review 와 같다(GO 0 · HOLD 3 · STOP 4) — CI 에서 같은 방식으로 다룬다.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, runReview, runSecurityScan } from "../review/index.mjs";
import { listAdrs } from "./adr.mjs";
import { createArtifact, kstDateTime, listArtifacts } from "./artifacts.mjs";
import { PHASES, PHASE_LABEL, inspectDocument, loadTemplate } from "./templates.mjs";

/**
 * @typedef {{ id: string, phase: string, title: string, level: "required" | "recommended", ok: boolean, detail: string }} GateCheck
 * @typedef {{ phase: string, verdict: "GO" | "HOLD" | "STOP", exitCode: number, checks: GateCheck[], recorded: string | null, generatedAt: string }} GateResult
 */

/**
 * @param {any} paths  resolveProjectPaths 결과
 * @param {string} phase  req | design | dev | test
 * @param {{ range?: string, staged?: boolean, skipReview?: boolean, record?: boolean, now?: Date, env?: NodeJS.ProcessEnv,
 *           review?: typeof runReview, scan?: typeof runSecurityScan }} [opts]
 * @returns {GateResult}
 */
export function runGate(paths, phase, opts = {}) {
  const upto = PHASES.indexOf(/** @type {any} */ (phase));
  if (upto < 0) throw new Error(`알 수 없는 단계: ${phase} (${PHASES.join(" | ")})`);
  const env = opts.env ?? process.env;
  const artifacts = listArtifacts(paths, env);
  /** @type {GateCheck[]} */
  const checks = [];
  const add = (/** @type {Omit<GateCheck, "ok"> & { ok: boolean }} */ c) => checks.push(c);

  for (const p of PHASES.slice(0, upto + 1)) {
    for (const a of artifacts.filter((x) => x.phase === p && x.kind !== "progress")) {
      const id = `doc:${a.kind}`;
      if (!a.exists) {
        add({ id, phase: p, title: `${a.title} 작성`, level: "required", ok: false, detail: `없음 — \`axnavi doc new ${a.kind}\` 로 양식을 만든다` });
        continue;
      }
      const lacking = [...a.missingSections.map((s) => `${s}(절 없음)`), ...a.incomplete];
      add({ id, phase: p, title: `${a.title} 필수 절`, level: "required", ok: lacking.length === 0,
        detail: lacking.length ? `미작성: ${lacking.join(", ")}` : `${a.required.length}개 절 작성됨` });
      add({ id: `${id}:approved`, phase: p, title: `${a.title} 승인`, level: "recommended", ok: a.status === "승인",
        detail: `문서 상태 ${a.status ?? "미기재"}${a.status === "승인" ? "" : " — 검토 후 머리말의 상태를 승인으로 바꾼다"}` });
      if (a.unresolved.length) {
        add({ id: `${id}:facts`, phase: p, title: `${a.title} 자동 항목`, level: "recommended", ok: false,
          detail: `채우지 못한 자리: ${a.unresolved.map((u) => `{{${u}}}`).join(", ")}` });
      }
    }

    if (p === "design") {
      const adrs = listAdrs(paths);
      add({ id: "adr:exists", phase: p, title: "아키텍처 결정 기록", level: "recommended", ok: adrs.length > 0,
        detail: adrs.length ? `ADR ${adrs.length}건` : "ADR 없음 — 설계 결정이 있었다면 `axnavi adr new \"<제목>\"` 로 남긴다" });
      const proposed = adrs.filter((a) => a.status === "제안");
      if (proposed.length) {
        add({ id: "adr:decided", phase: p, title: "ADR 결정", level: "recommended", ok: false,
          detail: `제안 상태 ${proposed.length}건: ${proposed.map((a) => `ADR-${a.no}`).join(", ")}` });
      }
      if (adrs.length) {
        const tpl = loadTemplate("adr", paths, env);
        const empty = adrs.filter((a) => inspectDocument(readFileSync(a.file, "utf8"), tpl).incomplete.length);
        if (empty.length) {
          add({ id: "adr:written", phase: p, title: "ADR 내용", level: "recommended", ok: false,
            detail: `맥락·결정·결과 미작성: ${empty.map((a) => `ADR-${a.no}`).join(", ")}` });
        }
      }
    }

    if (p === "dev") {
      if (opts.skipReview) {
        add({ id: "review", phase: p, title: "변경 리뷰", level: "recommended", ok: false, detail: "건너뜀(--skip-review)" });
      } else {
        try {
          const r = (opts.review ?? runReview)({
            root: paths.root, indexDir: paths.indexDir,
            ...(opts.range ? { range: opts.range } : {}), ...(opts.staged ? { staged: true } : {}),
          });
          add({ id: "review", phase: p, title: "변경 리뷰", level: r.verdict === "STOP" ? "required" : "recommended",
            ok: r.verdict === "GO", detail: `${r.verdict} — 종합 ${r.composite} · 대상 ${r.target} · 변경 파일 ${r.files.length}개` });
        } catch (error) {
          add({ id: "review", phase: p, title: "변경 리뷰", level: "recommended", ok: false,
            detail: `리뷰를 돌리지 못함: ${String(/** @type {Error} */ (error).message).split("\n")[0]}` });
        }
      }
    }

    if (p === "test") {
      // 저장된 security_scan.json 은 믿지 않는다 — 일부 경로만 점검한 결과이거나 그 뒤에 코드가 바뀌었을 수 있다(10/25 리뷰).
      // 전수 점검은 규칙 엔진만 돌아 수천 파일도 수 초면 끝난다.
      const scan = (opts.scan ?? runSecurityScan)({ root: paths.root });
      const from = "이번 실행";
      const b = scan.bySeverity ?? { critical: 0, high: 0 };
      add({ id: "security:critical", phase: p, title: "치명 보안 결함", level: "required", ok: b.critical === 0, detail: `${b.critical}건 (${from})` });
      add({ id: "security:high", phase: p, title: "높음 보안 결함", level: "recommended", ok: b.high === 0, detail: `${b.high}건 (${from})` });
    }
  }

  const stop = checks.some((c) => !c.ok && c.level === "required");
  const hold = checks.some((c) => !c.ok);
  const verdict = stop ? "STOP" : hold ? "HOLD" : "GO";
  const now = opts.now ?? new Date();
  /** @type {GateResult} */
  const result = { phase, verdict, exitCode: EXIT[verdict], checks, recorded: null, generatedAt: now.toISOString() };
  if (opts.record) result.recorded = recordGate(paths, result, now, env);
  return result;
}

/**
 * 진행 기록서의 "단계 게이트 이력" 표에 한 줄 덧붙인다. 진행 기록서가 없으면 만든다.
 * @param {any} paths
 * @param {GateResult} r
 * @param {Date} now
 * @param {NodeJS.ProcessEnv} env
 */
function recordGate(paths, r, now, env) {
  const { file } = createArtifact(paths, "progress", { now, env });
  const req = r.checks.filter((c) => c.level === "required");
  const rec = r.checks.filter((c) => c.level === "recommended");
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.title).slice(0, 3).join(", ");
  const summary = `필수 ${req.filter((c) => c.ok).length}/${req.length} · 권고 ${rec.filter((c) => c.ok).length}/${rec.length}${failed ? ` · ${failed}` : ""}`;
  const text = readFileSync(file, "utf8");
  appendFileSync(file, `${text.endsWith("\n") ? "" : "\n"}| ${kstDateTime(now)} | ${PHASE_LABEL[/** @type {"req"} */ (r.phase)]} | ${r.verdict} | ${summary.replace(/\|/g, "/")} |\n`, "utf8");
  return file;
}

/** @param {GateResult} r */
export function renderGateMarkdown(r) {
  const icon = (/** @type {GateCheck} */ c) => (c.ok ? "✅" : c.level === "required" ? "⛔" : "⚠️");
  const lines = [
    `# 단계 게이트 — ${PHASE_LABEL[/** @type {"req"} */ (r.phase)]} (${r.phase})`,
    "",
    `**판정: ${r.verdict}** · 종료 코드 ${r.exitCode}`,
    "",
    "| | 단계 | 항목 | 구분 | 내용 |",
    "|---|---|---|---|---|",
    ...r.checks.map((c) => `| ${icon(c)} | ${PHASE_LABEL[/** @type {"req"} */ (c.phase)]} | ${c.title} | ${c.level === "required" ? "필수" : "권고"} | ${c.detail.replace(/\|/g, "/")} |`),
    "",
  ];
  if (r.recorded) lines.push(`진행 기록서에 기록했다: \`${r.recorded}\``, "");
  return lines.join("\n");
}
