import type { Logger } from "../logger.js";

type Pending = { version: number; retryAt: number; failures: number };

// Coalesce bursts of turn events. Failed registrations remain queued, and a
// completion arriving during an in-flight "running" update always gets a pass.
export class GuestDesktopSync {
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly sync: (threadId: string) => Promise<void>,
    private readonly activeThreads: () => string[],
    private readonly logger: Logger,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const id of this.activeThreads()) if (!this.pending.has(id)) this.enqueue(id);
      void this.flush();
    }, this.intervalMs);
    this.timer.unref();
  }

  enqueue(threadId: string): void {
    if (this.stopped) return;
    const prior = this.pending.get(threadId);
    this.pending.set(threadId, { version: (prior?.version ?? 0) + 1, retryAt: 0, failures: 0 });
  }

  async flush(): Promise<void> {
    if (this.stopped) return;
    for (const [id, state] of this.pending) {
      if (this.inFlight.has(id) || state.retryAt > Date.now()) continue;
      const work = this.run(id, state).finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, work);
    }
    await Promise.all(this.inFlight.values());
  }

  private async run(id: string, state: Pending): Promise<void> {
    try {
      await this.sync(id);
      if (this.pending.get(id) === state) this.pending.delete(id);
    } catch (error) {
      if (this.pending.get(id) === state) {
        state.failures++;
        state.retryAt = Date.now() + Math.min(60_000, this.intervalMs * 2 ** Math.min(state.failures - 1, 4));
      }
      this.logger.warn("访客 Desktop 同步失败，已加入自动重试", {
        threadId: id, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(this.inFlight.values());
  }
}
