export type EntityLastSelector = {
  stableEntityId: string;
  attributePath: string;
};

export type EntityLastBinding = {
  topic: string;
  bindingRevision: string;
  bindingDigest: string;
};

export type EntityLastCacheHit<T> = EntityLastBinding & {
  value: T;
};

function selectorKey(selector: EntityLastSelector): string {
  return `${selector.stableEntityId.toLowerCase()}\0${selector.attributePath}`;
}

function bindingKey(binding: EntityLastBinding): string {
  return `${binding.topic}\0${binding.bindingRevision}\0${binding.bindingDigest}`;
}

export class EntityLastValueCache<T extends { timestamp: string | null }> {
  private readonly bindingsBySelector = new Map<string, Map<string, EntityLastBinding>>();
  private readonly selectorsByTopic = new Map<string, Set<string>>();
  private readonly values = new Map<string, EntityLastCacheHit<T>>();

  replaceBindings(selector: EntityLastSelector, bindings: EntityLastBinding[]): void {
    const key = selectorKey(selector);
    const previous = this.bindingsBySelector.get(key);
    for (const binding of previous?.values() ?? []) {
      const selectors = this.selectorsByTopic.get(binding.topic);
      selectors?.delete(key);
      if (selectors?.size === 0) this.selectorsByTopic.delete(binding.topic);
    }

    const next = new Map(bindings.map((binding) => [bindingKey(binding), binding]));
    this.bindingsBySelector.set(key, next);
    for (const binding of next.values()) {
      const selectors = this.selectorsByTopic.get(binding.topic) ?? new Set<string>();
      selectors.add(key);
      this.selectorsByTopic.set(binding.topic, selectors);
    }

    const cached = this.values.get(key);
    if (cached && !next.has(bindingKey(cached))) this.values.delete(key);
  }

  updateTopic(topic: string, value: T): void {
    if (!value.timestamp || Number.isNaN(new Date(value.timestamp).getTime())) return;
    for (const key of this.selectorsByTopic.get(topic) ?? []) {
      const binding = Array.from(this.bindingsBySelector.get(key)?.values() ?? [])
        .filter((candidate) => candidate.topic === topic)
        .sort((left, right) => right.bindingRevision.localeCompare(left.bindingRevision))[0];
      if (!binding) continue;
      const current = this.values.get(key);
      if (
        current?.value.timestamp
        && new Date(current.value.timestamp).getTime() > new Date(value.timestamp).getTime()
      ) continue;
      this.values.set(key, { ...binding, value });
    }
  }

  get(selector: EntityLastSelector): EntityLastCacheHit<T> | null {
    return this.values.get(selectorKey(selector)) ?? null;
  }

  get size(): number {
    return this.values.size;
  }
}
