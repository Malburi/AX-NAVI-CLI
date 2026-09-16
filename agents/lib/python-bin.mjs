/*
 * 파이썬 인터프리터 이름을 환경에서 찾는다.
 *
 * 이 저장소는 두 이름을 서로 다른 자리에 하드코딩하고 있었다 — 테스트는 `python3`,
 * 런타임 스크립트 21곳은 `python`. 둘 다 한쪽 OS에서만 맞는다:
 *   Windows(파이썬 공식 설치판·Store판): `python`은 있고 `python3`는 없다 → 테스트 5건 실패
 *   다수 Linux 배포판·Homebrew: `python3`만 있고 `python`은 없다 → 런타임 스크립트가 전부 실패
 * ITO 현장은 윈도우가 기본이고 CI는 리눅스라 양쪽 다 실제로 밟는 조합이다.
 *
 * 그래서 이름을 고정하지 않고 실제로 실행되는 것을 찾아 쓴다. 없으면 `null`을 돌려주고,
 * 부르는 쪽이 "파이썬 없음"을 조용한 실패가 아니라 명시적인 사유로 다루게 한다.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const CANDIDATES = ["python3", "python", "py"];

/**
 * Windows Store 앱 실행 별칭인가.
 *
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe`는 **0바이트 리파스 포인트**다.
 * 실행하면 스토어 앱을 띄우려다 즉시 죽는다. 그것만이면 exit code로 걸러도 됐는데,
 * 실측으로 더 나쁜 일이 있었다 — **job object 안에서 이걸 spawn하면 그 다음 spawn이
 * libuv 수준에서 프로세스를 죽인다.**
 *
 *   node -e "spawnSync('python3',…); spawnSync('python',…)"
 *   → AssignProcessToJobObject: (87) 매개 변수가 틀립니다.   (출력 한 줄 없이 종료)
 *
 * 네이티브 abort라 try/catch로 못 잡는다. 회사 PC처럼 EDR이 job object를 쓰는 환경에서
 * `axnavi doctor`가 통째로 죽었다. 그래서 **실행해 보기 전에** 걸러낸다.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isStoreAlias(name) {
  if (process.platform !== "win32") return false;
  // where.exe는 실제 실행 파일이라 이 경로 자체는 안전하다.
  const lookup = spawnSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const first = (lookup.stdout || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first) return false;
  try {
    // spawn이 집어들 첫 번째 후보만 본다 — 그게 실제로 실행될 파일이다.
    return statSync(first).size === 0;
  } catch {
    return false;
  }
}

/**
 * 쓸 수 있는 파이썬을 찾는다. 이름과 버전을 함께 돌려준다.
 * @returns {{ bin: string, version: string } | null}
 */
export function pythonInfo() {
  for (const name of CANDIDATES) {
    if (isStoreAlias(name)) continue;
    /* `--version`이 실제로 성공해야 인정한다. Windows Store의 `python` stub은 존재하지만
     * 실행하면 스토어 앱을 띄우고 실패하므로 이름 존재 여부만으로는 판정할 수 없다. */
    const probe = spawnSync(name, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const text = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
    if (probe.status === 0 && /Python\s+3/.test(text)) {
      return { bin: name, version: text.replace(/^Python\s+/, "") };
    }
  }
  return null;
}

/** @type {string | null | undefined} */
let resolved;
export function pythonBin() {
  if (resolved !== undefined) return resolved;
  resolved = pythonInfo()?.bin ?? null;
  return resolved;
}
