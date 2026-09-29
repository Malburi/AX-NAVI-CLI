// 가상 터미널에서 axnavi 대화형 모드를 실제로 돌리며 출력을 asciicast v2 로 기록한다.
import { spawn } from "@lydell/node-pty";
import { writeFileSync } from "node:fs";

const COLS = Number(process.env.COLS || 120);
const ROWS = Number(process.env.ROWS || 32);
const OUT = process.argv[2] || "raw.cast";
const QUESTION = "/flow 샘플 등록 화면에서 등록 버튼 누르면 뭐가 실행돼?";

const env = { ...process.env, PATH: `C:\\demo\\tools;${process.env.PATH}`, TERM: "xterm-256color" };
const term = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "function prompt { 'PS C:\\demo\\egov-sample> ' }; Clear-Host"], {
  name: "xterm-256color", cols: COLS, rows: ROWS, cwd: "C:\\demo\\egov-sample", env,
});

const start = Date.now();
const events = [];
let screen = "";
term.onData((data) => {
  events.push([(Date.now() - start) / 1000, "o", data]);
  screen += data;
  if (screen.length > 200000) screen = screen.slice(-100000);
  process.stderr.write(data.length > 0 ? "" : "");
});
term.onExit(() => finish("exit"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, "");
async function waitFor(regex, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  const from = screen.length;
  while (Date.now() < until) {
    if (regex.test(strip(screen.slice(Math.max(0, from - 2000))))) return true;
    await sleep(200);
  }
  console.error(`시간 초과: ${label}`);
  return false;
}
async function type(text, perChar = 90) {
  for (const ch of text) { term.write(ch); await sleep(perChar + Math.random() * 60); }
}

let done = false;
function finish(reason) {
  if (done) return;
  done = true;
  const header = { version: 2, width: COLS, height: ROWS, timestamp: Math.floor(start / 1000), env: { TERM: "xterm-256color", SHELL: "powershell" } };
  writeFileSync(OUT, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
  console.error(`끝 (${reason}) · 이벤트 ${events.length} · ${((Date.now() - start) / 1000).toFixed(1)}s → ${OUT}`);
  try { term.kill(); } catch {}
  process.exit(0);
}
setTimeout(() => finish("전체 시간 초과"), 9 * 60 * 1000);

await waitFor(/egov-sample> $/m, 20000, "셸 프롬프트");
await sleep(1200);
events.push([(Date.now() - start) / 1000, "m", "START"]);
await type("axnavi");
await sleep(300);
term.write("\r");
await waitFor(/❯|AX-NAVI\s*>/, 60000, "axnavi 프롬프트");
await sleep(2500);
await type(QUESTION, 70);
await sleep(700);
term.write("\r");
events.push([(Date.now() - start) / 1000, "m", "ASKED"]);
if (!(await waitFor(/\d+m \d+s · \$\d|\d+s · \$\d/, 7 * 60 * 1000, "답 완료"))) finish("답 대기 초과");
events.push([(Date.now() - start) / 1000, "m", "ANSWERED"]);
await sleep(6000);
await type("/exit", 90);
await sleep(400);
term.write("\r");
await sleep(3000);
finish("완료");
