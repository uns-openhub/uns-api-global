// src/captures/registry.ts
//
// In-memory registry of capture definitions fetched from the controller's
// GET /api/captures endpoint.  Mirrors TriggerRegistry but indexes every
// topic that can drive a capture decision: start, stop, input mappings, and
// explicit on-change driver topics.

import { logger } from "@uns-kit/core";
import type {
  CaptureConfig,
  CaptureCondition,
  CaptureDefinition,
  CaptureInputMapping,
  CaptureMode,
  CaptureOutputSchema,
} from "./types.js";

type CaptureApiRow = {
  id: string;
  name: string;
  startCondition: Record<string, unknown>;
  stopCondition: Record<string, unknown>;
  inputMappings: Array<Record<string, unknown>>;
  outputTopic: string;
  outputSchema?: Record<string, unknown> | null;
  captureConfig: Record<string, unknown>;
  enabled: boolean;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type CaptureApiResponse = {
  captures: CaptureApiRow[];
};

const DEFAULT_CAPTURE_STORAGE_DATA_GROUP = "capture";
const STORAGE_DATA_GROUP_RE = /^[a-z0-9_.-]{1,60}$/;

export type CaptureRegistryRefreshEvent = {
  previous: ReadonlyMap<string, CaptureDefinition>;
  current: ReadonlyMap<string, CaptureDefinition>;
};

export type CaptureRegistryRefreshListener = (
  event: CaptureRegistryRefreshEvent,
) => void | Promise<void>;

export type CaptureRegistryDeps = {
  controllerRestUrl: string;
  getAccessToken: () => Promise<string | null>;
  refreshIntervalMs: number;
  fetchImpl?: typeof fetch;
};

export class CaptureRegistry {
  private readonly deps: CaptureRegistryDeps;
  private readonly fetchImpl: typeof fetch;
  private byId: Map<string, CaptureDefinition> = new Map();
  private byTopic: Map<string, Set<string>> = new Map();
  private byTriggerId: Map<string, Set<string>> = new Map();
  private refreshListeners: Set<CaptureRegistryRefreshListener> = new Set();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(deps: CaptureRegistryDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        logger.warn(`[captures] background refresh failed: ${stringifyError(err)}`);
      });
    }, this.deps.refreshIntervalMs);
    if (this.refreshTimer && typeof this.refreshTimer.unref === "function") {
      this.refreshTimer.unref();
    }
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.started = false;
  }

  getCapturesForTopic(topic: string): CaptureDefinition[] {
    const ids = this.byTopic.get(topic);
    if (!ids || ids.size === 0) return [];
    const out: CaptureDefinition[] = [];
    for (const id of ids) {
      const capture = this.byId.get(id);
      if (capture) out.push(capture);
    }
    return out;
  }

  getCapturesForTrigger(triggerId: string): CaptureDefinition[] {
    const ids = this.byTriggerId.get(triggerId);
    if (!ids || ids.size === 0) return [];
    const out: CaptureDefinition[] = [];
    for (const id of ids) {
      const capture = this.byId.get(id);
      if (capture) out.push(capture);
    }
    return out;
  }

  list(): CaptureDefinition[] {
    return Array.from(this.byId.values());
  }

  size(): number {
    return this.byId.size;
  }

  onRefresh(listener: CaptureRegistryRefreshListener): () => void {
    this.refreshListeners.add(listener);
    return () => {
      this.refreshListeners.delete(listener);
    };
  }

  async refresh(): Promise<void> {
    const url = `${this.deps.controllerRestUrl.replace(/\/+$/, "")}/captures`;
    let token: string | null = null;
    try {
      token = await this.deps.getAccessToken();
    } catch (err) {
      logger.warn(`[captures] could not get access token: ${stringifyError(err)}`);
      return;
    }
    if (!token) {
      logger.warn("[captures] no access token available; skipping refresh");
      return;
    }

    let payload: CaptureApiResponse;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        logger.warn(
          `[captures] controller responded ${response.status} for GET /api/captures; keeping existing registry`,
        );
        return;
      }
      payload = (await response.json()) as CaptureApiResponse;
    } catch (err) {
      logger.warn(`[captures] failed to fetch from controller: ${stringifyError(err)}`);
      return;
    }
    if (!payload || !Array.isArray(payload.captures)) {
      logger.warn("[captures] unexpected response shape from controller; keeping existing registry");
      return;
    }
    this.applyRows(payload.captures);
    logger.info(
      `[captures] registry refreshed: ${this.byId.size} active captures across ${this.byTopic.size} watched topics`,
    );
  }

  private applyRows(rows: CaptureApiRow[]): void {
    const previousById = this.byId;
    const nextById = new Map<string, CaptureDefinition>();
    const nextByTopic = new Map<string, Set<string>>();
    const nextByTriggerId = new Map<string, Set<string>>();
    const addToIndex = (topic: string, id: string) => {
      let set = nextByTopic.get(topic);
      if (!set) {
        set = new Set();
        nextByTopic.set(topic, set);
      }
      set.add(id);
    };
    const addToTriggerIndex = (triggerId: string, id: string) => {
      let set = nextByTriggerId.get(triggerId);
      if (!set) {
        set = new Set();
        nextByTriggerId.set(triggerId, set);
      }
      set.add(id);
    };
    const addConditionToIndex = (condition: CaptureCondition, id: string) => {
      if (condition.source === "trigger") {
        addToTriggerIndex(condition.triggerId, id);
        return;
      }
      if (condition.source === "always" || condition.source === "never") return;
      addToIndex(condition.topic, id);
    };

    for (const row of rows) {
      const capture = mapApiRowToDefinition(row);
      if (!capture) continue;
      nextById.set(capture.id, capture);
      addConditionToIndex(capture.startCondition, capture.id);
      addConditionToIndex(capture.stopCondition, capture.id);
      for (const mapping of capture.inputMappings) {
        addToIndex(mapping.topic, capture.id);
      }
      for (const mode of capture.captureConfig.modes) {
        if (mode.type !== "onChange") continue;
        for (const topic of mode.driverTopics) {
          addToIndex(topic, capture.id);
        }
      }
    }

    this.byId = nextById;
    this.byTopic = nextByTopic;
    this.byTriggerId = nextByTriggerId;
    this.emitRefresh({ previous: previousById, current: nextById });
  }

  private emitRefresh(event: CaptureRegistryRefreshEvent): void {
    for (const listener of this.refreshListeners) {
      Promise.resolve(listener(event)).catch((err) => {
        logger.warn(`[captures] registry refresh listener failed: ${stringifyError(err)}`);
      });
    }
  }
}

function mapApiRowToDefinition(row: CaptureApiRow): CaptureDefinition | null {
  if (!row || typeof row.id !== "string" || typeof row.outputTopic !== "string") return null;
  const startCondition = mapCondition(row.startCondition);
  const stopCondition = mapCondition(row.stopCondition);
  const inputMappings = mapInputMappings(row.inputMappings);
  const captureConfig = mapCaptureConfig(row.captureConfig);
  const outputSchema = mapOutputSchema(row.outputSchema);
  if (!startCondition || !stopCondition || inputMappings.length === 0 || !captureConfig) {
    return null;
  }
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : row.id,
    startCondition,
    stopCondition,
    inputMappings,
    outputTopic: row.outputTopic,
    outputSchema,
    captureConfig,
    enabled: row.enabled === true,
    description: typeof row.description === "string" ? row.description : null,
    createdBy: typeof row.createdBy === "string" ? row.createdBy : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
}

function mapOutputSchema(raw: Record<string, unknown> | null | undefined): CaptureOutputSchema | null {
  if (
    !raw ||
    raw["schemaVersion"] !== 1 ||
    raw["kind"] !== "capture-table"
  ) {
    return null;
  }
  const dataGroup = normalizeStorageDataGroup(raw["dataGroup"]);
  const columns = Array.isArray(raw["columns"])
    ? raw["columns"]
        .map((entry): CaptureOutputSchema["columns"][number] | null => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const column = entry as Record<string, unknown>;
          const name =
            typeof column["name"] === "string" && column["name"].trim().length
              ? column["name"].trim()
              : null;
          const displayLabel =
            typeof column["displayLabel"] === "string" && column["displayLabel"].trim().length
              ? column["displayLabel"].trim()
              : undefined;
          const role =
            column["role"] === "system" || column["role"] === "mapped" ? column["role"] : null;
          const valueType =
            column["valueType"] === "string" || column["valueType"] === "dynamic"
              ? column["valueType"]
              : null;
          if (!name || !role || !valueType) return null;
          const logicalType =
            column["logicalType"] === "iso8601" || column["logicalType"] === "enum"
              ? column["logicalType"]
              : undefined;
          const values = Array.isArray(column["values"])
            ? column["values"].filter((value): value is string => typeof value === "string" && value.length > 0)
            : undefined;
          const sourceTopic = typeof column["sourceTopic"] === "string" && column["sourceTopic"].length
            ? column["sourceTopic"]
            : undefined;
          const sourceType =
            column["sourceType"] === "data" || column["sourceType"] === "table"
              ? column["sourceType"]
              : undefined;
          const sourceColumn =
            typeof column["sourceColumn"] === "string" && column["sourceColumn"].trim().length
              ? column["sourceColumn"].trim()
              : undefined;
          const uomMode =
            column["uomMode"] === "inherit" || column["uomMode"] === "override" || column["uomMode"] === "none"
              ? column["uomMode"]
              : undefined;
          const summaryAggregation =
            column["summaryAggregation"] === "first" ||
            column["summaryAggregation"] === "min" ||
            column["summaryAggregation"] === "max" ||
            column["summaryAggregation"] === "avg" ||
            column["summaryAggregation"] === "count"
              ? column["summaryAggregation"]
              : column["summaryAggregation"] === "last"
                ? "last"
                : undefined;
          const uom =
            uomMode === "override" && typeof column["uom"] === "string" && column["uom"].trim().length
              ? column["uom"].trim()
              : undefined;
          return {
            name,
            ...(displayLabel ? { displayLabel } : {}),
            role,
            valueType,
            required: column["required"] === true,
            nullable: column["nullable"] === true,
            ...(logicalType ? { logicalType } : {}),
            ...(values && values.length ? { values } : {}),
            ...(sourceTopic ? { sourceTopic } : {}),
            ...(sourceType ? { sourceType } : {}),
            ...(sourceColumn ? { sourceColumn } : {}),
            ...(summaryAggregation ? { summaryAggregation } : {}),
            ...(uomMode ? { uomMode } : {}),
            ...(uom ? { uom } : {}),
          };
        })
        .filter((entry): entry is CaptureOutputSchema["columns"][number] => !!entry)
    : [];
  return {
    schemaVersion: 1,
    kind: "capture-table",
    dataGroup,
    columns,
  };
}

function normalizeStorageDataGroup(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_CAPTURE_STORAGE_DATA_GROUP;
  const value = raw.trim();
  return STORAGE_DATA_GROUP_RE.test(value) ? value : DEFAULT_CAPTURE_STORAGE_DATA_GROUP;
}

function mapCondition(raw: Record<string, unknown>): CaptureCondition | null {
  if (raw["source"] === "always") return { source: "always" };
  if (raw["source"] === "never") return { source: "never" };
  if (raw["source"] === "trigger") {
    const triggerId = raw["triggerId"];
    return typeof triggerId === "string" && triggerId.trim().length
      ? { source: "trigger", triggerId: triggerId.trim() }
      : null;
  }
  const topic = raw["topic"];
  const operator = raw["operator"];
  const value = raw["value"];
  if (typeof topic !== "string" || topic.length === 0) return null;
  if (
    operator !== "gt" &&
    operator !== "gte" &&
    operator !== "lt" &&
    operator !== "lte" &&
    operator !== "eq" &&
    operator !== "neq"
  ) {
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  return { source: "topic", topic, operator, value };
}

function mapInputMappings(raw: Array<Record<string, unknown>>): CaptureInputMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptureInputMapping[] = [];
  for (const entry of raw) {
    const topic = entry["topic"];
    const columnName = entry["columnName"];
    if (typeof topic !== "string" || topic.length === 0) continue;
    if (typeof columnName !== "string" || columnName.length === 0) continue;
    const sourceType =
      entry["sourceType"] === "table"
        ? "table"
        : entry["sourceType"] === "data" || entry["sourceType"] === undefined || entry["sourceType"] === null
          ? "data"
          : null;
    if (!sourceType) continue;
    const sourceColumn =
      sourceType === "table" && typeof entry["sourceColumn"] === "string" && entry["sourceColumn"].trim().length
        ? entry["sourceColumn"].trim()
        : null;
    if (sourceType === "table" && !sourceColumn) continue;
    out.push({
      topic,
      columnName,
      ...(typeof entry["displayLabel"] === "string" && entry["displayLabel"].trim().length
        ? { displayLabel: entry["displayLabel"].trim() }
        : {}),
      sourceType,
      ...(sourceColumn ? { sourceColumn } : {}),
      required: entry["required"] === true,
      summaryAggregation:
        entry["summaryAggregation"] === "first" ||
        entry["summaryAggregation"] === "min" ||
        entry["summaryAggregation"] === "max" ||
        entry["summaryAggregation"] === "avg" ||
        entry["summaryAggregation"] === "count"
          ? entry["summaryAggregation"]
          : "last",
      uomMode:
        entry["uomMode"] === "override" || entry["uomMode"] === "none"
          ? entry["uomMode"]
          : "inherit",
      ...(entry["uomMode"] === "override" && typeof entry["uom"] === "string" && entry["uom"].trim().length
        ? { uom: entry["uom"].trim() }
        : {}),
    });
  }
  return out;
}

function mapCaptureConfig(raw: Record<string, unknown>): CaptureConfig | null {
  const rawModes = raw["modes"];
  if (!Array.isArray(rawModes) || rawModes.length === 0) return null;
  const modes: CaptureMode[] = [];
  for (const entry of rawModes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const mode = entry as Record<string, unknown>;
    if (mode["type"] === "summary") {
      modes.push({ type: "summary" });
    } else if (
      mode["type"] === "interval" &&
      typeof mode["intervalMs"] === "number" &&
      Number.isFinite(mode["intervalMs"])
    ) {
      modes.push({ type: "interval", intervalMs: Math.floor(mode["intervalMs"]) });
    } else if (mode["type"] === "onChange") {
      const rawDriverTopics = mode["driverTopics"];
      const driverTopics = Array.isArray(rawDriverTopics)
        ? rawDriverTopics.filter((topic): topic is string => typeof topic === "string" && topic.length > 0)
        : [];
      modes.push({ type: "onChange", driverTopics });
    } else if (mode["type"] === "singleShot") {
      modes.push({ type: "singleShot" });
    }
  }
  if (modes.length === 0) return null;
  const windowMode = raw["windowMode"] === "alwaysOn" ? "alwaysOn" : "condition";
  const missingValuePolicy = raw["missingValuePolicy"] === "skipRow" ? "skipRow" : "null";
  const rawMaxSessionMs = raw["maxSessionMs"];
  const maxSessionMs =
    rawMaxSessionMs === null
      ? null
      : typeof rawMaxSessionMs === "number" && Number.isFinite(rawMaxSessionMs) && rawMaxSessionMs > 0
        ? Math.floor(rawMaxSessionMs)
        : windowMode === "alwaysOn"
          ? null
          : 60 * 60 * 1000;
  return {
    windowMode,
    modes,
    missingValuePolicy,
    maxSessionMs,
    includeTechnicalColumns: raw["includeTechnicalColumns"] !== false,
    storageDataGroup: normalizeStorageDataGroup(raw["storageDataGroup"] ?? raw["dataGroup"]),
  };
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
