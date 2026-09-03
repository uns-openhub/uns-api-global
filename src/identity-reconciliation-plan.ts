import type { EntityBindingResolution } from './entity-binding-client.js';

export type IdentityReconciliationCategory =
  | 'identity-aware'
  | 'legacy-resolvable'
  | 'ambiguous'
  | 'unresolvable';

export type IdentityReconciliationCounts = Record<IdentityReconciliationCategory, number>;

export type IdentityAuditRow = {
  topic: string;
  asOf: string;
  stableEntityId: string | null;
  identityResolution: string | null;
};

export type QuestDbIdentityTableShape = {
  table: string;
  columns: Set<string>;
  timeColumn: string | null;
};

export function emptyIdentityReconciliationCounts(): IdentityReconciliationCounts {
  return { 'identity-aware': 0, 'legacy-resolvable': 0, ambiguous: 0, unresolvable: 0 };
}

export function chooseIdentityAuditTimeColumn(columns: Iterable<string>): string | null {
  const available = new Set(columns);
  return ['time', 'timestamp', 'intervalStart'].find((column) => available.has(column)) ?? null;
}

export function buildFullObservationTopic(row: Record<string, unknown>): string | null {
  const segments = ['topic', 'asset', 'objectType', 'objectId', 'attribute']
    .map((column) => typeof row[column] === 'string' ? row[column].trim().replace(/^\/+|\/+$/g, '') : '')
    .filter(Boolean);
  if (!segments.length) return null;
  const topic = segments.join('/').normalize('NFC');
  return topic.includes('//') || /[+#]/.test(topic) ? null : topic;
}

export function classifyIdentityAuditRows(
  rows: IdentityAuditRow[],
  legacyResolutions: EntityBindingResolution[],
): IdentityReconciliationCounts {
  const counts = emptyIdentityReconciliationCounts();
  let resolutionIndex = 0;
  for (const row of rows) {
    if (row.stableEntityId && row.identityResolution === 'resolved') {
      counts['identity-aware'] += 1;
      continue;
    }
    const resolution = legacyResolutions[resolutionIndex++];
    if (!resolution || resolution.topic !== row.topic || resolution.asOf !== row.asOf) {
      counts.unresolvable += 1;
      continue;
    }
    if (resolution.status === 'resolved') counts['legacy-resolvable'] += 1;
    else if (resolution.status === 'ambiguous') counts.ambiguous += 1;
    else counts.unresolvable += 1;
  }
  if (resolutionIndex !== legacyResolutions.length) {
    throw new Error('Controller returned more temporal binding resolutions than legacy rows.');
  }
  return counts;
}

export function identityAuditBlockers(shape: QuestDbIdentityTableShape): string[] {
  const blockers: string[] = [];
  if (!shape.columns.has('topic')) blockers.push('missing-topic-column');
  if (!shape.timeColumn) blockers.push('missing-time-column');
  const identityColumns = ['stableEntityId', 'identityResolution', 'identityTimeBasis'];
  const present = identityColumns.filter((column) => shape.columns.has(column));
  if (present.length > 0 && present.length < identityColumns.length) {
    blockers.push(`partial-identity-schema:${identityColumns.filter((column) => !shape.columns.has(column)).join(',')}`);
  }
  return blockers;
}

export function identityAuditCountBlockers(counts: IdentityReconciliationCounts): string[] {
  const blockers: string[] = [];
  if (counts.ambiguous > 0) blockers.push(`ambiguous-rows:${counts.ambiguous}`);
  if (counts.unresolvable > 0) blockers.push(`unresolvable-rows:${counts.unresolvable}`);
  return blockers;
}

export function mergeIdentityReconciliationCounts(
  target: IdentityReconciliationCounts,
  source: IdentityReconciliationCounts,
): IdentityReconciliationCounts {
  for (const category of Object.keys(target) as IdentityReconciliationCategory[]) {
    target[category] += source[category];
  }
  return target;
}
