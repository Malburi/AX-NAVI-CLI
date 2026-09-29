// 녹화 원본(asciicast)의 시간 축만 편집한다 — 출력 글자는 한 바이트도 바꾸지 않는다.
// 승인 창이 여러 번 끼는 녹화용: 고른 승인(APPROVE 표시 순번) 앞뒤만 실제 속도로 두고, 나머지 대기는 한 배율로 빨리감는다.
// 사용: node retime2.mjs <원본> <출력> <빨리감기 목표 초> <실제 속도로 둘 승인 순번(1부터, 쉼표)> <답 시작 정규식>
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, fastTarget = "14", keep = "", answerPattern = "변경 안전성 확인 완료"] = process.argv.slice(2);
const lines = readFileSync(input, "utf8").trim().split("\n");
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map((line) => JSON.parse(line));
const marks = (name) => events.filter((e) => e[1] === "m" && e[2] === name).map((e) => e[0]);
const [START] = marks("START"), [ASKED] = marks("ASKED");
/* 답 완료 표시가 없으면(녹화가 표시 전에 끝남) 비용 줄(`6m 47s · $0.77`)이 찍힌 때를 쓴다. */
const ANSWERED = marks("ANSWERED")[0] ?? events.filter((e) => e[1] === "o" && /\d+m \d+s · \$\d/.test(e[2].replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ""))).at(-1)[0] + 1;
const approvals = marks("APPROVE");
const keepSet = new Set(keep.split(",").filter(Boolean).map(Number));

/* 최종 보고가 찍히기 시작한 때 — 그 뒤는 실제 속도다. */
const outputs = events.filter((e) => e[1] === "o");
const pattern = new RegExp(answerPattern);
const hits = outputs.filter((e) => e[0] > ASKED && e[0] < ANSWERED && pattern.test(e[2]));
const answerStart = hits.length ? hits.at(-1)[0] - 0.3 : ANSWERED - 3;

/* 실제 속도 구간: 승인 창이 그려지기 조금 전(누르기 2.5초 전 + 여유) ~ 누른 뒤 적용 결과가 보일 때까지 */
const slow = approvals.map((t, i) => [i + 1, t]).filter(([n]) => keepSet.has(n)).map(([, t]) => [t - 3.4, t + 2.2]);
const segments = [];
let cursor = ASKED;
for (const [a, b] of slow) { if (a > cursor) segments.push([cursor, a, "fast"]); segments.push([Math.max(a, cursor), b, "slow"]); cursor = b; }
if (answerStart > cursor) segments.push([cursor, answerStart, "fast"]);
const fastTotal = segments.filter((s) => s[2] === "fast").reduce((sum, [a, b]) => sum + (b - a), 0);
const scale = Number(fastTarget) / Math.max(1, fastTotal);
const typingScale = 1 / 1.5;

const retime = (t) => {
  if (t <= START) return 0;
  if (t <= ASKED) return (t - START) * typingScale;
  let out = (ASKED - START) * typingScale;
  for (const [a, b, kind] of segments) {
    const k = kind === "fast" ? scale : 1;
    if (t <= b) return out + (t - a) * k;
    out += (b - a) * k;
  }
  return out + (t - answerStart);
};

const kept = [];
for (const e of events) {
  if (e[1] !== "o") continue;
  if (e[0] > ANSWERED + 0.5) break; // 뒤이은 /exit 입력은 잘라낸다
  kept.push([Math.round(retime(e[0]) * 1000) / 1000, "o", e[2]]);
}
writeFileSync(output, [JSON.stringify(header), ...kept.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(JSON.stringify({ real: { total: ANSWERED - START, fast: Math.round(fastTotal) }, scale: Math.round(scale * 1000) / 1000, approvals: approvals.map((t) => Math.round(t)), kept: [...keepSet], total: Math.round(kept.at(-1)[0] * 10) / 10 }));
