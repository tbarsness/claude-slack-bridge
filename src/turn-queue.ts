/**
 * Per-key turn queue and the global Claude concurrency limit, shared by the
 * Slack handler and the food-chat endpoint so a Slack reply and an app turn
 * never run on the same Claude session at once.
 */

const threadQueues = new Map<string, Promise<void>>();

/**
 * Global cap on concurrently-running Claude subprocesses. Each turn spawns a
 * full Claude Code agent; without a cap, a burst of messages (e.g. several
 * food-log entries in a row) spawns several heavy agents at once, pins the
 * host, and starves the Node event loop, which makes the Slack socket miss
 * pings and drop inbound messages during reconnects. Receipt is still
 * acknowledged instantly (the :eyes: reaction is added before acquiring a
 * slot); only the Claude run itself waits its turn.
 */
const MAX_CONCURRENT_CLAUDE = Number(process.env.MAX_CONCURRENT_CLAUDE) || 2;

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export const claudeLimiter = new Semaphore(MAX_CONCURRENT_CLAUDE);

export function enqueue(threadKey: string, work: () => Promise<void>): Promise<void> {
  const prev = threadQueues.get(threadKey) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(work);
  threadQueues.set(
    threadKey,
    next.finally(() => {
      if (threadQueues.get(threadKey) === next) threadQueues.delete(threadKey);
    }),
  );
  return next;
}
