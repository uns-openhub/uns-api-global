import {createHash} from 'node:crypto';

/** Fair selection inside an existing per-request recovery budget.
 * Each stable, already authorized request advances independently. Retain only
 * a bounded set of request fingerprints and cursors, never caller data/values.
 */
export class BudgetedFallbackRotation {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly budget: number, private readonly capacity = 256) {
    if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Recovery budget and cursor capacity must be positive integers');
    }
  }

  select<T>(candidates: readonly T[], authorizedRequest: readonly string[] = []): T[] {
    if (candidates.length === 0) return [];
    const key = createHash('sha256').update(JSON.stringify(authorizedRequest)).digest('hex');
    const start = (this.cursors.get(key) ?? 0) % candidates.length;
    const count = Math.min(this.budget, candidates.length);
    // Touch on access and evict the least recently used fingerprint at the cap.
    this.cursors.delete(key);
    this.cursors.set(key, (start + count) % candidates.length);
    if (this.cursors.size > this.capacity) this.cursors.delete(this.cursors.keys().next().value!);
    return Array.from({length: count}, (_, index) => candidates[(start + index) % candidates.length]!);
  }
}
