// 가상 터미널에서 axnavi 대화형 모드를 실제로 돌리며 출력을 asciicast v2 로 기록한다.
import { spawn } from "@lydell/node-pty";
import { readFileSync, writeFileSync } from "node:fs";

const COLS = Number(process.env.COLS || 120);
const ROWS = Number(process.env.ROWS || 32);
const OUT = process.argv[2] || "raw.cast";
/* 질문은 파일로 받는다 — Git Bash 가 환경 변수의 "/modify" 를 "C:/Program Files/Git/modify" 로 바꿔 넘겼다(실측). */
const QUESTION = process.env.QFILE ? readFileSync(process.env.QFILE, "utf8").trim() : "/flow 샘플 등록 화면에서 등록 버튼 누르면 뭐가 실행돼?";

const env = { ...process.env, PATH: `C:\\demo\\tools;${process.env.PATH}`, TERM: "xterm-256color" };
const term = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "function prompt { 'PS C:\\demo\\egov-sample> ' }; Clear-Host"], {
  name: "xterm-256color", cols: COLS, rows: ROWS, cwd: "C:\\demo\\egov-sample", env,
});

const start = Date.now();
const events = [];
let screen = "";
let total = 0; // 지금까지 받은 글자 수(절대 위치) — screen 은 잘리므로 위치는 이것으로 센다
let lastOut = Date.now();
term.onData((data) => {
  events.push([(Date.now() - start) / 1000, "o", data]);
  screen += data;
  total += data.length;
  lastOut = Date.now();
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
setTimeout(() => finish("전체 시간 초과"), (Number(process.env.MAX_MIN || 12) + 2) * 60 * 1000);

await waitFor(/egov-sample> $/m, 20000, "셸 프롬프트");
await sleep(1200);
events.push([(Date.now() - start) / 1000, "m", "START"]);
await type("axnavi");
await sleep(300);
term.write("\r");
await waitFor(/❯|AX-NAVI\s*>/, 60000, "axnavi 프롬프트");
await sleep(2500);
/* 질문 파일의 앞줄들은 질문 전에 치는 명령이다(예: `/mode 매번 묻기`). 마지막 줄이 질문이다. */
const lines = QUESTION.split(/\r?\n/).filter(Boolean);
for (const pre of lines.slice(0, -1)) {
  await type(pre, 70);
  await sleep(500);
  term.write("\r");
  await sleep(2500);
}
await type(lines.at(-1), 70);
await sleep(700);
term.write("\r");
events.push([(Date.now() - start) / 1000, "m", "ASKED"]);
/*
 * 승인 창·선택지 창은 바닥에 "번호 입력" 안내가 뜰 때 입력을 기다린다. 사람이 읽을 틈(2.5초)을 두고
 * 첫 번째(승인은 "예", 질문은 권장안)를 누른다. 누른 때와 무엇을 눌렀는지는 기록에 표시해 둔다.
 */
const askedAt = total;
let handled = askedAt;
const DONE = /\d+m \d+s · \$\d|\d+s · \$\d/;
const until = Date.now() + Number(process.env.MAX_MIN || 12) * 60 * 1000;
let answered = false;
while (Date.now() < until) {
  const at = screen.lastIndexOf("번호 입력");
  const abs = at < 0 ? -1 : total - (screen.length - at);
  if (abs > handled) {
    handled = abs;
    const approval = /실행할까요\?/.test(strip(screen.slice(-4000)));
    await sleep(2500);
    events.push([(Date.now() - start) / 1000, "m", approval ? "APPROVE" : "CHOOSE"]);
    term.write("1");
    await sleep(1500);
    continue;
  }
  const since = screen.slice(Math.max(0, screen.length - (total - askedAt)));
  /*
   * 끝은 "비용 줄 + 6초 무출력 + 프롬프트"다. 비용 줄만 보면, 대화가 스킬을 넘겨받기 직전에 찍는
   * 비용 줄에서 끝난 것으로 오인해 스킬이 시작하자마자 /exit 를 쳤다(실측). 도는 동안은 진행 표시가 계속 그린다.
   */
  const tailText = strip(since.slice(-3000));
  if (DONE.test(tailText) && /AX-NAVI\s*>/.test(tailText.slice(-400)) && Date.now() - lastOut > 6000) { answered = true; break; }
  await sleep(400);
}
if (!answered) finish("답 대기 초과");
events.push([(Date.now() - start) / 1000, "m", "ANSWERED"]);
await sleep(6000);
await type("/exit", 90);
await sleep(400);
term.write("\r");
await sleep(3000);
finish("완료");
