/*
 * 답이 약속한 산출물이 실제로 쓰였는가.
 *
 * 실측 사고 — 저장소 둘을 병렬로 훑은 실행에서 server 쪽 서브에이전트가 이렇게 끝냈다.
 *
 *   전체 상세: …\xu43-server\_workspace\reports\found_video-subtitle.md
 *
 * 그런데 그 파일을 쓰지 않았다. `Write` 호출 자체가 없었다. 앞선 실행이 남긴 같은
 * 이름의 파일이 이미 있었고, 에이전트가 그것을 **읽고 "확인했다"로 갈음**한 것이다.
 * 사용자는 새 리포트가 생긴 줄 알고 열었다가 옛 내용을 본다.
 *
 * 지침으로도 막지만(commands.mjs), 지침은 지켜지지 않을 수 있다. 그래서 여기서
 * 사실로 확인한다 — 답이 이름을 댄 파일이 **이번 턴에** 바뀌었는지 stat 으로 본다.
 * 못 지킨 약속을 조용히 넘기지 않는 것이 요점이지, 막는 것이 아니다.
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/*
 * 답 본문에서 산출물 경로를 뽑는다.
 *
 * 절대경로와 저장소 상대경로 둘 다 나온다. 백틱·따옴표·괄호로 감싼 경우가 흔해서
 * 그 앞뒤를 경계로 쓴다. 확장자는 우리가 쓰는 산출물 형식만 본다 — 소스 파일 경로를
 * 잡으면 경고가 늘 뜨고, 늘 뜨는 경고는 경고가 아니다.
 */
const PATH =
  /(?:[A-Za-z]:)?[\\/]?(?:[\w.\- ]+[\\/])*_workspace[\\/]reports[\\/][^\s\\/:*?"'<>|`]+\.(?:md|json)/g;

/**
 * 답이 이름을 댄 산출물 중 이번 턴에 안 쓰인 것.
 *
 * @param {string} answer          최종 답변 본문
 * @param {readonly string[]} roots  경로를 붙여 볼 저장소 루트들
 * @param {number} since           턴 시작 시각 (ms)
 * @returns {string[]}             쓰이지 않은 경로. 중복은 없다
 */
export function unwrittenClaims(answer, roots, since) {
  /** @type {Set<string>} */
  const claimed = new Set();
  for (const hit of answer.match(PATH) ?? []) claimed.add(hit.trim());
  if (!claimed.size) return [];

  /** @type {string[]} */
  const missing = [];
  for (const raw of claimed) {
    /*
     * 상대경로는 어느 저장소 것인지 모른다. 루트마다 붙여 보고 **하나라도** 이번 턴에
     * 쓰였으면 지킨 것으로 본다. 애매할 때 경고하지 않는 쪽을 고른다.
     */
    const candidates = isAbsolute(raw) ? [raw] : roots.map((r) => resolve(r, raw.replace(/^[\\/]+/, "")));
    const kept = candidates.some((path) => {
      try {
        return statSync(path).mtimeMs >= since;
      } catch {
        return false;
      }
    });
    if (!kept) missing.push(raw);
  }
  return missing;
}
