/*
 * 백그라운드로 돌리는 작업.
 *
 * 무엇을 해결하는가 — 지금까지 REPL 은 턴 하나를 await 하고, 그 동안 친 글은 큐에
 * 쌓였다가 끝난 뒤에 돌았다. 하네스 초기화처럼 10분 넘게 도는 작업이 있으면 그 10분은
 * 아무것도 못 한다.
 *
 * 왜 대화를 나누지 않고 **따로 돌리는가** — 우리는 claude 세션을 `--resume <id>` 로
 * 이어 붙인다. 같은 세션에 두 턴을 동시에 태우면 둘째가 이어 붙일 바탕이 낡은 채로
 * 출발하고, 끝난 뒤 세션 id 를 서로 덮어써 대화가 갈라진다. 그래서 백그라운드 작업은
 * **자기 대화**를 갖는다. 대신 진행 중 화면을 어지럽히지 않고, 결과는 기록에 담겨
 * 나중에 통째로 되짚을 수 있다.
 *
 * 화면에 안 찍는 것은 선택이 아니라 필수다. 두 실행이 같은 터미널 바닥을 두고
 * 판을 그리면 서로의 줄을 덮어써서 둘 다 못 읽는 화면이 된다.
 */

/**
 * @typedef {object} BackgroundTask
 * @property {number} id
 * @property {string} title
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {"running" | "done" | "failed"} status
 * @property {number} [code]
 * @property {AbortController} controller
 */

/** @type {BackgroundTask[]} */
let tasks = [];
let nextId = 1;

/**
 * 작업 하나를 띄운다. **기다리지 않는다.**
 *
 * @param {object} args
 * @param {string} args.title
 * @param {(signal: AbortSignal) => Promise<number>} args.run
 * @param {(task: BackgroundTask) => void} [args.onDone]  끝났을 때 알린다
 * @returns {BackgroundTask}
 */
export function startTask({ title, run, onDone }) {
  const controller = new AbortController();
  /** @type {BackgroundTask} */
  const task = {
    id: nextId++,
    title,
    startedAt: Date.now(),
    status: "running",
    controller,
  };
  tasks.push(task);

  run(controller.signal)
    .then((code) => {
      task.code = code;
      task.status = code === 0 ? "done" : "failed";
    })
    .catch(() => {
      task.status = "failed";
    })
    .finally(() => {
      task.endedAt = Date.now();
      /*
       * 알림은 여기서 한 번만 낸다. 호출부가 폴링하게 두면 REPL 이 입력을 기다리는
       * 동안에는 아무도 안 돌아서 끝난 줄 모른다.
       */
      onDone?.(task);
    });

  return task;
}

/** @returns {readonly BackgroundTask[]} */
export function allTasks() {
  return tasks;
}

/** @returns {number} 아직 도는 작업 수. 프롬프트에 붙인다. */
export function runningCount() {
  return tasks.filter((t) => t.status === "running").length;
}

/**
 * @param {number} id
 * @returns {boolean} 실제로 멈춘 것이 있으면 true
 */
export function stopTask(id) {
  const task = tasks.find((t) => t.id === id && t.status === "running");
  if (!task) return false;
  task.controller.abort();
  return true;
}

/** 나갈 때 남은 작업을 정리한다. 안 끊으면 프로세스가 안 끝난다. */
export function stopAllTasks() {
  for (const task of tasks) if (task.status === "running") task.controller.abort();
}

/** 테스트용. */
export function resetTasks() {
  tasks = [];
  nextId = 1;
}
