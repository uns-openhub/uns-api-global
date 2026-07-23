// src/captures/types.ts
//
// Shared capture-runtime types.  These mirror the controller's
// GET /api/captures response shape and the GraphQL CaptureDefinition
// contract in uns-datahub-controller.

export type CaptureConditionOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export type CaptureTopicCondition = {
  source?: "topic";
  topic: string;
  operator: CaptureConditionOperator;
  value: string | number | boolean;
};

export type CaptureTriggerCondition = {
  source: "trigger";
  triggerId: string;
};

export type CaptureAlwaysCondition = {
  source: "always";
};

export type CaptureNeverCondition = {
  source: "never";
};

export type CaptureCondition =
  | CaptureTopicCondition
  | CaptureTriggerCondition
  | CaptureAlwaysCondition
  | CaptureNeverCondition;

export type CaptureUomMode = "inherit" | "override" | "none";
export type CaptureSummaryAggregation = "first" | "last" | "min" | "max" | "avg" | "count";

export type CaptureInputMapping = {
  topic: string;
  columnName: string;
  displayLabel?: string | null;
  sourceType: "data" | "table";
  sourceColumn?: string | null;
  required: boolean;
  summaryAggregation?: CaptureSummaryAggregation;
  uomMode: CaptureUomMode;
  uom?: string | null;
};

export type CaptureMode =
  | { type: "summary" }
  | { type: "interval"; intervalMs: number }
  | { type: "onChange"; driverTopics: string[] }
  | { type: "singleShot" };

export type CaptureWindowMode = "condition" | "alwaysOn";

export type CaptureConfig = {
  windowMode: CaptureWindowMode;
  modes: CaptureMode[];
  missingValuePolicy: "null" | "skipRow";
  maxSessionMs: number | null;
  includeTechnicalColumns: boolean;
  storageDataGroup: string;
};

export type CaptureOutputColumnSchema = {
  name: string;
  displayLabel?: string;
  role: "system" | "mapped";
  valueType: "string" | "dynamic";
  required: boolean;
  nullable: boolean;
  logicalType?: "iso8601" | "enum";
  values?: string[];
  sourceTopic?: string;
  sourceType?: "data" | "table";
  sourceColumn?: string;
  summaryAggregation?: CaptureSummaryAggregation;
  uomMode?: CaptureUomMode;
  uom?: string | null;
};

export type CaptureOutputSchema = {
  schemaVersion: 1;
  kind: "capture-table";
  dataGroup: string;
  columns: CaptureOutputColumnSchema[];
};

export type CaptureDefinition = {
  id: string;
  name: string;
  startCondition: CaptureCondition;
  stopCondition: CaptureCondition;
  inputMappings: CaptureInputMapping[];
  outputTopic: string;
  outputSchema: CaptureOutputSchema | null;
  captureConfig: CaptureConfig;
  enabled: boolean;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CaptureLastValueSnapshot = {
  value: unknown;
  values?: Record<string, unknown> | undefined;
  uom: string | null;
  time: string;
  receivedAt: number;
};

export type CaptureLastValueAccessor = (topic: string) => CaptureLastValueSnapshot | null;

export type CaptureRowType = "interval" | "change" | "summary";

export type CaptureRow = {
  sessionId: string;
  startedAt: string;
  sampledAt: string;
  endedAt?: string;
  rowType: CaptureRowType;
  changedTopic?: string;
  values: Record<string, unknown>;
  uoms?: Record<string, string | null>;
};
