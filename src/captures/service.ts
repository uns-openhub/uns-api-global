// src/captures/service.ts
//
// Stateful runtime for capture definitions.  A capture session opens on a
// start-condition rising edge, closes on a stop-condition rising edge or
// timeout, and emits table rows according to the configured modes.

import { randomUUID } from "node:crypto";
import { logger } from "@uns-kit/core";
import type { CaptureRegistry } from "./registry.js";
import type { CapturePublisher } from "./publisher.js";
import type {
  CaptureCondition,
  CaptureDefinition,
  CaptureInputMapping,
  CaptureLastValueSnapshot,
  CaptureLastValueAccessor,
  CaptureMode,
  CaptureRow,
  CaptureRowType,
} from "./types.js";

type TimerHandle = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

export type CaptureTimerApi = {
  setInterval: (callback: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type CaptureServiceDeps = {
  registry: CaptureRegistry;
  publisher: CapturePublisher;
  getLastValue: CaptureLastValueAccessor;
  auditSession?: (event: CaptureSessionAuditEvent) => Promise<void> | void;
  now?: () => number;
  createSessionId?: () => string;
  timers?: CaptureTimerApi;
};

export type CaptureSessionAuditEvent = {
  eventType: "started" | "closed";
  captureId: string;
  captureName: string;
  sessionId: string;
  outputTopic: string;
  startedAt: string;
  endedAt?: string | null;
  closeReason?: string | null;
  rowCount?: number;
  lastRowAt?: string | null;
  lastSuppressedReason?: string | null;
};

export type CaptureIncomingMessageContext = {
  topic: string;
  sourceTimestamp: string;
};

export type CaptureTriggerFireContext = {
  triggerId: string;
  triggerName?: string | null;
  firedAt?: string | null;
};

type CaptureConditionState = {
  start: boolean | null;
  stop: boolean | null;
};

type ActiveCaptureSession = {
  sessionId: string;
  capture: CaptureDefinition;
  startedAt: string;
  startedAtMs: number;
  intervalTimers: TimerHandle[];
  timeoutTimer: TimerHandle | null;
  rowCount: number;
  lastRowAt: string | null;
  aggregates: Map<string, ColumnAggregateState>;
};

type MappedCaptureValues = {
  values: Record<string, unknown>;
  uoms: Record<string, string | null>;
};

type ColumnAggregateState = {
  hasFirst: boolean;
  first: unknown;
  last: unknown;
  count: number;
  numericCount: number;
  sum: number;
  min: number | null;
  max: number | null;
  uom: string | null;
};

export type CaptureRuntimeMetrics = {
  rowCount: number;
  sessionCount: number;
  lastRowAt: string | null;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  lastCloseReason: string | null;
  lastSuppressedReason: string | null;
  lastEvaluatedAt: number | null;
};

export type CaptureRuntimeDiagnostics = {
  lastInputTopic: string | null;
  lastInputValue: string | null;
  lastInputUom: string | null;
  lastInputAt: string | null;
  lastTriggerId: string | null;
  lastTriggerName: string | null;
  lastTriggerAt: string | null;
  startMatched: boolean | null;
  stopMatched: boolean | null;
};

export type CaptureRuntimeView = {
  captureId: string;
  active: boolean;
  sessionId: string | null;
  startedAt: string | null;
  rowCount: number;
  metrics: CaptureRuntimeMetrics;
  diagnostics: CaptureRuntimeDiagnostics;
};

export class CaptureService {
  private readonly registry: CaptureRegistry;
  private readonly publisher: CapturePublisher;
  private readonly getLastValue: CaptureLastValueAccessor;
  private readonly auditSession: (event: CaptureSessionAuditEvent) => Promise<void> | void;
  private readonly now: () => number;
  private readonly createSessionId: () => string;
  private readonly timers: CaptureTimerApi;
  private readonly conditionState: Map<string, CaptureConditionState> = new Map();
  private readonly activeSessions: Map<string, ActiveCaptureSession> = new Map();
  private readonly metrics: Map<string, CaptureRuntimeMetrics> = new Map();
  private readonly diagnostics: Map<string, CaptureRuntimeDiagnostics> = new Map();
  private unsubscribeRegistryRefresh: (() => void) | null = null;

  constructor(deps: CaptureServiceDeps) {
    this.registry = deps.registry;
    this.publisher = deps.publisher;
    this.getLastValue = deps.getLastValue;
    this.auditSession = deps.auditSession ?? (() => undefined);
    this.now = deps.now ?? (() => Date.now());
    this.createSessionId = deps.createSessionId ?? (() => randomUUID());
    this.timers = deps.timers ?? {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  async start(): Promise<void> {
    if (!this.unsubscribeRegistryRefresh) {
      this.unsubscribeRegistryRefresh = this.registry.onRefresh((event) => {
        void this.handleRegistryRefresh(event.current);
      });
    }
    await this.registry.start();
    await this.openAlwaysOnSessions(
      new Map(this.registry.list().map((capture) => [capture.id, capture])),
    );
  }

  stop(): void {
    const stoppedAt = new Date(this.now()).toISOString();
    for (const session of this.activeSessions.values()) {
      this.clearSessionTimers(session);
      const capture = session.capture;
      if (capture) {
        const metrics = this.metrics.get(capture.id) ?? freshMetrics();
        metrics.lastEndedAt = stoppedAt;
        metrics.lastCloseReason = "runtimeRestart";
        this.metrics.set(capture.id, metrics);
        this.emitSessionAudit({
          eventType: "closed",
          captureId: capture.id,
          captureName: capture.name,
          sessionId: session.sessionId,
          outputTopic: capture.outputTopic,
          startedAt: session.startedAt,
          endedAt: stoppedAt,
          closeReason: "runtimeRestart",
          rowCount: session.rowCount,
          lastRowAt: session.lastRowAt,
          lastSuppressedReason: metrics.lastSuppressedReason,
        });
      }
    }
    this.activeSessions.clear();
    if (this.unsubscribeRegistryRefresh) {
      this.unsubscribeRegistryRefresh();
      this.unsubscribeRegistryRefresh = null;
    }
    this.registry.stop();
  }

  async onMessage(ctx: CaptureIncomingMessageContext): Promise<void> {
    const captures = this.registry.getCapturesForTopic(ctx.topic);
    if (captures.length === 0) return;
    const now = this.now();
    for (const capture of captures) {
      await this.evaluateOne(capture, ctx, now);
    }
  }

  async onTriggerFire(ctx: CaptureTriggerFireContext): Promise<void> {
    const triggerId = ctx.triggerId.trim();
    if (!triggerId) return;
    const captures = this.registry.getCapturesForTrigger(triggerId);
    if (captures.length === 0) return;
    const now = this.now();
    for (const capture of captures) {
      await this.evaluateTriggerFire(capture, ctx, triggerId, now);
    }
  }

  getRuntimeStates(): CaptureRuntimeView[] {
    const out: CaptureRuntimeView[] = [];
    for (const capture of this.registry.list()) {
      const active = this.activeSessions.get(capture.id) ?? null;
      out.push({
        captureId: capture.id,
        active: !!active,
        sessionId: active?.sessionId ?? null,
        startedAt: active?.startedAt ?? null,
        rowCount: active?.rowCount ?? 0,
        metrics: this.metrics.get(capture.id) ?? freshMetrics(),
        diagnostics: this.diagnostics.get(capture.id) ?? freshDiagnostics(),
      });
    }
    return out;
  }

  private async evaluateOne(
    capture: CaptureDefinition,
    ctx: CaptureIncomingMessageContext,
    now: number,
  ): Promise<void> {
    const startResult = evaluateCondition(capture.startCondition, this.getLastValue);
    const stopResult = evaluateCondition(capture.stopCondition, this.getLastValue);
    const prev = this.conditionState.get(capture.id) ?? { start: null, stop: null };
    this.conditionState.set(capture.id, { start: startResult, stop: stopResult });

    const metrics = this.metrics.get(capture.id) ?? freshMetrics();
    metrics.lastEvaluatedAt = now;
    this.metrics.set(capture.id, metrics);
    this.diagnostics.set(capture.id, {
      ...(this.diagnostics.get(capture.id) ?? freshDiagnostics()),
      lastInputTopic: ctx.topic,
      ...inputDiagnostics(this.getLastValue(ctx.topic)),
      startMatched: startResult,
      stopMatched: stopResult,
    });

    const active = this.activeSessions.get(capture.id) ?? null;
    if (active) {
      this.recordSamplesForTopic(capture, active, ctx.topic);
    }
    const stopRise = prev.stop === false && stopResult === true;
    if (active && stopRise) {
      await this.closeSession(capture, active, "stopCondition");
      return;
    }

    if (capture.captureConfig.windowMode === "alwaysOn" && !active && !stopResult) {
      await this.openSession(capture, now);
      return;
    }

    const startRise = prev.start === false && startResult === true;
    if (!active && startRise) {
      await this.openSession(capture, now);
      return;
    }

    const current = this.activeSessions.get(capture.id) ?? null;
    if (!current) return;
    if (!this.shouldEmitChangeRow(capture, ctx.topic)) return;
    await this.publishRow(capture, current, "change", ctx.topic);
  }

  private async evaluateTriggerFire(
    capture: CaptureDefinition,
    ctx: CaptureTriggerFireContext,
    triggerId: string,
    now: number,
  ): Promise<void> {
    const metrics = this.metrics.get(capture.id) ?? freshMetrics();
    metrics.lastEvaluatedAt = now;
    this.metrics.set(capture.id, metrics);
    this.diagnostics.set(capture.id, {
      ...(this.diagnostics.get(capture.id) ?? freshDiagnostics()),
      lastTriggerId: triggerId,
      lastTriggerName: ctx.triggerName?.trim() || null,
      lastTriggerAt: ctx.firedAt?.trim() || new Date(now).toISOString(),
      startMatched: isTriggerCondition(capture.startCondition, triggerId),
      stopMatched: isTriggerCondition(capture.stopCondition, triggerId),
    });

    const active = this.activeSessions.get(capture.id) ?? null;
    if (active && isTriggerCondition(capture.stopCondition, triggerId)) {
      await this.closeSession(capture, active, "triggerFire");
      return;
    }
    if (!active && isTriggerCondition(capture.startCondition, triggerId)) {
      await this.openSession(capture, now);
    }
  }

  private async openSession(capture: CaptureDefinition, now: number): Promise<void> {
    if (this.activeSessions.has(capture.id)) return;
    const startedAt = new Date(now).toISOString();
    const session: ActiveCaptureSession = {
      sessionId: this.createSessionId(),
      capture,
      startedAt,
      startedAtMs: now,
      intervalTimers: [],
      timeoutTimer: null,
      rowCount: 0,
      lastRowAt: null,
      aggregates: new Map(),
    };
    this.activeSessions.set(capture.id, session);
    this.recordAllMappedSamples(capture, session);
    const metrics = this.metrics.get(capture.id) ?? freshMetrics();
    metrics.sessionCount++;
    metrics.lastStartedAt = startedAt;
    metrics.lastSuppressedReason = null;
    this.metrics.set(capture.id, metrics);
    this.emitSessionAudit({
      eventType: "started",
      captureId: capture.id,
      captureName: capture.name,
      sessionId: session.sessionId,
      outputTopic: capture.outputTopic,
      startedAt,
      rowCount: 0,
      lastRowAt: null,
      lastSuppressedReason: null,
    });

    if (hasMode(capture, "singleShot")) {
      await this.closeSession(capture, session, "singleShot", { publishSummary: true });
      return;
    }

    for (const mode of capture.captureConfig.modes) {
      if (mode.type !== "interval") continue;
      const timer = this.timers.setInterval(() => {
        const active = this.activeSessions.get(capture.id);
        if (!active) return;
        this.publishRow(capture, active, "interval").catch((err) => {
          this.recordSuppression(capture.id, `publish_error:${stringifyError(err)}`);
        });
      }, mode.intervalMs);
      unrefTimer(timer);
      session.intervalTimers.push(timer);
    }

    if (capture.captureConfig.maxSessionMs !== null) {
      const timeoutTimer = this.timers.setTimeout(() => {
        const active = this.activeSessions.get(capture.id);
        if (!active) return;
        this.closeSession(capture, active, "timeout").catch((err) => {
          this.recordSuppression(capture.id, `timeout_close_error:${stringifyError(err)}`);
        });
      }, capture.captureConfig.maxSessionMs);
      unrefTimer(timeoutTimer);
      session.timeoutTimer = timeoutTimer;
    }
  }

  private async closeSession(
    capture: CaptureDefinition,
    session: ActiveCaptureSession,
    reason: string,
    options: { publishSummary?: boolean } = {},
  ): Promise<void> {
    const endedAt = new Date(this.now()).toISOString();
    this.clearSessionTimers(session);
    if (options.publishSummary === true || hasMode(capture, "summary")) {
      await this.publishRow(capture, session, "summary", undefined, endedAt);
    }
    this.activeSessions.delete(capture.id);
    const metrics = this.metrics.get(capture.id) ?? freshMetrics();
    metrics.lastEndedAt = endedAt;
    metrics.lastCloseReason = reason;
    this.metrics.set(capture.id, metrics);
    this.emitSessionAudit({
      eventType: "closed",
      captureId: capture.id,
      captureName: capture.name,
      sessionId: session.sessionId,
      outputTopic: capture.outputTopic,
      startedAt: session.startedAt,
      endedAt,
      closeReason: reason,
      rowCount: session.rowCount,
      lastRowAt: session.lastRowAt,
      lastSuppressedReason: metrics.lastSuppressedReason,
    });
  }

  private clearSessionTimers(session: ActiveCaptureSession): void {
    for (const timer of session.intervalTimers) {
      this.timers.clearInterval(timer);
    }
    session.intervalTimers = [];
    if (session.timeoutTimer) {
      this.timers.clearTimeout(session.timeoutTimer);
      session.timeoutTimer = null;
    }
  }

  private shouldEmitChangeRow(capture: CaptureDefinition, topic: string): boolean {
    const modes = capture.captureConfig.modes.filter((mode): mode is Extract<CaptureMode, { type: "onChange" }> => {
      return mode.type === "onChange";
    });
    if (modes.length === 0) return false;
    for (const mode of modes) {
      if (mode.driverTopics.length > 0) {
        if (mode.driverTopics.includes(topic)) return true;
        continue;
      }
      if (capture.inputMappings.some((mapping) => mapping.topic === topic)) return true;
    }
    return false;
  }

  private async publishRow(
    capture: CaptureDefinition,
    session: ActiveCaptureSession,
    rowType: CaptureRowType,
    changedTopic?: string,
    endedAt?: string,
  ): Promise<void> {
    const sampledAt = endedAt ?? new Date(this.now()).toISOString();
    const mapped = rowType === "summary"
      ? this.collectSummaryValues(capture, session)
      : this.collectMappedValues(capture);
    if (!mapped) {
      this.recordSuppression(capture.id, "required_value_missing");
      return;
    }
    const row: CaptureRow = {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      sampledAt,
      rowType,
      values: mapped.values,
      uoms: mapped.uoms,
      ...(changedTopic ? { changedTopic } : {}),
      ...(endedAt ? { endedAt } : {}),
    };
    await this.publisher.publishRow(capture, row);
    session.rowCount++;
    session.lastRowAt = sampledAt;
    const metrics = this.metrics.get(capture.id) ?? freshMetrics();
    metrics.rowCount++;
    metrics.lastRowAt = sampledAt;
    metrics.lastSuppressedReason = null;
    this.metrics.set(capture.id, metrics);
  }

  private collectMappedValues(capture: CaptureDefinition): MappedCaptureValues | null {
    const values: Record<string, unknown> = {};
    const uoms: Record<string, string | null> = {};
    for (const mapping of capture.inputMappings) {
      const snap = this.getLastValue(mapping.topic);
      const value = extractMappingValue(mapping, snap);
      if ((value === null || value === undefined) && mapping.required && capture.captureConfig.missingValuePolicy === "skipRow") {
        return null;
      }
      values[mapping.columnName] = value ?? null;
      uoms[mapping.columnName] = resolveMappingUom(mapping, snap);
    }
    return { values, uoms };
  }

  private collectSummaryValues(
    capture: CaptureDefinition,
    session: ActiveCaptureSession,
  ): MappedCaptureValues | null {
    const values: Record<string, unknown> = {};
    const uoms: Record<string, string | null> = {};
    for (const mapping of capture.inputMappings) {
      const snap = this.getLastValue(mapping.topic);
      const state = session.aggregates.get(mapping.columnName) ?? null;
      const value = resolveAggregatedValue(mapping, state, snap);
      if ((value === null || value === undefined) && mapping.required && capture.captureConfig.missingValuePolicy === "skipRow") {
        return null;
      }
      values[mapping.columnName] = value ?? null;
      uoms[mapping.columnName] = (mapping.summaryAggregation ?? "last") === "last"
        ? resolveMappingUom(mapping, snap)
        : state?.uom ?? resolveMappingUom(mapping, snap);
    }
    return { values, uoms };
  }

  private recordAllMappedSamples(capture: CaptureDefinition, session: ActiveCaptureSession): void {
    for (const mapping of capture.inputMappings) {
      this.recordMappingSample(mapping, session);
    }
  }

  private recordSamplesForTopic(
    capture: CaptureDefinition,
    session: ActiveCaptureSession,
    topic: string,
  ): void {
    for (const mapping of capture.inputMappings) {
      if (mapping.topic !== topic) continue;
      this.recordMappingSample(mapping, session);
    }
  }

  private recordMappingSample(mapping: CaptureInputMapping, session: ActiveCaptureSession): void {
    const snap = this.getLastValue(mapping.topic);
    const value = extractMappingValue(mapping, snap);
    if (value === null || value === undefined) return;
    const state = session.aggregates.get(mapping.columnName) ?? freshAggregateState();
    state.count++;
    if (!state.hasFirst) {
      state.hasFirst = true;
      state.first = value;
    }
    state.last = value;
    const numeric = coerceNumber(value);
    if (numeric !== null) {
      state.numericCount++;
      state.sum += numeric;
      state.min = state.min === null ? numeric : Math.min(state.min, numeric);
      state.max = state.max === null ? numeric : Math.max(state.max, numeric);
    }
    state.uom = resolveMappingUom(mapping, snap) ?? state.uom;
    session.aggregates.set(mapping.columnName, state);
  }

  private async closeSessionsMissingFromRegistry(
    currentDefinitions: ReadonlyMap<string, CaptureDefinition>,
  ): Promise<void> {
    for (const [captureId, session] of Array.from(this.activeSessions.entries())) {
      if (currentDefinitions.has(captureId)) continue;
      await this.closeSession(session.capture, session, "disabled");
    }
  }

  private async handleRegistryRefresh(
    currentDefinitions: ReadonlyMap<string, CaptureDefinition>,
  ): Promise<void> {
    await this.closeSessionsMissingFromRegistry(currentDefinitions);
    await this.openAlwaysOnSessions(currentDefinitions);
  }

  private async openAlwaysOnSessions(
    currentDefinitions: ReadonlyMap<string, CaptureDefinition>,
  ): Promise<void> {
    const now = this.now();
    for (const capture of currentDefinitions.values()) {
      if (!capture.enabled || capture.captureConfig.windowMode !== "alwaysOn") continue;
      if (this.activeSessions.has(capture.id)) continue;
      if (evaluateCondition(capture.stopCondition, this.getLastValue)) continue;
      await this.openSession(capture, now);
    }
  }

  private recordSuppression(captureId: string, reason: string): void {
    const metrics = this.metrics.get(captureId) ?? freshMetrics();
    metrics.lastSuppressedReason = reason;
    this.metrics.set(captureId, metrics);
    logger.warn(`[captures] ${captureId}: ${reason}`);
  }

  private emitSessionAudit(event: CaptureSessionAuditEvent): void {
    Promise.resolve(this.auditSession(event)).catch((err) => {
      logger.warn(`[captures] session audit failed: ${stringifyError(err)}`);
    });
  }
}

function resolveMappingUom(
  mapping: CaptureInputMapping,
  snap: CaptureLastValueSnapshot | null,
): string | null {
  if (mapping.uomMode === "none") return null;
  if (mapping.uomMode === "override") {
    const override = mapping.uom?.trim();
    return override || null;
  }
  if (mapping.sourceType === "table" && mapping.sourceColumn) {
    const columnUom = snap?.values?.[`${mapping.sourceColumn}_uom`];
    if (typeof columnUom === "string" && columnUom.trim().length > 0) {
      return columnUom.trim();
    }
  }
  return snap?.uom ?? null;
}

function extractMappingValue(
  mapping: CaptureInputMapping,
  snap: CaptureLastValueSnapshot | null,
): unknown {
  if (!snap) return null;
  if (mapping.sourceType === "table") {
    const sourceColumn = mapping.sourceColumn?.trim();
    if (!sourceColumn) return null;
    return snap.values?.[sourceColumn] ?? null;
  }
  return snap.value;
}

function resolveAggregatedValue(
  mapping: CaptureInputMapping,
  state: ColumnAggregateState | null,
  fallbackSnap: CaptureLastValueSnapshot | null,
): unknown {
  const aggregation = mapping.summaryAggregation ?? "last";
  if (!state || !state.hasFirst) {
    if (aggregation === "count") return 0;
    return extractMappingValue(mapping, fallbackSnap);
  }
  switch (aggregation) {
    case "first":
      return state.first;
    case "last":
      return extractMappingValue(mapping, fallbackSnap) ?? state.last;
    case "min":
      return state.min;
    case "max":
      return state.max;
    case "avg":
      return state.numericCount > 0 ? state.sum / state.numericCount : null;
    case "count":
      return state.count;
  }
}

function freshAggregateState(): ColumnAggregateState {
  return {
    hasFirst: false,
    first: null,
    last: null,
    count: 0,
    numericCount: 0,
    sum: 0,
    min: null,
    max: null,
    uom: null,
  };
}

function hasMode(capture: CaptureDefinition, type: CaptureMode["type"]): boolean {
  return capture.captureConfig.modes.some((mode) => mode.type === type);
}

function evaluateCondition(
  condition: CaptureCondition,
  getLastValue: CaptureLastValueAccessor,
): boolean {
  if (condition.source === "always") return true;
  if (condition.source === "never") return false;
  if (condition.source === "trigger") return false;
  const snap = getLastValue(condition.topic);
  if (!snap) return false;
  const actual = snap.value;
  switch (condition.operator) {
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = coerceNumber(actual);
      const right = coerceNumber(condition.value);
      if (left === null || right === null) return false;
      if (condition.operator === "gt") return left > right;
      if (condition.operator === "gte") return left >= right;
      if (condition.operator === "lt") return left < right;
      return left <= right;
    }
    case "eq":
    case "neq": {
      const equal = valuesEqual(actual, condition.value);
      return condition.operator === "eq" ? equal : !equal;
    }
    default: {
      const _exhaustive: never = condition.operator;
      return false;
    }
  }
}

function isTriggerCondition(condition: CaptureCondition, triggerId: string): boolean {
  return condition.source === "trigger" && condition.triggerId === triggerId;
}

function valuesEqual(actual: unknown, expected: string | number | boolean): boolean {
  if (typeof expected === "number") {
    const actualNumber = coerceNumber(actual);
    return actualNumber !== null && actualNumber === expected;
  }
  if (typeof expected === "boolean") {
    if (typeof actual === "boolean") return actual === expected;
    if (typeof actual === "string") {
      const normalized = actual.trim().toLowerCase();
      if (normalized === "true") return expected === true;
      if (normalized === "false") return expected === false;
    }
    return false;
  }
  return coerceString(actual) === expected;
}

function coerceNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceString(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  return null;
}

function freshMetrics(): CaptureRuntimeMetrics {
  return {
    rowCount: 0,
    sessionCount: 0,
    lastRowAt: null,
    lastStartedAt: null,
    lastEndedAt: null,
    lastCloseReason: null,
    lastSuppressedReason: null,
    lastEvaluatedAt: null,
  };
}

function freshDiagnostics(): CaptureRuntimeDiagnostics {
  return {
    lastInputTopic: null,
    lastInputValue: null,
    lastInputUom: null,
    lastInputAt: null,
    lastTriggerId: null,
    lastTriggerName: null,
    lastTriggerAt: null,
    startMatched: null,
    stopMatched: null,
  };
}

function inputDiagnostics(snap: CaptureLastValueSnapshot | null): Pick<
  CaptureRuntimeDiagnostics,
  "lastInputValue" | "lastInputUom" | "lastInputAt"
> {
  return {
    lastInputValue: snap ? shortValue(snap.value) : null,
    lastInputUom: snap?.uom ?? null,
    lastInputAt: snap?.time ?? null,
  };
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  } catch {
    return String(value);
  }
}

function unrefTimer(timer: TimerHandle): void {
  const maybeTimer = timer as { unref?: () => void };
  if (typeof maybeTimer.unref === "function") maybeTimer.unref();
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const __testing__ = {
  evaluateCondition,
};
