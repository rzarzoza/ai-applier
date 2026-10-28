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

/**
 * One run per job at a time. Runs of different jobs may overlap (a rebuild runs on its own tab while the queue's run goes
 * on), but never two runs touching the same job.
 */
export class JobLocks {
  private readonly held = new Map<string, Promise<void>>();

  isHeld(jobId: string): boolean {
    return this.held.has(jobId);
  }

  /** Takes the job's lock if it is free; returns its release, or null when another run holds it. */
  tryAcquire(jobId: string): (() => void) | null {
    if (this.held.has(jobId)) return null;
    let release!: () => void;
    const done = new Promise<void>(r => { release = r; });
    this.held.set(jobId, done);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.held.get(jobId) === done) this.held.delete(jobId);
      release();
    };
  }

  /** Waits until the job's lock is free, then takes it; returns its release. */
  async acquire(jobId: string): Promise<() => void> {
    for (;;) {
      const release = this.tryAcquire(jobId);
      if (release) return release;
      await this.held.get(jobId);
    }
  }
}
