interface Job<T> {
  run: (abort: AbortController) => Promise<T>;
  resolve: (value: T | "cancelled") => void;
  reject: (reason: unknown) => void;
}

export class OwnerQueue {
  private readonly pending: Array<Job<unknown>> = [];
  private active: AbortController | null = null;
  private pumping = false;

  enqueue<T>(run: (abort: AbortController) => Promise<T>): Promise<T | "cancelled"> {
    return new Promise((resolve, reject) => {
      this.pending.push({ run, resolve, reject } as Job<unknown>);
      void this.pump();
    });
  }

  stop(): number {
    this.active?.abort();
    const cancelled = this.pending.splice(0);
    for (const job of cancelled) job.resolve("cancelled");
    return cancelled.length + (this.active ? 1 : 0);
  }

  get depth(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length) {
        const job = this.pending.shift()!;
        const abort = new AbortController();
        this.active = abort;
        try {
          job.resolve(await job.run(abort));
        } catch (error) {
          if (abort.signal.aborted) job.resolve("cancelled");
          else job.reject(error);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
