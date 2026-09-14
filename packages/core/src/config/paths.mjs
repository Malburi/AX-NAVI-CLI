/*
 * 경로 해석.
 *
 * 핵심 규칙은 "런타임 상태는 `_workspace/`에 그대로 둔다"이다(결정 D-B).
 * 브리프 §8은 `.axnavi/index/`로 옮기라고 했지만, 이 저장소의 agents/*.md 164곳과
 * skills/*\/SKILL.md 252곳 — 합계 416곳 — 이 `_workspace/...`를 문자 그대로 적고 있다.
 * 인덱스를 옮기면 그 본문들이 전부 조용히 틀린 경로를 가리킨다. 그래서:
 *
 *   _workspace/  = 런타임 상태 (index, reports, pair_config)   ← 플러그인과 공유
 *   .axnavi/     = CLI 설정·세션·로그                          ← CLI 전용
 *
 * 덕분에 플러그인과 CLI가 같은 저장소에서 서로를 깨뜨리지 않고 공존한다.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** @typedef {import("../../types/paths.js").ProjectPaths} ProjectPaths */
/** @typedef {import("../../types/paths.js").ProjectState} ProjectState */

/**
 * @param {string} rootArg
 * @param {string} [indexDirOverride]
 * @returns {ProjectPaths}
 */
export function resolveProjectPaths(rootArg, indexDirOverride) {
  const root = resolve(rootArg);
  const workspaceDir = join(root, "_workspace");
  const indexDir = indexDirOverride
    ? (isAbsolute(indexDirOverride) ? indexDirOverride : join(root, indexDirOverride))
    : join(workspaceDir, "index");
  const axnaviDir = join(root, ".axnavi");
  return {
    root,
    workspaceDir,
    indexDir,
    reportsDir: join(workspaceDir, "reports"),
    pairConfigPath: join(workspaceDir, "pair_config.md"),
    axnaviDir,
    configPath: join(axnaviDir, "axnavi.yaml"),
    sessionsDir: join(axnaviDir, "sessions"),
    logsDir: join(axnaviDir, "logs"),
  };
}

/**
 * @param {ProjectPaths} paths
 * @returns {ProjectState}
 */
export function inspectProject(paths) {
  return {
    initialized: existsSync(paths.configPath),
    hasIndex: existsSync(join(paths.indexDir, "_meta.json")),
    hasPluginHarness: existsSync(join(paths.root, "CLAUDE.md")) && existsSync(join(paths.root, ".claude")),
  };
}

/**
 * 경로가 허용된 루트 안에 있는지 검사한다. Tool Gateway의 경로 탈출 방어.
 * 심볼릭 링크까지는 보지 않는다 — 호출부가 realpath를 먼저 풀어 넘기는 것을 전제한다.
 * @param {readonly string[]} allowedRoots
 * @param {string} candidate
 * @returns {boolean}
 */
export function isWithin(allowedRoots, candidate) {
  const target = resolve(candidate);
  return allowedRoots.some((rootDir) => {
    const base = resolve(rootDir);
    return target === base || target.startsWith(base + "\\") || target.startsWith(base + "/");
  });
}
