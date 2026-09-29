// 녹화 원본(asciicast)의 시간 축만 편집한다 — 출력 글자는 한 바이트도 바꾸지 않는다.
// 구간: 준비(잘라냄) → 타이핑(1.5배속) → 대기(빨리감기, 화면의 경과 시간 표시는 실제 값) → 답(그대로) → 정지 화면.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, waitSeconds = "10", holdSeconds = "7"] = process.argv.slice(2);
const lines = readFileSync(input, "utf8").trim().split("\n");
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map((line) => JSON.parse(line));
const mark = (name) => events.find((e) => e[1] === "m" && e[2] === name)[0];
const START = mark("START"), ASKED = mark("ASKED"), ANSWERED = mark("ANSWERED");

/* 답이 화면에 찍히기 시작한 때 — 대기 구간은 ASKED 부터 여기까지다. 첫 "찾은 것"류 본문이 아니라, 마지막 도구 뒤 결론이 나오는 시점을 쓴다. */
const outputs = events.filter((e) => e[1] === "o");
const answerStart = (() => {
  const idx = outputs.findIndex((e) => e[0] > ASKED && /찾은 것|결론|흐름 요약|요약/.test(e[2]));
  return idx >= 0 ? outputs[idx][0] : ANSWERED - 3;
})();
const typingScale = 1 / 1.5;
const waitScale = Number(waitSeconds) / Math.max(1, answerStart - ASKED);

const retime = (t) => {
  if (t <= START) return 0;
  if (t <= ASKED) return (t - START) * typingScale;
  const typed = (ASKED - START) * typingScale;
  if (t <= answerStart) return typed + (t - ASKED) * waitScale;
  return typed + (answerStart - ASKED) * waitScale + (t - answerStart);
};

const kept = [];
for (const e of events) {
  if (e[1] !== "o") continue;
  if (e[0] > ANSWERED + 0.5) break; // 뒤이은 /exit 입력은 잘라낸다
  kept.push([Math.round(retime(e[0]) * 1000) / 1000, "o", e[2]]);
}
const end = kept.at(-1)[0];
kept.push([Math.round((end + Number(holdSeconds)) * 1000) / 1000, "o", ""]); // 마지막 화면을 멈춰 보여 준다
writeFileSync(output, [JSON.stringify(header), ...kept.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(JSON.stringify({ real: { typing: ASKED - START, wait: answerStart - ASKED, answer: ANSWERED - answerStart }, waitScale: Math.round(waitScale * 1000) / 1000, total: Math.round((end + Number(holdSeconds)) * 10) / 10 }));
