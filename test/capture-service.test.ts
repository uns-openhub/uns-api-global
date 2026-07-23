import test from "node:test";
import assert from "node:assert/strict";

import { CapturePublisher } from "../src/captures/publisher.js";
import { CaptureRegistry } from "../src/captures/registry.js";
import { CaptureService, type CaptureSessionAuditEvent } from "../src/captures/service.js";
import type { CaptureDefinition, CaptureOutputSchema } from "../src/captures/types.js";

function fakeFetch(captures: CaptureDefinition[]) {
  return async (url: string | URL): Promise<Response> => {
    if (typeof url === "string" && url.endsWith("/captures")) {
      return new Response(JSON.stringify({ captures }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  };
}

function makeTimers() {
  type Timer = { callback: () => void; ms: number; cleared: boolean };
  const intervals: Timer[] = [];
  const timeouts: Timer[] = [];
  return {
    intervals,
    timeouts,
    api: {
      setInterval: (callback: () => void, ms: number) => {
        const timer = { callback, ms, cleared: false };
        intervals.push(timer);
        return timer as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (handle: ReturnType<typeof setInterval>) => {
        (handle as unknown as Timer).cleared = true;
      },
      setTimeout: (callback: () => void, ms: number) => {
        const timer = { callback, ms, cleared: false };
        timeouts.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        (handle as unknown as Timer).cleared = true;
      },
    },
  };
}

function makeServices(
  captures: CaptureDefinition[],
  options: {
    cache?: Record<string, { value: unknown; values?: Record<string, unknown>; uom?: string | null; time?: string; receivedAt?: number }>;
    now?: () => number;
    auditEvents?: CaptureSessionAuditEvent[];
  } = {},
) {
  const publishCalls: Array<{ outputTopic: string; payload: string }> = [];
  const publisher = new CapturePublisher({
    publish: ({ outputTopic, payload }) => {
      publishCalls.push({ outputTopic, payload });
    },
  });
  const registry = new CaptureRegistry({
    controllerRestUrl: "http://localhost:3200/api",
    getAccessToken: async () => "fake-jwt",
    refreshIntervalMs: 60_000,
    fetchImpl: fakeFetch(captures) as unknown as typeof fetch,
  });
  const timers = makeTimers();
  const cache = options.cache ?? {};
  const service = new CaptureService({
    registry,
    publisher,
    auditSession: (event) => {
      options.auditEvents?.push(event);
    },
    now: options.now ?? (() => 5_000),
    createSessionId: () => "session-1",
    timers: timers.api,
    getLastValue: (topic: string) => {
      const e = cache[topic];
      if (!e) return null;
      return {
        value: e.value,
        values: e.values ?? { value: e.value },
        uom: e.uom ?? null,
        time: e.time ?? "2026-06-07T10:00:00.000Z",
        receivedAt: e.receivedAt ?? 0,
      };
    },
  });
  return { registry, service, publishCalls, cache, timers };
}

const BASE_CAPTURE: CaptureDefinition = {
  id: "capture-1",
  name: "Furnace cycle capture",
  startCondition: {
    topic: "factory/line/furnace/state",
    operator: "eq",
    value: "RUNNING",
  },
  stopCondition: {
    topic: "factory/line/furnace/state",
    operator: "eq",
    value: "COMPLETE",
  },
  inputMappings: [
    {
      topic: "factory/line/furnace/temp",
      columnName: "temperature",
      sourceType: "data",
      required: false,
      uomMode: "inherit",
    },
  ],
  outputTopic: "factory/line/furnace/capture/cycle/records",
  outputSchema: null,
  captureConfig: {
    windowMode: "condition",
    modes: [{ type: "summary" }],
    missingValuePolicy: "null",
    maxSessionMs: 60_000,
    includeTechnicalColumns: true,
    storageDataGroup: "capture",
  },
  enabled: true,
  description: null,
  createdBy: null,
  createdAt: "2026-06-07T10:00:00.000Z",
  updatedAt: "2026-06-07T10:00:00.000Z",
};

function columnsFromPayload(payload: string): Record<string, unknown> {
  const parsed = payloadFromJson(payload);
  const columns = parsed.message?.table?.columns ?? {};
  return Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.value]),
  );
}

function columnTypesFromPayload(payload: string): Record<string, string> {
  const parsed = payloadFromJson(payload);
  const columns = parsed.message?.table?.columns ?? {};
  return Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.type]),
  );
}

function columnUomsFromPayload(payload: string): Record<string, string | undefined> {
  const parsed = payloadFromJson(payload);
  const columns = parsed.message?.table?.columns ?? {};
  return Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.uom]),
  );
}

function columnNamesFromPayload(payload: string): string[] {
  const parsed = payloadFromJson(payload);
  return Object.keys(parsed.message?.table?.columns ?? {});
}

function payloadFromJson(payload: string): {
  version?: string;
  message?: {
    table?: {
      dataGroup?: string;
      columns?: Record<string, { type: string; value: unknown; uom?: string }>;
    };
  };
} {
  return JSON.parse(payload) as {
    version?: string;
    message?: {
      table?: {
        dataGroup?: string;
        columns?: Record<string, { type: string; value: unknown; uom?: string }>;
      };
    };
  };
}

test("publisher orders and fills columns from the controller output schema", async () => {
  const publishCalls: Array<{ outputTopic: string; payload: string }> = [];
  const publisher = new CapturePublisher({
    publish: ({ outputTopic, payload }) => {
      publishCalls.push({ outputTopic, payload });
    },
  });
  const outputSchema: CaptureOutputSchema = {
    schemaVersion: 1,
    kind: "capture-table",
    dataGroup: "capture-fast",
    columns: [
      { name: "sessionId", role: "system", valueType: "string", required: true, nullable: false },
      { name: "startedAt", role: "system", valueType: "string", required: true, nullable: false, logicalType: "iso8601" },
      { name: "sampledAt", role: "system", valueType: "string", required: true, nullable: false, logicalType: "iso8601" },
      { name: "endedAt", role: "system", valueType: "string", required: false, nullable: true, logicalType: "iso8601" },
      {
        name: "rowType",
        role: "system",
        valueType: "string",
        required: true,
        nullable: false,
        logicalType: "enum",
        values: ["interval", "change", "summary"],
      },
      { name: "changedTopic", role: "system", valueType: "string", required: false, nullable: true },
      {
        name: "temperature",
        role: "mapped",
        valueType: "dynamic",
        required: false,
        nullable: true,
        sourceType: "data",
        sourceTopic: "factory/line/furnace/temp",
      },
      {
        name: "pressure",
        role: "mapped",
        valueType: "dynamic",
        required: false,
        nullable: true,
        sourceType: "data",
        sourceTopic: "factory/line/furnace/pressure",
      },
    ],
  };

  await publisher.publishRow({ ...BASE_CAPTURE, outputSchema }, {
    sessionId: "session-1",
    startedAt: "2026-06-07T10:00:00.000Z",
    sampledAt: "2026-06-07T10:00:05.000Z",
    rowType: "interval",
    values: { temperature: 1120 },
  });

  assert.equal(publishCalls.length, 1);
  assert.equal(payloadFromJson(publishCalls[0]!.payload).message?.table?.dataGroup, "capture-fast");
  assert.deepEqual(columnNamesFromPayload(publishCalls[0]!.payload), [
    "sessionId",
    "startedAt",
    "sampledAt",
    "endedAt",
    "rowType",
    "changedTopic",
    "temperature",
    "pressure",
  ]);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["endedAt"], null);
  assert.equal(columns["changedTopic"], null);
  assert.equal(columns["temperature"], 1120);
  assert.equal(columns["pressure"], null);
});

test("registry indexes start, stop, input, and on-change driver topics", async () => {
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    captureConfig: {
      ...BASE_CAPTURE.captureConfig,
      modes: [{ type: "onChange", driverTopics: ["factory/line/furnace/driver"] }],
      missingValuePolicy: "null",
      maxSessionMs: 60_000,
    },
  };
  const { registry, service } = makeServices([capture]);
  await service.start();
  assert.equal(registry.size(), 1);
  assert.equal(registry.getCapturesForTopic(capture.startCondition.topic).length, 1);
  assert.equal(registry.getCapturesForTopic(capture.stopCondition.topic).length, 1);
  assert.equal(registry.getCapturesForTopic(capture.inputMappings[0]!.topic).length, 1);
  assert.equal(registry.getCapturesForTopic("factory/line/furnace/driver").length, 1);
  service.stop();
});

test("trigger fire drivers open and close a capture session", async () => {
  let now = 10_000;
  const auditEvents: CaptureSessionAuditEvent[] = [];
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    startCondition: {
      source: "trigger",
      triggerId: "trigger-start-1",
    },
    stopCondition: {
      source: "trigger",
      triggerId: "trigger-stop-1",
    },
  };
  const { registry, service, publishCalls, cache } = makeServices([capture], {
    now: () => now,
    auditEvents,
    cache: {
      "factory/line/furnace/temp": { value: 900 },
    },
  });
  await service.start();
  assert.equal(registry.getCapturesForTrigger("trigger-start-1").length, 1);
  assert.equal(registry.getCapturesForTrigger("trigger-stop-1").length, 1);

  now = 20_000;
  await service.onTriggerFire({
    triggerId: "trigger-start-1",
    triggerName: "Start trigger",
    firedAt: "2026-06-07T10:00:20.000Z",
  });
  assert.equal(service.getRuntimeStates()[0]!.active, true);
  assert.deepEqual(service.getRuntimeStates()[0]!.diagnostics, {
    lastInputTopic: null,
    lastInputValue: null,
    lastInputUom: null,
    lastInputAt: null,
    lastTriggerId: "trigger-start-1",
    lastTriggerName: "Start trigger",
    lastTriggerAt: "2026-06-07T10:00:20.000Z",
    startMatched: true,
    stopMatched: false,
  });
  assert.equal(auditEvents[0]!.eventType, "started");

  cache["factory/line/furnace/temp"] = { value: 1120 };
  now = 30_000;
  await service.onTriggerFire({
    triggerId: "trigger-stop-1",
    triggerName: "Stop trigger",
    firedAt: "2026-06-07T10:00:30.000Z",
  });

  assert.equal(service.getRuntimeStates()[0]!.active, false);
  assert.equal(service.getRuntimeStates()[0]!.diagnostics.lastTriggerId, "trigger-stop-1");
  assert.equal(service.getRuntimeStates()[0]!.diagnostics.startMatched, false);
  assert.equal(service.getRuntimeStates()[0]!.diagnostics.stopMatched, true);
  assert.equal(publishCalls.length, 1);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["rowType"], "summary");
  assert.equal(columns["temperature"], 1120);
  assert.equal(auditEvents[1]!.eventType, "closed");
  assert.equal(auditEvents[1]!.closeReason, "triggerFire");
  service.stop();
});

test("summary mode publishes one table row when the stop condition closes the session", async () => {
  let now = 10_000;
  const { service, publishCalls, cache } = makeServices([BASE_CAPTURE], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900 },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });
  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });
  assert.equal(service.getRuntimeStates()[0]!.active, true);
  assert.equal(service.getRuntimeStates()[0]!.diagnostics.lastInputTopic, "factory/line/furnace/state");
  assert.equal(service.getRuntimeStates()[0]!.diagnostics.lastInputValue, "RUNNING");
  assert.equal(service.getRuntimeStates()[0]!.diagnostics.startMatched, true);
  assert.equal(service.getRuntimeStates()[0]!.diagnostics.stopMatched, false);

  cache["factory/line/furnace/temp"] = { value: 1120 };
  cache["factory/line/furnace/state"] = { value: "COMPLETE" };
  now = 30_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t2" });

  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0]!.outputTopic, BASE_CAPTURE.outputTopic);
  assert.equal(payloadFromJson(publishCalls[0]!.payload).version, "2.0.0");
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  const columnTypes = columnTypesFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["sessionId"], "session-1");
  assert.equal(columns["rowType"], "summary");
  assert.equal(columns["temperature"], 1120);
  assert.equal(columnTypes["sessionId"], "string");
  assert.equal(columnTypes["rowType"], "string");
  assert.equal(columnTypes["temperature"], "double");
  assert.equal(columns["startedAt"], "1970-01-01T00:00:20.000Z");
  assert.equal(columns["endedAt"], "1970-01-01T00:00:30.000Z");
  assert.equal(service.getRuntimeStates()[0]!.active, false);
  service.stop();
});

test("summary mode can aggregate mapped values over the active session", async () => {
  let now = 10_000;
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    inputMappings: [
      {
        topic: "factory/line/furnace/temp",
        columnName: "temperature_avg",
        sourceType: "data",
        required: false,
        summaryAggregation: "avg",
        uomMode: "inherit",
      },
      {
        topic: "factory/line/furnace/pressure",
        columnName: "pressure_samples",
        sourceType: "data",
        required: false,
        summaryAggregation: "count",
        uomMode: "none",
      },
    ],
  };
  const { service, publishCalls, cache } = makeServices([capture], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900, uom: "°C" },
      "factory/line/furnace/pressure": { value: 1, uom: "bar" },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });

  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });

  cache["factory/line/furnace/temp"] = { value: 1000, uom: "°C" };
  now = 21_000;
  await service.onMessage({ topic: "factory/line/furnace/temp", sourceTimestamp: "t2" });
  cache["factory/line/furnace/pressure"] = { value: 2, uom: "bar" };
  now = 22_000;
  await service.onMessage({ topic: "factory/line/furnace/pressure", sourceTimestamp: "t3" });
  cache["factory/line/furnace/temp"] = { value: 1100, uom: "°C" };
  now = 23_000;
  await service.onMessage({ topic: "factory/line/furnace/temp", sourceTimestamp: "t4" });
  cache["factory/line/furnace/pressure"] = { value: 3, uom: "bar" };
  now = 24_000;
  await service.onMessage({ topic: "factory/line/furnace/pressure", sourceTimestamp: "t5" });

  cache["factory/line/furnace/state"] = { value: "COMPLETE" };
  now = 30_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t6" });

  assert.equal(publishCalls.length, 1);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  const uoms = columnUomsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["temperature_avg"], 1000);
  assert.equal(columns["pressure_samples"], 3);
  assert.equal(uoms["temperature_avg"], "°C");
  assert.equal(uoms["pressure_samples"], undefined);
  service.stop();
});

test("mapped column UoM can inherit source, override, or publish none", async () => {
  let now = 10_000;
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    inputMappings: [
      {
        topic: "factory/line/furnace/temp",
        columnName: "temperature",
        sourceType: "data",
        required: false,
        uomMode: "inherit",
      },
      {
        topic: "factory/line/furnace/pressure",
        columnName: "pressure",
        sourceType: "data",
        required: false,
        uomMode: "override",
        uom: "bar",
      },
      {
        topic: "factory/line/furnace/state-text",
        columnName: "state_text",
        sourceType: "data",
        required: false,
        uomMode: "none",
      },
    ],
  };
  const { service, publishCalls, cache } = makeServices([capture], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900, uom: "°C" },
      "factory/line/furnace/pressure": { value: 3.5, uom: "kPa" },
      "factory/line/furnace/state-text": { value: "idle", uom: "text" },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });
  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });

  cache["factory/line/furnace/temp"] = { value: 1120, uom: "°C" };
  cache["factory/line/furnace/pressure"] = { value: 4.2, uom: "kPa" };
  cache["factory/line/furnace/state-text"] = { value: "complete", uom: "text" };
  cache["factory/line/furnace/state"] = { value: "COMPLETE" };
  now = 30_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t2" });

  assert.equal(publishCalls.length, 1);
  const uoms = columnUomsFromPayload(publishCalls[0]!.payload);
  assert.equal(uoms["temperature"], "°C");
  assert.equal(uoms["pressure"], "bar");
  assert.equal(uoms["state_text"], undefined);
  service.stop();
});

test("table source mappings flatten a selected source column", async () => {
  let now = 10_000;
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    inputMappings: [
      {
        topic: "factory/line/furnace/events",
        columnName: "phase",
        sourceType: "table",
        sourceColumn: "phase",
        required: true,
        summaryAggregation: "last",
        uomMode: "inherit",
      },
    ],
  };
  const { service, publishCalls, cache } = makeServices([capture], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/events": {
        value: null,
        values: { phase: "idle", phase_uom: "state" },
      },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });
  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });

  cache["factory/line/furnace/events"] = {
    value: null,
    values: { phase: "soak", phase_uom: "state" },
  };
  now = 21_000;
  await service.onMessage({ topic: "factory/line/furnace/events", sourceTimestamp: "t2" });
  cache["factory/line/furnace/state"] = { value: "COMPLETE" };
  now = 30_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t3" });

  assert.equal(publishCalls.length, 1);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  const uoms = columnUomsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["phase"], "soak");
  assert.equal(uoms["phase"], "state");
  service.stop();
});

test("session audit records start and close evidence", async () => {
  let now = 10_000;
  const auditEvents: CaptureSessionAuditEvent[] = [];
  const { service, cache } = makeServices([BASE_CAPTURE], {
    now: () => now,
    auditEvents,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900 },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });

  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });

  assert.equal(auditEvents.length, 1);
  assert.deepEqual(auditEvents[0]!, {
    eventType: "started",
    captureId: BASE_CAPTURE.id,
    captureName: BASE_CAPTURE.name,
    sessionId: "session-1",
    outputTopic: BASE_CAPTURE.outputTopic,
    startedAt: "1970-01-01T00:00:20.000Z",
    rowCount: 0,
    lastRowAt: null,
    lastSuppressedReason: null,
  });

  cache["factory/line/furnace/temp"] = { value: 1120 };
  cache["factory/line/furnace/state"] = { value: "COMPLETE" };
  now = 30_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t2" });

  assert.equal(auditEvents.length, 2);
  assert.deepEqual(auditEvents[1]!, {
    eventType: "closed",
    captureId: BASE_CAPTURE.id,
    captureName: BASE_CAPTURE.name,
    sessionId: "session-1",
    outputTopic: BASE_CAPTURE.outputTopic,
    startedAt: "1970-01-01T00:00:20.000Z",
    endedAt: "1970-01-01T00:00:30.000Z",
    closeReason: "stopCondition",
    rowCount: 1,
    lastRowAt: "1970-01-01T00:00:30.000Z",
    lastSuppressedReason: null,
  });
  service.stop();
});

test("registry refresh closes active sessions that are no longer enabled", async () => {
  let now = 10_000;
  const captures = [BASE_CAPTURE];
  const auditEvents: CaptureSessionAuditEvent[] = [];
  const { registry, service, publishCalls, cache } = makeServices(captures, {
    now: () => now,
    auditEvents,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900 },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });

  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });
  assert.equal(service.getRuntimeStates()[0]!.active, true);

  cache["factory/line/furnace/temp"] = { value: 1115 };
  captures.length = 0;
  now = 25_000;
  await registry.refresh();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registry.size(), 0);
  assert.equal(publishCalls.length, 1);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["rowType"], "summary");
  assert.equal(columns["temperature"], 1115);
  assert.equal(columns["endedAt"], "1970-01-01T00:00:25.000Z");
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[1]!.eventType, "closed");
  assert.equal(auditEvents[1]!.closeReason, "disabled");
  assert.equal(auditEvents[1]!.rowCount, 1);
  assert.equal(auditEvents[1]!.lastRowAt, "1970-01-01T00:00:25.000Z");
  service.stop();
});

test("interval mode publishes full snapshot rows while the session is active", async () => {
  let now = 10_000;
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    captureConfig: {
      ...BASE_CAPTURE.captureConfig,
      modes: [{ type: "interval", intervalMs: 1000 }],
      missingValuePolicy: "null",
      maxSessionMs: 60_000,
    },
  };
  const { service, publishCalls, cache, timers } = makeServices([capture], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900 },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });
  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });

  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0]!.ms, 1000);
  cache["factory/line/furnace/temp"] = { value: 1110 };
  now = 21_000;
  timers.intervals[0]!.callback();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(publishCalls.length, 1);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["rowType"], "interval");
  assert.equal(columns["temperature"], 1110);
  assert.equal(columns["sampledAt"], "1970-01-01T00:00:21.000Z");
  service.stop();
});

test("onChange mode publishes a full snapshot row when a mapped input changes", async () => {
  let now = 10_000;
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    captureConfig: {
      ...BASE_CAPTURE.captureConfig,
      modes: [{ type: "onChange", driverTopics: [] }],
      missingValuePolicy: "null",
      maxSessionMs: 60_000,
    },
  };
  const { service, publishCalls, cache } = makeServices([capture], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900 },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });
  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });

  cache["factory/line/furnace/temp"] = { value: 1135 };
  now = 22_000;
  await service.onMessage({ topic: "factory/line/furnace/temp", sourceTimestamp: "t2" });

  assert.equal(publishCalls.length, 1);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["rowType"], "change");
  assert.equal(columns["changedTopic"], "factory/line/furnace/temp");
  assert.equal(columns["temperature"], 1135);
  service.stop();
});

test("timeout closes an active session and publishes a summary row", async () => {
  let now = 10_000;
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    captureConfig: {
      ...BASE_CAPTURE.captureConfig,
      modes: [{ type: "summary" }],
      missingValuePolicy: "null",
      maxSessionMs: 5_000,
    },
  };
  const { service, publishCalls, cache, timers } = makeServices([capture], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
      "factory/line/furnace/temp": { value: 900 },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });
  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });

  assert.equal(service.getRuntimeStates()[0]!.active, true);
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.timeouts[0]!.ms, 5_000);

  cache["factory/line/furnace/temp"] = { value: 1140 };
  now = 25_000;
  timers.timeouts[0]!.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(publishCalls.length, 1);
  const columns = columnsFromPayload(publishCalls[0]!.payload);
  assert.equal(columns["rowType"], "summary");
  assert.equal(columns["temperature"], 1140);
  assert.equal(columns["endedAt"], "1970-01-01T00:00:25.000Z");
  const [state] = service.getRuntimeStates();
  assert.equal(state!.active, false);
  assert.equal(state!.metrics.lastCloseReason, "timeout");
  assert.equal(state!.metrics.lastEndedAt, "1970-01-01T00:00:25.000Z");
  service.stop();
});

test("skipRow suppresses rows when a required mapped value is missing", async () => {
  let now = 10_000;
  const capture: CaptureDefinition = {
    ...BASE_CAPTURE,
    inputMappings: [{ ...BASE_CAPTURE.inputMappings[0]!, required: true }],
    captureConfig: {
      ...BASE_CAPTURE.captureConfig,
      modes: [{ type: "onChange", driverTopics: [] }],
      missingValuePolicy: "skipRow",
      maxSessionMs: 60_000,
    },
  };
  const { service, publishCalls, cache } = makeServices([capture], {
    now: () => now,
    cache: {
      "factory/line/furnace/state": { value: "IDLE" },
    },
  });
  await service.start();
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t0" });
  cache["factory/line/furnace/state"] = { value: "RUNNING" };
  now = 20_000;
  await service.onMessage({ topic: "factory/line/furnace/state", sourceTimestamp: "t1" });
  now = 22_000;
  await service.onMessage({ topic: "factory/line/furnace/temp", sourceTimestamp: "t2" });

  assert.equal(publishCalls.length, 0);
  assert.equal(service.getRuntimeStates()[0]!.metrics.lastSuppressedReason, "required_value_missing");
  service.stop();
});
