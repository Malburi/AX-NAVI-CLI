/*
 * 인코딩 보존 훅의 명령형 입구 — `node legacy-encoding-hook.mjs pre|post|cleanup [plugin]`.
 *
 * claude -p 연결은 설정 파일의 훅으로, Claude Code 플러그인 사용자는 hooks/hooks.json 으로 부른다.
 * 무엇을 왜 하는지는 legacy-encoding.mjs 에 있다. 입력은 stdin 의 훅 JSON 이고, 바꿀 것이 없으면
 * 아무것도 쓰지 않는다(그대로 진행).
 *   pre      PreToolUse — 도구가 도는 동안 UTF-8 로 바꿔 둔다
 *   post     PostToolUse — 원래 인코딩으로 되돌린다
 *   cleanup  PostToolUseFailure·PermissionDenied·Stop·SessionEnd — 남은 것을 되돌린다
 *
 * `plugin` 으로 불렸는데 axnavi 가 띄운 실행이면 비킨다. axnavi 는 같은 일을 자기 훅으로 이미 하고,
 * 둘이 함께 돌면 같은 원본을 두 번 바꾼다.
 */
import { encodingCleanup, encodingPostToolUse, encodingPreToolUse } from "./legacy-encoding.mjs";

const [phase, from] = process.argv.slice(2);
if (from === "plugin" && process.env.AXNAVI_ENCODING_HOOK === "1") process.exit(0);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(raw || "{}");
  } catch {
    return;
  }
  let out = {};
  try {
    out = phase === "post" ? encodingPostToolUse(event) : phase === "cleanup" ? encodingCleanup(event) : encodingPreToolUse(event);
  } catch {
    return; // 훅이 죽어 도구가 막히는 것보다 예전처럼 진행하는 편이 낫다
  }
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
});
