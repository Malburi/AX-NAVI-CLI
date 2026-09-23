/*
 * 인덱스를 가진 저장소 찾기.
 *
 * 왜 필요한가 — `resolveProjectPaths` 는 받은 경로를 그대로 쓴다. 위로도 아래로도
 * 찾지 않는다. 그건 그 함수의 미덕이다(416곳이 `_workspace/...` 를 문자 그대로 적고
 * 있어서 경로를 영리하게 바꾸면 그 본문들이 조용히 틀린 곳을 가리킨다).
 *
 * 문제는 **부모 폴더에서 띄웠을 때**다. 실측:
 *
 *   C:\Users\HHI\xu43-wikwik\        ← 여기서 axnavi 실행. _workspace 없음
 *     xu43-server\_workspace\index\   2,575 파일 Full
 *     xu43-client\_workspace\index\   1,428 파일 Full
 *
 * 우리는 `xu43-wikwik\_workspace\index\_meta.json` 만 보고 "인덱스가 없습니다"로
 * 끝냈고, 에이전트는 grep 으로 내려앉았다. 같은 질문을 플러그인에 던지면 호스트가
 * 스스로 둘러보다 양쪽 인덱스를 찾아내 저장소별로 나눠 탐색했다. 답의 깊이가 갈린
 * 지점이 바로 여기다 — 인덱스를 잃으면 sql_usage·schema 대조를 못 하고, 그러면
 * "확인했는데 없다"를 말할 수 없다.
 *
 * 그래서 경로 해석은 그대로 두고 **탐색만 따로** 얹는다. 단일 루트면 아무것도 하지
 * 않으므로 기존 동작이 한 글자도 바뀌지 않는다.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveProjectPaths } from "./paths.mjs";

/** @typedef {import("../../types/paths.js").ProjectPaths} ProjectPaths */

/**
 * @typedef {object} RootInfo
 * @property {ProjectPaths} paths
 * @property {string} name        폴더 이름. 화면에 쓴다
 * @property {number} files       인덱싱된 소스 파일 수
 * @property {string} tier
 * @property {boolean} hasPair    _workspace/pair_config.md 가 있는가
 * @property {string} role       pair_config 의 project_type (backend/frontend 등). 없으면 빈 문자열
 */

/**
 * @typedef {object} Discovery
 * @property {ProjectPaths} primary  질의의 기본 대상
 * @property {RootInfo[]} roots      인덱스를 가진 저장소들. 없으면 빈 배열
 * @property {boolean} scanned       하위를 훑었는가 (단일 루트면 false)
 */

/*
 * 한 단계만 훑는다.
 *
 * 재귀하면 대형 레거시에서 시작이 눈에 띄게 느려진다. 그리고 실제로 쓰이는 구조 —
 * 페어(backend/frontend)와 모노레포 — 는 전부 한 단계 아래에 있다. 더 깊은 곳을
 * 쓰려면 --root 로 짚어 주는 편이 빠르고 예측 가능하다.
 */
const MAX_DEPTH = 1;

/** 훑지 않을 폴더. 점으로 시작하는 것은 따로 거른다. */
const SKIP = new Set(["node_modules", "_workspace", "_workspace_prev", "dist", "build", "target", "out"]);

/**
 * @param {string} dir
 * @returns {{ files: number, tier: string } | null}
 */
function indexFacts(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "_workspace", "index", "_meta.json"), "utf8"));
    return {
      files: Number(meta.source_file_count ?? meta.files_scanned ?? 0),
      tier: String(meta.tier ?? "?"),
    };
  } catch {
    // 없거나 깨졌으면 없는 것으로 본다. 여기서 던지면 시작 자체가 막힌다.
    return null;
  }
}

/**
 * @param {string} dir
 * @returns {RootInfo | null}
 */
function rootAt(dir) {
  const facts = indexFacts(dir);
  if (!facts) return null;
  const hasPair = existsSync(join(dir, "_workspace", "pair_config.md"));
  return {
    paths: resolveProjectPaths(dir),
    name: basename(dir),
    files: facts.files,
    tier: facts.tier,
    hasPair,
    role: hasPair ? pairInfo(dir).role : "",
  };
}

/**
 * pair_config.md 에서 필요한 두 줄만 꺼낸다.
 *
 * 인덱서에도 같은 일을 하는 코드가 있지만(build-index.mjs 의 pairConfig) 그쪽은
 * api_contract 병합 전용이라 가져다 쓸 수 없다. 여기서 보는 것은 두 줄뿐이다.
 *
 * @param {string} dir
 * @returns {{ partner: string | null, role: string }}
 */
function pairInfo(dir) {
  try {
    const text = readFileSync(join(dir, "_workspace", "pair_config.md"), "utf8");
    const partner = /^partner_root:s*(.+)$/m.exec(text)?.[1]?.trim();
    const role = /^project_type:s*(.+)$/m.exec(text)?.[1]?.trim();
    return {
      partner: partner && partner !== "unknown" ? resolve(partner) : null,
      role: role && role !== "unknown" ? role : "",
    };
  } catch {
    return { partner: null, role: "" };
  }
}

/**
 * 인덱스를 가진 저장소를 찾는다.
 *
 * @param {string} rootArg  사용자가 선 자리 (cwd 또는 --root)
 * @returns {Discovery}
 */
export function discoverRoots(rootArg) {
  const primary = resolveProjectPaths(rootArg);

  // 1) 선 자리에 인덱스가 있으면 그것으로 끝. 기존 동작과 완전히 같다.
  const here = rootAt(primary.root);
  if (here) return { primary, roots: [here], scanned: false };

  // 2) 한 단계 아래를 훑는다.
  /** @type {RootInfo[]} */
  const found = [];
  try {
    for (const entry of readdirSync(primary.root)) {
      if (entry.startsWith(".") || SKIP.has(entry)) continue;
      const child = join(primary.root, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      const info = rootAt(child);
      if (info) found.push(info);
      if (found.length >= 8) break; // 병적인 구조에서 시작이 늘어지지 않게
    }
  } catch {
    // 읽을 수 없는 폴더에서 띄웠을 수 있다. 빈 결과로 둔다.
  }

  // 3) pair_config 가 가리키는 파트너가 목록 밖이면 더한다 (형제가 아닌 경우).
  for (const info of [...found]) {
    if (!info.hasPair) continue;
    const { partner } = pairInfo(info.paths.root);
    if (!partner || found.some((r) => r.paths.root === partner)) continue;
    const extra = rootAt(partner);
    if (extra) found.push(extra);
  }

  if (!found.length) return { primary, roots: [], scanned: MAX_DEPTH > 0 };

  /*
   * 기본 대상.
   *
   * 페어는 **양쪽 다** pair_config 를 갖는다(서로를 가리킨다). 그래서 "pair 가 있는 쪽"
   * 으로는 못 고른다 — 실측으로 알파벳 순으로 앞선 client 가 뽑혔다. project_type 을
   * 읽어 backend 를 먼저 본다. 업무 로직·SQL 질문이 대부분 그쪽이라서다.
   * 그것도 못 가리면 파일이 가장 많은 쪽 — 작은 쪽을 기본으로 잡으면 대부분 빗나간다.
   */
  const lead = found.find((r) => r.role === "backend")
    ?? [...found].sort((a, b) => b.files - a.files)[0];

  return { primary: /** @type {RootInfo} */ (lead).paths, roots: found, scanned: true };
}
