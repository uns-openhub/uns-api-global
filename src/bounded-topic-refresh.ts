/** One controller discovery at a time, including cancellation/credential lookup.
 * A timed-out non-cooperative loader keeps the gate until it settles: never
 * accumulate a new blocked operation on every refresh tick.
 */
export class BoundedTopicRefresh<T> {
  private pending: Promise<T | null> | undefined;
  private reported: boolean | undefined;
  constructor(
    private readonly load: (signal: AbortSignal) => Promise<T>,
    private readonly timeoutMs = 5000,
    private readonly onState?: (ready: boolean) => void,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Invalid discovery timeout');
  }
  refresh(): Promise<T | null> {
    if (this.pending) return this.pending;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const report = (ready: boolean) => {
      if (ready !== this.reported) { this.reported = ready; this.onState?.(ready); }
    };
    const work = Promise.resolve().then(() => this.load(controller.signal)).then(
      value => { if (controller.signal.aborted) return null; report(true); return value; },
      () => { report(false); return null; },
    );
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); report(false); resolve(null); }, this.timeoutMs);
    });
    const result = Promise.race([work, deadline]);
    this.pending = result;
    void work.finally(() => {
      clearTimeout(timer);
      controller.abort();
      if (this.pending === result) this.pending = undefined;
    });
    return result;
  }
}

/** MQTT topic membership is a set; controller row order is not a subscription change. */
export function topicSubscriptionDelta(previous: readonly string[], incoming: readonly string[]) {
  const before = new Set(previous);
  const after = new Set(incoming);
  return {
    topics: [...after].sort(),
    added: [...after].filter(topic => !before.has(topic)).sort(),
    removed: [...before].filter(topic => !after.has(topic)).sort(),
  };
}
