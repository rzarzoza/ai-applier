/** Runs tasks one at a time in the order they were added; a failing task never blocks the ones after it. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Resolves once everything queued so far has finished. */
  idle(): Promise<void> {
    return this.tail.then(() => {});
  }
}
