/*
 * git diff 수집·파싱.
 *
 * 리뷰는 "무엇이 바뀌었나"만 본다. 파일 전체를 다시 읽지 않고 `--unified=0` 으로
 * 바뀐 줄과 그 줄 번호만 받는다 — 규칙 판정과 인덱스 대조(어느 메서드 안인가)에 필요한 것은
 * 그것뿐이다. 레거시 저장소는 파일 하나가 수천 줄인 일이 흔해 전체를 읽으면 CI가 느려진다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{ line: number, text: string }} DiffLine
 * @typedef {{ path: string, oldPath: string | null, status: "added" | "modified" | "deleted" | "renamed", binary: boolean, added: DiffLine[], removed: DiffLine[] }} DiffFile
 */

/**
 * diff 대상을 git 인자로 바꾼다.
 * - `base..head` / `base...head` → 그대로(두 커밋 비교, CI 머지 요청)
 * - staged → 스테이징된 변경
 * - 없으면 HEAD 대비 작업 트리 전체(스테이징 포함) — 커밋 전에 돌려 보는 경우
 * @param {{ range?: string, staged?: boolean }} target
 */
export function diffArgs(target) {
  if (target.range) return [target.range];
  if (target.staged) return ["--cached"];
  return ["HEAD"];
}

/**
 * @param {string} root
 * @param {{ range?: string, staged?: boolean }} target
 * @returns {DiffFile[]}
 */
export function collectDiff(root, target) {
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--unified=0", "--find-renames", ...diffArgs(target)],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = String(/** @type {any} */ (error).stderr ?? "").trim();
    throw new Error(`git diff 실패: ${stderr || /** @type {Error} */ (error).message}`);
  }
  return parseUnifiedDiff(raw);
}

/**
 * `git diff --unified=0` 출력 파싱.
 * @param {string} raw
 * @returns {DiffFile[]}
 */
export function parseUnifiedDiff(raw) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let cur = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? "", oldPath: null, status: "modified", binary: false, added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) cur.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ")) cur.binary = true;
    else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") cur.path = p.replace(/^b\//, "");
    } else if (line.startsWith("--- ")) {
      continue;
    } else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
    } else if (line.startsWith("+")) {
      cur.added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      cur.removed.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
    }
  }
  return files.filter((f) => f.path);
}

/** 테스트 코드 경로인가 — 회귀 위험·테스트 적정성 판정에 쓴다. */
export function isTestPath(/** @type {string} */ path) {
  const p = path.replace(/\\/g, "/");
  return /(^|\/)(test|tests|__tests__|spec)\//i.test(p)
    || /(Test|Tests|IT|Spec)\.(java|kt|cs|scala|groovy)$/.test(p)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
    || /(^|\/)test_[^/]+\.py$|_test\.(py|go)$/.test(p);
}

const CODE_EXT = /\.(java|kt|kts|scala|groovy|cs|vb|py|go|rb|php|[cm]?[jt]sx?|vue|jsp|jspf|xml|sql|xfdl|xjs|pc|pck|pkb|pks|prc|fnc|trg)$/i;

/** 동작에 영향을 주는 파일인가(문서·이미지 제외) */
export function isCodePath(/** @type {string} */ path) {
  return CODE_EXT.test(path);
}

/** DB 스키마·마이그레이션 파일인가 */
export function isSchemaPath(/** @type {string} */ path) {
  const p = path.replace(/\\/g, "/");
  return /\.(sql|ddl)$/i.test(p) || /(^|\/)(db\/migration|migrations?|flyway|liquibase|ddl)\//i.test(p) || /(^|\/)V\d+(_\d+)*__.+\.sql$/i.test(p);
}

/**
 * diff 의 "새 쪽" 파일 내용 — 바뀐 줄 뒤를 봐야 하는 규칙에 쓴다.
 * 작업 트리 비교면 디스크에서, staged 면 인덱스(`:path`)에서, 범위면 head 커밋에서 읽는다.
 * @param {string} root
 * @param {{ range?: string, staged?: boolean }} target
 * @param {string} path
 * @returns {string[] | null}
 */
export function readNewContent(root, target, path) {
  try {
    let text;
    if (target.range) {
      const head = target.range.split(/\.\.\.?/)[1] || "HEAD";
      text = execFileSync("git", ["show", `${head}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } else if (target.staged) {
      text = execFileSync("git", ["show", `:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } else {
      text = readFileSync(join(root, path), "utf8");
    }
    return text.split(/\r?\n/);
  } catch {
    return null;
  }
}
