// src/captures/publisher.ts
//
// Builds UNS table-shaped MQTT payloads for capture rows. The surrounding
// runtime decides when rows should be emitted; this module only translates a
// row into a table message and delegates packet construction to uns-kit core.

import { UnsPacket } from "@uns-kit/core/uns/uns-packet.js";
import {
  isIOS8601Type,
  type ISO8601,
  type IUnsPacket,
  type IUnsTableColumn,
  type IUnsTableColumns,
} from "@uns-kit/core/uns/uns-interfaces.js";
import type { CaptureDefinition, CaptureOutputSchema, CaptureRow } from "./types.js";

const DEFAULT_CAPTURE_STORAGE_DATA_GROUP = "capture";

export type CapturePublishFn = (params: {
  outputTopic: string;
  payload: string;
}) => Promise<void> | void;

export type CapturePublisherDeps = {
  publish: CapturePublishFn;
};

export class CapturePublisher {
  private readonly publish: CapturePublishFn;

  constructor(deps: CapturePublisherDeps) {
    this.publish = deps.publish;
  }

  async publishRow(capture: CaptureDefinition, row: CaptureRow): Promise<void> {
    const payload = await this.buildPayload(row, capture.outputSchema);
    await this.publish({
      outputTopic: capture.outputTopic,
      payload: JSON.stringify(payload),
    });
  }

  async buildPayload(row: CaptureRow, outputSchema: CaptureOutputSchema | null = null): Promise<IUnsPacket> {
    const values = orderValuesBySchema({
      sessionId: row.sessionId,
      startedAt: row.startedAt,
      sampledAt: row.sampledAt,
      endedAt: row.endedAt ?? null,
      rowType: row.rowType,
      changedTopic: row.changedTopic ?? null,
      ...row.values,
    }, outputSchema);

    const uoms = resolveColumnUoms(row.uoms, outputSchema);
    const columns = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        columnFromValue(value, uoms[name]),
      ]),
    ) as IUnsTableColumns;
    const dataGroup = resolveOutputDataGroup(outputSchema);

    const packet = await UnsPacket.unsPacketFromUnsMessage({
      table: {
        time: asIso8601(row.sampledAt, "sampledAt"),
        dataGroup,
        columns,
      },
    });
    if (!packet) throw new Error("Could not build capture UNS packet.");
    return packet;
  }
}

function resolveOutputDataGroup(outputSchema: CaptureOutputSchema | null): string {
  const value = typeof outputSchema?.dataGroup === "string" ? outputSchema.dataGroup.trim() : "";
  return value || DEFAULT_CAPTURE_STORAGE_DATA_GROUP;
}

function orderValuesBySchema(
  values: Record<string, unknown>,
  outputSchema: CaptureOutputSchema | null,
): Record<string, unknown> {
  if (!outputSchema?.columns?.length) return values;
  const ordered: Record<string, unknown> = {};
  for (const column of outputSchema.columns) {
    ordered[column.name] = Object.prototype.hasOwnProperty.call(values, column.name)
      ? values[column.name]
      : null;
  }
  return ordered;
}

function resolveColumnUoms(
  rowUoms: Record<string, string | null> | undefined,
  outputSchema: CaptureOutputSchema | null,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (outputSchema?.columns?.length) {
    for (const column of outputSchema.columns) {
      if (column.role !== "mapped") continue;
      if (column.uomMode === "none") {
        out[column.name] = null;
      } else if (column.uomMode === "override") {
        out[column.name] = column.uom?.trim() || null;
      }
    }
  }
  for (const [name, uom] of Object.entries(rowUoms ?? {})) {
    out[name] = typeof uom === "string" && uom.trim().length ? uom.trim() : null;
  }
  return out;
}

function columnFromValue(
  value: unknown,
  uom: string | null | undefined,
): IUnsTableColumn {
  const withUom = (column: IUnsTableColumn): IUnsTableColumn => {
    const normalized = typeof uom === "string" ? uom.trim() : "";
    return normalized
      ? { ...column, uom: normalized as NonNullable<IUnsTableColumn["uom"]> }
      : column;
  };
  if (value === null || value === undefined) return withUom({ type: "string", value: null });
  if (typeof value === "number") {
    return withUom({ type: "double", value: Number.isFinite(value) ? value : null });
  }
  if (typeof value === "boolean") return withUom({ type: "boolean", value });
  if (typeof value === "string") return withUom({ type: "string", value });
  return withUom({ type: "string", value: stringifyColumnValue(value) });
}

function stringifyColumnValue(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded === "string") return encoded;
  } catch {
    // Fall back below for values JSON cannot encode, such as bigint.
  }
  return String(value);
}

function asIso8601(value: string, fieldName: string): ISO8601 {
  if (isIOS8601Type(value)) return value;
  throw new Error(`Capture row ${fieldName} must be ISO8601.`);
}
