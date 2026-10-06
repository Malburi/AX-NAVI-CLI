#!/usr/bin/env node
/*
 * Claude Code 플러그인 저장소(Malburi/AX-NAVI-V2) 빌드 — 이 저장소의 에이전트 · 스킬 · 인덱서와,
 * 플러그인 훅이 쓰는 런타임 모듈만 골라 플러그인 저장소 사본에 맞춘다. CLI 실행기(REPL · provider)는 넣지 않는다.
 *
 *   node scripts/build-plugin.mjs <플러그인 저장소 사본 경로>
 *
 * 아래 목록의 경로만 지우고 다시 쓴다. 플러그인 저장소에만 있는 파일(안내 HTML · .github 등)은 그대로 둔다.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(OUT, ".git"))) {
  process.stderr.write("사용법: node scripts/build-plugin.mjs <플러그인 저장소 git 사본>\n");
  process.exit(2);
}

/** 통째로 맞출 폴더 · 파일 */
const TREES = ["agents", "skills", "sql", "docs/site", "docs/index-schema", "CLAUDE.md"];
/** 훅 런타임 — 이 파일들과 그것이 부르는 것만 */
const RUNTIME = [
  "packages/plugin/src/hooks.mjs",
  "packages/core/src/safety/write-guard.mjs",
  "packages/core/src/safety/review-budget.mjs",
  "packages/core/src/context/sessions.mjs",
  "packages/provider-claude-cli/src/legacy-encoding.mjs",
  "packages/provider-claude-cli/src/legacy-encoding-hook.mjs",
  "packages/provider-claude-cli/src/disk-scan-guard.mjs",
  "packages/cli/src/turn-audit.mjs",
  "packages/cli/src/post-verify.mjs",
  "packages/cli/src/freshness.mjs",
  "packages/cli/src/precompute.mjs",
  "packages/indexer/index.mjs",
];
const skip = (/** @type {string} */ p) => /[\\/](__pycache__|node_modules)([\\/]|$)/.test(p);

for (const rel of TREES) {
  rmSync(join(OUT, rel), { recursive: true, force: true });
  if (!existsSync(join(SRC, rel))) continue;
  mkdirSync(dirname(join(OUT, rel)), { recursive: true });
  cpSync(join(SRC, rel), join(OUT, rel), { recursive: true, filter: (p) => !skip(p) });
}
rmSync(join(OUT, "packages"), { recursive: true, force: true });
for (const rel of RUNTIME) {
  mkdirSync(dirname(join(OUT, rel)), { recursive: true });
  cpSync(join(SRC, rel), join(OUT, rel));
}
/* 훅 · README · 매니페스트 */
mkdirSync(join(OUT, "hooks"), { recursive: true });
cpSync(join(SRC, "hooks", "hooks.json"), join(OUT, "hooks", "hooks.json"));
cpSync(join(SRC, "plugin", "README.md"), join(OUT, "README.md"));
mkdirSync(join(OUT, ".claude-plugin"), { recursive: true });
for (const f of ["plugin.json", "marketplace.json"]) cpSync(join(SRC, ".claude-plugin", f), join(OUT, ".claude-plugin", f));
/* 플러그인 판은 CLI 판에서 따온다: CLI 2.0.0-alpha.N → 플러그인 0.3.N */
const cliVersion = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
const n = /alpha\.(\d+)/.exec(cliVersion)?.[1] ?? "0";
const manifest = JSON.parse(readFileSync(join(OUT, ".claude-plugin", "plugin.json"), "utf8"));
manifest.version = `0.3.${n}`;
manifest.description = "ITO/SI/SM 레거시를 위한 Claude Code 플러그인 — 19 agents + 17 workflow skills + 7 단축 별칭. 인덱스 2.0(문자열 디스패치 · 위치로 읽는 화면 · 저장소를 넘는 impact), 셸 소스 쓰기 승인 · 고친 뒤 확인 훅";
writeFileSync(join(OUT, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
/* 노드가 .mjs 를 ESM 으로 읽으므로 package.json 은 필요 없다. 실행 확인용으로 판만 남긴다. */
writeFileSync(join(OUT, "packages", "VERSION"), `AX-NAVI-CLI ${cliVersion} 에서 빌드\n`);
process.stdout.write(`플러그인 빌드: ${OUT} · 판 ${manifest.version} (CLI ${cliVersion})\n`);
