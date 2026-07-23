export type CanonicalTableColumn = {
  type: string;
  value: unknown;
  uom?: string;
};

/**
 * Project canonical table columns returned by @uns-kit/core 3.x parsing into
 * the last-value response shape. Legacy arrays are normalized by UnsPacket.
 */
export function tableColumnsToLastValues(columns: unknown): Record<string, unknown> {
  if (!columns || typeof columns !== "object" || Array.isArray(columns)) return {};

  const values: Record<string, unknown> = {};
  for (const [name, rawColumn] of Object.entries(columns as Record<string, unknown>)) {
    if (!rawColumn || typeof rawColumn !== "object" || Array.isArray(rawColumn)) continue;
    const column = rawColumn as Partial<CanonicalTableColumn>;
    if (!("value" in column)) continue;

    values[name] = column.value;
    const uom = typeof column.uom === "string" ? column.uom.trim() : "";
    if (uom) values[`${name}_uom`] = uom;
  }
  return values;
}
