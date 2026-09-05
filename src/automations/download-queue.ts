/** Bound file transfers independently of the single browser page. */
export class DownloadQueue {
  #active = 0;
  readonly #waiting: Array<() => void> = [];
  constructor(readonly limit = 4) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid download concurrency");
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limit)
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#active++;
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}
