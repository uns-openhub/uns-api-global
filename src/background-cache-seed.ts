/** Disposable cache recovery is not a prerequisite for transferring ownership.
 * Stop admitting lookups on release; settle admitted reads without cancelling
 * another caller's coalesced lookup, and never apply a late pre-transfer fill.
 */
export class BackgroundCacheSeed<T> {
  private current: { accepting: boolean; done: Promise<{ inserted: number; interrupted: boolean }> } | undefined;

  constructor(private readonly options: {
    hasValue: (topic: string) => boolean;
    load: (topic: string) => Promise<T | null>;
    apply: (topic: string, value: T) => boolean;
    onError: () => void;
  }) {}

  pause(): void {
    if (this.current) this.current.accepting = false;
  }

  start(topics: readonly string[]): Promise<{ inserted: number; interrupted: boolean }> {
    if (this.current) return this.current.done;
    let next = 0;
    let inserted = 0;
    const cycle = { accepting: true, done: undefined as unknown as Promise<{ inserted: number; interrupted: boolean }> };
    this.current = cycle;
    cycle.done = Promise.all(Array.from({ length: Math.min(4, topics.length) }, async () => {
      while (cycle.accepting && next < topics.length) {
        const topic = topics[next++]!;
        if (this.options.hasValue(topic)) continue;
        try {
          const value = await this.options.load(topic);
          if (cycle.accepting && value !== null && this.options.apply(topic, value)) inserted++;
        } catch {
          if (cycle.accepting) this.options.onError();
        }
      }
    })).then(() => ({ inserted, interrupted: !cycle.accepting })).finally(() => {
      if (this.current === cycle) this.current = undefined;
    });
    return cycle.done;
  }
}
