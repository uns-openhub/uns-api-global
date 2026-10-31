import { z } from 'zod';

const finite = z.number().finite();
const count = z.number().int().nonnegative();
const time = z.string().datetime();
const key = z.string().min(1).max(4096);
const scalar = z.union([z.string(), finite, z.null()]);
const entries = <T extends z.ZodType>(schema: T) => z.array(z.tuple([key, schema])).max(10000)
  .refine(rows => new Set(rows.map(row => row[0])).size === rows.length, 'Duplicate runtime identity');

export const triggerMigrationState = z.strictObject({
  definitions: z.array(z.unknown()).max(1000),
  state: entries(z.strictObject({ lastSeenValue: scalar, lastFiredAt: finite.nullable(),
    lastComparisonResult: z.boolean().nullable().optional(), lastCompositeResult: z.boolean().nullable().optional() })),
  metrics: entries(z.strictObject({ fireCount: count, suppressionCount: count, lastSuppressedReason: z.string().nullable(), lastEvaluatedAt: finite.nullable() })),
});

export const captureMigrationState = z.strictObject({
  definitions: z.array(z.unknown()).max(1000),
  conditions: entries(z.strictObject({ start: z.boolean().nullable(), stop: z.boolean().nullable() })),
  metrics: entries(z.strictObject({ rowCount: count, sessionCount: count, lastRowAt: time.nullable(), lastStartedAt: time.nullable(),
    lastEndedAt: time.nullable(), lastCloseReason: z.string().nullable(), lastSuppressedReason: z.string().nullable(), lastEvaluatedAt: finite.nullable() })),
  diagnostics: entries(z.strictObject({ lastInputTopic: z.string().nullable(), lastInputValue: z.string().nullable(), lastInputUom: z.string().nullable(),
    lastInputAt: time.nullable(), lastTriggerId: z.string().nullable(), lastTriggerName: z.string().nullable(), lastTriggerAt: time.nullable(),
    startMatched: z.boolean().nullable(), stopMatched: z.boolean().nullable() })),
  sessions: z.array(z.strictObject({ id: key, sessionId: key, capture: z.unknown(), startedAt: time, startedAtMs: finite,
    rowCount: count, lastRowAt: time.nullable(), closing: z.literal(false),
    aggregates: entries(z.strictObject({ hasFirst: z.boolean(), first: z.unknown(), last: z.unknown(), count, numericCount: count,
      sum: finite, min: finite.nullable(), max: finite.nullable(), uom: z.string().nullable() })),
  })).max(1000).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Duplicate active session'),
});

export const apiMigrationState = z.strictObject({
  cacheTopics: z.array(key).max(10000).refine(topics => new Set(topics).size === topics.length, 'Duplicate cache topic'),
  cache: entries(z.object({ values: z.record(z.string(), z.unknown()), uom: z.string().nullable(), timestamp: time,
    receivedAt: finite, dataGroup: z.string().nullable(), packetShape: z.enum(['data', 'table']).optional(),
    counter: z.strictObject({ absoluteValue: finite, previousValue: finite.nullable(), previousTimestamp: time.nullable() }).optional(),
  }).passthrough()),
  triggers: triggerMigrationState.nullable(), captures: captureMigrationState.nullable(),
});

/** Only automation dependencies are semantic RAM state. The general read cache is rebuildable. */
export function automationCacheTopics(definitions: unknown): string[] {
  const topics = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (['topic', 'sourceTopic', 'leftTopic', 'rightTopic'].includes(name) && typeof child === 'string') topics.add(child);
      else if (['snapshotTopics', 'driverTopics'].includes(name) && Array.isArray(child)) {
        for (const topic of child) if (typeof topic === 'string') topics.add(topic);
      } else walk(child);
    }
  };
  walk(definitions);
  return [...topics].sort();
}
