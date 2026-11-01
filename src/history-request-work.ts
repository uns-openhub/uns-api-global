import { QueryWorkloadError } from "./query-diagnostics.js";

/** Keep one request's fan-out within its effective database allocation.
 * The shared QueryDiagnostics semaphore still bounds all callers together.
 */
export async function mapHistoryRequests<T, R>(
  items: readonly T[],
  maxConcurrent: number,
  run: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
    throw new Error("History request concurrency must be a positive integer.");
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
    while (!failed && !signal?.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }));
  // Admitted work settles before returning, including during HTTP disconnect
  // or the SDK's request drain. Unstarted items never reach the database.
  if (failed) throw failure;
  if (signal?.aborted) throw new QueryWorkloadError("cancelled");
  return results;
}
