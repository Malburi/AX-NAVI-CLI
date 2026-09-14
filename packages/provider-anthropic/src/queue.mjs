/*
 * 콜백 → async iterator 브리지.
 *
 * SDK의 스트림은 `.on("text", cb)` 형태로 이벤트를 밀어 주는데 Core의 루프는
 * `for await`로 당겨 쓴다. 그 사이를 잇는 최소 큐다.
 *
 * 폴링(setTimeout으로 큐를 되풀이해 들여다보는 방식)을 쓰지 않는 것이 요점이다.
 * 폴링은 지연을 만들고, 소비자가 느릴 때 이벤트를 흘릴 수 있다. 여기서는
 * 대기 중인 소비자에게 곧바로 넘기고, 없으면 쌓아 둔다.
 */

/**
 * @template T
 */
export class AsyncQueue {
  constructor() {
    /** @type {T[]} */
    this.items = [];
    /** @type {Array<(r: IteratorResult<T>) => void>} */
    this.waiters = [];
    /** @type {boolean} */
    this.closed = false;
    /** @type {unknown} */
    this.failure = null;
  }

  /** @param {T} item */
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** 더 이상 이벤트가 없음을 알린다. 대기 중인 소비자를 전부 깨운다. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: /** @type {any} */ (undefined), done: true });
    }
  }

  /**
   * 오류로 끝낸다. 소비자가 조용히 정상 종료로 오해하지 않도록 다음 next()에서 던진다.
   * @param {unknown} error
   */
  fail(error) {
    this.failure = error;
    this.close();
  }

  /** @returns {AsyncIterableIterator<T>} */
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) {
          return Promise.resolve({ value: /** @type {T} */ (this.items.shift()), done: false });
        }
        if (this.failure) {
          const error = this.failure;
          this.failure = null;
          return Promise.reject(error);
        }
        if (this.closed) return Promise.resolve({ value: /** @type {any} */ (undefined), done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: /** @type {any} */ (undefined), done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}
