/*
 * 키 진단.
 *
 * Shift+Tab 이 안 먹는다는 보고가 있었는데, REPL 쪽은 정상이었다(가짜 TTY 로 흘려보내
 * 확인함 — 프롬프트가 바뀌고 안내가 찍힌다). 그러면 남은 가능성은 하나다:
 * **터미널이 그 키를 Node 까지 보내지 않는다.**
 *
 * 터미널마다 보내는 바이트가 다르고, 창 관리자가 먼저 먹기도 한다. 추측으로 고치면
 * 엉뚱한 데를 만지게 되므로, 실제로 무엇이 오는지 눈으로 볼 수 있게 한다.
 */

import { emitKeypressEvents } from "node:readline";
import { ui } from "./runtime.mjs";

const ESC = String.fromCharCode(27);

/**
 * 누른 키가 어떤 바이트로 오고 Node 가 어떻게 읽는지 보여 준다.
 * @returns {Promise<number>}
 */
export function cmdKeys() {
  if (!process.stdin.isTTY) {
    process.stderr.write("터미널에서 직접 실행해야 합니다(파이프로는 키를 받을 수 없습니다).\n");
    return Promise.resolve(2);
  }

  process.stdout.write(
    `\n${ui.bold("키 진단")}\n` +
      `${ui.dim("  아무 키나 눌러 보세요. 무엇이 오는지 그대로 보여 줍니다.")}\n` +
      `${ui.dim("  확인할 것: Shift+Tab · Ctrl+O · Esc")}\n` +
      `${ui.dim("  끝내려면 Ctrl+C.")}\n\n`,
  );

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve) => {
    process.stdin.on("keypress", (/** @type {string} */ ch, /** @type {any} */ key) => {
      if (key?.ctrl && key.name === "c") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        resolve(0);
        return;
      }
      // 눈에 안 보이는 바이트를 읽을 수 있게 적는다. 이게 진단의 전부다.
      const raw = [...(key?.sequence ?? ch ?? "")]
        .map((c) => {
          const code = c.codePointAt(0) ?? 0;
          if (c === ESC) return "ESC";
          if (code < 0x20) return `^${String.fromCharCode(code + 64)}`;
          return c;
        })
        .join(" ");
      const named = [key?.ctrl && "Ctrl", key?.meta && "Alt", key?.shift && "Shift", key?.name]
        .filter(Boolean).join("+");
      process.stdout.write(`  ${ui.cyan(named || "(이름 없음)")}   ${ui.dim(`바이트: ${raw}`)}\n`);
    });
  });
}
