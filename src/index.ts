import {
  AuthClient,
  UnsProxyProcess,
  ConfigFile,
  logger,
  mqttChannelParameters,
  resolveMqttChannel,
  ServiceTokenProvider,
  type AccessTokenProvider,
  type IApiProxyOptions,
  type MqttChannelConfig,
} from "@uns-kit/core";
import type { UnsEvents } from "@uns-kit/core";
import UnsMqttProxy from "@uns-kit/core/uns-mqtt/uns-mqtt-proxy.js";
import { UnsPacket } from "@uns-kit/core/uns/uns-packet.js";
import { tableColumnsToLastValues } from "./table-packet.js";
import "@uns-kit/api";
import { type UnsProxyProcessWithApi } from "@uns-kit/api";
import { projectExtrasSchema, type ProjectExtras, type DataSourceConfig } from "./config/project.config.extension.js";
import { isHistoryAllowed, isCacheAllowed, resolveTablePrefix, getCacheTopicFilters, matchesTopic } from "./topic-matcher.js";
import { TriggerRegistry } from "./triggers/registry.js";
import { TriggerPublisher } from "./triggers/publisher.js";
import { TriggerService } from "./triggers/service.js";
import { CaptureRegistry } from "./captures/registry.js";
import { CapturePublisher } from "./captures/publisher.js";
import { CaptureService, type CaptureSessionAuditEvent } from "./captures/service.js";
import jwt from "jsonwebtoken";
import type { Algorithm } from "jsonwebtoken";
import { createPublicKey, randomUUID } from "node:crypto";
import { request, gql } from "graphql-request";
import {
  buildBoundaryCounterDeltaResponse,
  computeCounterDeltaValue,
  counterBoundarySourceRange,
  isTopicAllowedByAccessRules,
  resolvePointTimeColumn as resolvePointTimeColumnFromSchema,
} from "./catchall-helpers.js";

type TimeRange = { from?: string; to?: string; note?: string };
type TimeFieldPreference = "auto" | "timestamp" | "interval";
type QuestDbConfig = ProjectExtras["questdb"];
type CatchAllConfig = ProjectExtras["catchAll"];
type AggregateMode = "avg" | "min" | "max" | "last" | "sum" | "count";
type HistoryTransformMode = "raw" | "delta";
type CounterResetPolicy = "new-value" | "null";
type TableSchema = {
  columns: Set<string>;
  orderedColumns: string[];
  columnTypes: Map<string, string>;
};
type HistorySamplingInfo =
  | { mode: "summary" }
  | {
      mode: "raw";
      transform: HistoryTransformMode;
      counterResetPolicy?: CounterResetPolicy;
      metricColumn?: string;
      unitColumn?: string | null;
    }
  | {
      mode: "bucketed";
      requestedMaxPoints: number | null;
      bucketMs: number;
      aggregate: AggregateMode;
      transform: HistoryTransformMode;
      counterResetPolicy?: CounterResetPolicy;
      metricColumn: string;
      unitColumn: string | null;
      boundaryMode?: "interpolated";
    };
type QuestDbDependencyHealth = {
  id: "questdb";
  label: "QuestDB";
  state: "healthy" | "degraded";
  healthy: boolean;
  checkedAt: string;
  message?: string;
};
type JwtClaims = jwt.JwtPayload & {
  accessRules?: unknown;
  pathFilter?: unknown;
  scope?: unknown;
  scopes?: unknown;
  permissions?: unknown;
};
type CatchAllAuthConfig = {
  jwksWellKnownUrl?: string | undefined;
  activeKidUrl?: string | undefined;
  algorithms?: Algorithm[] | undefined;
  jwtSecret?: string | undefined;
};
type JwkKey = { kid?: string; kty?: string; n?: string; e?: string; x5c?: string[] };
const QUESTDB_HEALTHCHECK_INTERVAL = 30000;
const DEFAULT_BUCKET_AGGREGATE: AggregateMode = "last";
const DEFAULT_HISTORY_TRANSFORM: HistoryTransformMode = "raw";
const DEFAULT_COUNTER_RESET_POLICY: CounterResetPolicy = "new-value";
const NUMERIC_QUESTDB_TYPES = new Set(["BYTE", "SHORT", "INT", "LONG", "FLOAT", "DOUBLE"]);
const NON_VALUE_COLUMNS = new Set([
  "topic",
  "asset",
  "objectType",
  "objectId",
  "attribute",
  "valueType",
  "uom",
  "unit",
  "time",
  "timestamp",
  "intervalStart",
  "intervalEnd",
  "interval",
]);

const config = await ConfigFile.loadConfig();
const { questdb, catchAll, lastValueCache: lastValueCacheConfig, dataSources } = parseProjectExtras(config);
const apiBasePath = normalizeBasePath(catchAll.apiBasePath ?? "/api/catchall");
const catchAllSwaggerPath = catchAll.swaggerPath ?? "/uns-api-global/general-api/catchall-swagger.json";
const controllerGraphqlUrl = typeof config.uns?.graphql === "string" ? config.uns.graphql.replace(/\/+$/, "") : null;
const controllerRestUrl = typeof config.uns?.rest === "string" ? config.uns.rest.replace(/\/+$/, "") : null;
let legacyAuthClient: Promise<AuthClient | null> | undefined;
const legacyAuthFallback: AccessTokenProvider = {
  async getAccessToken(): Promise<string | undefined> {
    legacyAuthClient ??= AuthClient.create().catch(() => null);
    const client = await legacyAuthClient;
    return client?.getAccessToken();
  },
};
const configuredServiceToken = typeof config.uns?.token === "string" ? config.uns.token : undefined;
const controllerTokenProvider = new ServiceTokenProvider({
  ...(configuredServiceToken ? { configToken: configuredServiceToken } : {}),
  fallback: legacyAuthFallback,
});
const infraChannel = resolveMqttChannel(config.infra as MqttChannelConfig);
const inputChannel = resolveMqttChannel(config.infra as MqttChannelConfig, config.input as MqttChannelConfig | undefined);
const outputChannel = resolveMqttChannel(config.infra as MqttChannelConfig, config.output as MqttChannelConfig | undefined);
const envJwtSecret = process.env["UNS_API_JWT_SECRET"]?.trim();

if (!config.uns?.jwksWellKnownUrl && !envJwtSecret) {
  throw new Error(
    "Missing API auth configuration. Set uns.jwksWellKnownUrl (recommended) or UNS_API_JWT_SECRET.",
  );
}
if (envJwtSecret === "CHANGEME") {
  throw new Error("UNS_API_JWT_SECRET cannot be CHANGEME.");
}
const catchAllAuth: CatchAllAuthConfig = config.uns?.jwksWellKnownUrl
  ? {
      jwksWellKnownUrl: config.uns.jwksWellKnownUrl,
      activeKidUrl: config.uns.kidWellKnownUrl,
      algorithms: ["RS256"],
    }
  : { jwtSecret: envJwtSecret };

const unsProxyProcess = new UnsProxyProcess(infraChannel.host, {
  processName: config.uns.processName,
  ...mqttChannelParameters(infraChannel),
}) as UnsProxyProcessWithApi;

const apiOptions: IApiProxyOptions = config.uns?.jwksWellKnownUrl
  ? {
      jwks: {
        wellKnownJwksUrl: config.uns.jwksWellKnownUrl,
        ...(config.uns.kidWellKnownUrl !== undefined ? { activeKidUrl: config.uns.kidWellKnownUrl } : {}),
      },
    }
  : {
      jwtSecret: envJwtSecret!,
    };

const apiInput = await unsProxyProcess.createApiProxy("general-api", apiOptions);
let latestQuestDbHealth: QuestDbDependencyHealth | null = null;

async function refreshQuestDbHealth(): Promise<QuestDbDependencyHealth> {
  const checkedAt = new Date().toISOString();
  try {
    await queryQuestDb(questdb, "SELECT 1");
    latestQuestDbHealth = {
      id: "questdb",
      label: "QuestDB",
      state: "healthy",
      healthy: true,
      checkedAt,
    };
  } catch (error) {
    latestQuestDbHealth = {
      id: "questdb",
      label: "QuestDB",
      state: "degraded",
      healthy: false,
      checkedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return latestQuestDbHealth;
}

async function publishApiGlobalServiceMetadata() {
  const health = latestQuestDbHealth ?? (await refreshQuestDbHealth());
  await unsProxyProcess.publishServiceMetadata({
    serviceId: "uns-api-global",
    kind: "core",
    label: "UNS API Global",
    description: "Serves catch-all data APIs, assistant data views, graphing, trigger runtime inspection, and capture runtime.",
    capabilities: ["catchall-api", "assistant-data", "graphs", "trigger-runtime", "capture-runtime"],
    apiRoutes: [
      {
        path: apiBasePath,
        kind: "api-catchall",
        swaggerPath: catchAllSwaggerPath,
      },
      {
        path: `${apiBasePath}/batch/last`,
        kind: "api-route",
      },
      {
        path: `${apiBasePath}/batch/range`,
        kind: "api-route",
      },
      {
        path: `${apiBasePath}/triggers/runtime`,
        kind: "api-route",
      },
      {
        path: `${apiBasePath}/captures/runtime`,
        kind: "api-route",
      },
    ],
    extra: {
      dependencies: [health],
      questdbHealth: health,
    },
  });
}

async function refreshAndPublishQuestDbHealth() {
  const previousHealthy = latestQuestDbHealth?.healthy;
  const health = await refreshQuestDbHealth();
  await publishApiGlobalServiceMetadata();
  if (previousHealthy !== health.healthy) {
    const suffix = health.message ? ` (${health.message})` : "";
    logger.info(`QuestDB dependency health is ${health.state}${suffix}.`);
  }
}

const swaggerDoc = {
  openapi: "3.0.0",
  info: {
    title: "Catch-all UNS data API",
    version: "1.0.0",
    description: catchAll.description ?? "Catch-all UNS data API",
  },
  paths: {
    [`${apiBasePath}/{topicPath}`]: {
      get: {
        summary: catchAll.description ?? "Catch-all UNS data API",
        tags: [catchAll.swaggerTag ?? "CatchAll"],
        parameters: [
          {
            name: "topicPath",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Full attribute topic path",
          },
          {
            name: "table",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "QuestDB table name (optional if controller mappings are available)",
          },
          {
            name: "from",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: `ISO start time (default: last ${questdb.defaultLookbackHours}h)`,
          },
          {
            name: "to",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "ISO end time (default: now)",
          },
          {
            name: "timeField",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["auto", "timestamp", "interval"] },
            description: "Time filter mode: auto (default), timestamp, or interval",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "number" },
            description: `Raw row limit (default ${questdb.defaultLimit}, max ${questdb.maxLimit})`,
          },
          {
            name: "maxPoints",
            in: "query",
            required: false,
            schema: { type: "integer" },
            description: "Return sampled buckets capped to this number of points. Requires explicit from and to.",
          },
          {
            name: "bucketMs",
            in: "query",
            required: false,
            schema: { type: "integer" },
            description: "Return sampled buckets with this bucket width in milliseconds.",
          },
          {
            name: "aggregate",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["avg", "min", "max", "last", "sum", "count"] },
            description: "Bucket aggregate for sampled responses (default: last).",
          },
          {
            name: "transform",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["raw", "delta"] },
            description: "History transform: raw rows (default) or query-time counter delta.",
          },
          {
            name: "counterResetPolicy",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["new-value", "null"] },
            description: "Counter reset handling for transform=delta. new-value treats a negative step as the new counter value; null skips reset rows.",
          },
          {
            name: "column",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Numeric QuestDB column to sample when the table contains multiple numeric columns.",
          },
          {
            name: "summaryOnly",
            in: "query",
            required: false,
            schema: { type: "boolean" },
            description: "Return aggregates instead of rows",
          },
          {
            name: "dedupe",
            in: "query",
            required: false,
            schema: { type: "boolean" },
            description: "Return only latest row per interval (default true, default false for transform=delta)",
          },
        ],
        responses: {
          "200": { description: "OK" },
          "400": { description: "Bad Request" },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden" },
          "413": { description: "Payload Too Large" },
        },
      },
    },
    [`${apiBasePath}/batch/last`]: {
      post: {
        summary: "Batch last values — current/latest value for multiple topics from in-memory cache",
        description:
          "Returns the most recent known value per topic from the MQTT last-value cache " +
          "(seeded from QuestDB on startup), with bounded QuestDB latest-row fallback on cache misses. " +
          "Ideal for dashboards, asset snapshot views, and status panels. " +
          "Internally calls POST /api/catchall/batch with mode=last.",
        tags: [catchAll.swaggerTag ?? "CatchAll"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["topics"],
                properties: {
                  topics: {
                    type: "array",
                    items: { type: "string" },
                    description: "Full attribute topic paths (max 500)",
                  },
                  transform: {
                    type: "string",
                    enum: ["raw", "delta"],
                    description: "Optional last-value transform. delta returns the latest adjacent counter delta while preserving counter metadata.",
                  },
                  counterResetPolicy: {
                    type: "string",
                    enum: ["new-value", "null"],
                    description: "Counter reset handling for transform=delta",
                  },
                },
              },
              example: {
                topics: [
                  "enterprise/site/area/heat-treatment-line/equipment/zone-1/temperature",
                  "enterprise/site/area/heat-treatment-line/equipment/zone-1/status",
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Last value per topic",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          topic: { type: "string" },
                          value: { description: "Scalar value for data attributes (number or string), null for table attributes" },
                          values: {
                            type: "object",
                            description: "Unified values map — data: { value: 900.2 }, table: { batchId: '...', event: 'ENTERED', ... }",
                          },
                          uom: { type: "string", nullable: true },
                          timestamp: { type: "string", nullable: true, description: "ISO timestamp of the last known value" },
                          dataGroup: { type: "string", nullable: true },
                          ageMs: { type: "number", nullable: true, description: "Milliseconds since last MQTT update" },
                          source: { type: "string", enum: ["cache", "questdb", "miss"], description: "cache = value available, questdb = lazy latest-row fallback, miss = no data yet" },
                          counter: {
                            type: "object",
                            nullable: true,
                            description: "Derived adjacent counter metadata for numeric data attributes. absoluteValue remains the source-of-truth counter state; delta is null until a previous state is known.",
                            properties: {
                              absoluteValue: { type: "number" },
                              previousValue: { type: "number", nullable: true },
                              previousTimestamp: { type: "string", nullable: true },
                              delta: { type: "number", nullable: true },
                              reset: { type: "boolean" },
                              resetPolicy: { type: "string", enum: ["new-value", "null"] },
                            },
                          },
                        },
                      },
                    },
                    stats: {
                      type: "object",
                      properties: {
                        requested: { type: "integer" },
                        hits: { type: "integer" },
                        misses: { type: "integer" },
                        cacheSize: { type: "integer", description: "Total entries in the last-value cache" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Bad Request (empty topics array)" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    [`${apiBasePath}/batch/range`]: {
      post: {
        summary: "Batch history — historical time-series data for multiple topics from QuestDB",
        description:
          "Runs parallel QuestDB queries for each requested topic and returns per-topic " +
          "result rows. Supports all the same parameters as the single-topic GET endpoint " +
          "(from, to, limit, dedupe, summaryOnly, transform). Ideal for multi-attribute comparison " +
          "charts, reports, and data export. " +
          "Internally calls POST /api/catchall/batch with mode=range.",
        tags: [catchAll.swaggerTag ?? "CatchAll"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["topics"],
                properties: {
                  topics: {
                    type: "array",
                    items: { type: "string" },
                    description: "Full attribute topic paths (max 500)",
                  },
                  from: { type: "string", description: `ISO start time (default: last ${questdb.defaultLookbackHours}h)` },
                  to: { type: "string", description: "ISO end time (default: now)" },
                  limit: { type: "integer", description: `Raw row limit per topic (default ${questdb.defaultLimit}, max ${questdb.maxLimit})` },
                  maxPoints: { type: "integer", description: "Return sampled buckets capped to this number of points. Requires explicit from and to." },
                  bucketMs: { type: "integer", description: "Return sampled buckets with this bucket width in milliseconds." },
                  aggregate: {
                    type: "string",
                    enum: ["avg", "min", "max", "last", "sum", "count"],
                    description: "Bucket aggregate for sampled responses (default: last)",
                  },
                  transform: {
                    type: "string",
                    enum: ["raw", "delta"],
                    description: "History transform: raw rows (default) or query-time counter delta",
                  },
                  counterResetPolicy: {
                    type: "string",
                    enum: ["new-value", "null"],
                    description: "Counter reset handling for transform=delta",
                  },
                  column: { type: "string", description: "Numeric QuestDB column to sample when the table contains multiple numeric columns" },
                  dedupe: { type: "boolean", description: "Deduplicate rows per interval (default true, default false for transform=delta)" },
                  summaryOnly: { type: "boolean", description: "Return aggregates instead of rows" },
                },
              },
              example: {
                topics: [
                  "enterprise/site/area/heat-treatment-line/equipment/zone-1/temperature",
                  "enterprise/site/area/heat-treatment-line/equipment/zone-2/temperature",
                ],
                from: "2026-04-09T06:00:00Z",
                to: "2026-04-09T07:00:00Z",
                limit: 500,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Per-topic historical data",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          topic: { type: "string" },
                          error: { type: "string", nullable: true, description: "Error message if this topic's query failed" },
                          data: { type: "array", description: "QuestDB result rows (array-of-arrays matching column order)" },
                          stats: {
                            type: "object",
                            properties: {
                              table: { type: "string" },
                              rowCount: { type: "integer" },
                              truncated: { type: "boolean" },
                              from: { type: "string" },
                              to: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                    stats: {
                      type: "object",
                      properties: {
                        requested: { type: "integer" },
                        succeeded: { type: "integer" },
                        failed: { type: "integer" },
                        from: { type: "string" },
                        to: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Bad Request (empty topics, invalid params)" },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden (topic not in dataSources)" },
        },
      },
    },
  },
};

const catchAllRegistrationOptions: Parameters<typeof apiInput.registerCatchAll>[1] = {
  apiDescription: catchAll.description ?? "Catch-all UNS data API",
  apiBasePath,
  swaggerPath: catchAllSwaggerPath,
  swaggerDoc,
  tags: [catchAll.swaggerTag ?? "CatchAll"],
  queryParams: [
    {
      name: "table",
      type: "string",
      required: false,
      description: "QuestDB table name (optional if controller mappings are available)",
    },
    {
      name: "from",
      type: "string",
      required: false,
      description: `ISO start time (default: last ${questdb.defaultLookbackHours}h)`,
    },
    { name: "to", type: "string", required: false, description: "ISO end time (default: now)" },
    {
      name: "timeField",
      type: "string",
      required: false,
      description: "Time filter mode: auto (default), timestamp, or interval",
    },
    {
      name: "limit",
      type: "number",
      required: false,
      description: `Raw row limit (default ${questdb.defaultLimit}, max ${questdb.maxLimit})`,
    },
    {
      name: "maxPoints",
      type: "number",
      required: false,
      description: "Return sampled buckets capped to this number of points. Requires explicit from and to.",
    },
    {
      name: "bucketMs",
      type: "number",
      required: false,
      description: "Return sampled buckets with this bucket width in milliseconds.",
    },
    {
      name: "aggregate",
      type: "string",
      required: false,
      description: "Bucket aggregate for sampled responses: avg, min, max, last, sum, or count.",
    },
    {
      name: "transform",
      type: "string",
      required: false,
      description: "History transform: raw rows (default) or query-time counter delta.",
    },
    {
      name: "counterResetPolicy",
      type: "string",
      required: false,
      description: "Counter reset handling for transform=delta: new-value or null.",
    },
    {
      name: "column",
      type: "string",
      required: false,
      description: "Numeric QuestDB column to sample when the table contains multiple numeric columns.",
    },
    { name: "summaryOnly", type: "boolean", required: false, description: "Return aggregates instead of rows" },
    { name: "dedupe", type: "boolean", required: false, description: "Return only latest row per interval (default true, default false for transform=delta)" },
  ],
};

const catchAllTopicFilters = Array.from(
  new Set(
    dataSources
      .filter((dataSource) => dataSource.history)
      .map((dataSource) => dataSource.topic.trim())
      .filter(Boolean),
  ),
);

for (const topicFilter of catchAllTopicFilters.length ? catchAllTopicFilters : ["#"]) {
  await apiInput.registerCatchAll(topicFilter, catchAllRegistrationOptions);
}

await publishApiGlobalServiceMetadata();

setInterval(() => {
  refreshAndPublishQuestDbHealth().catch((error) => {
    logger.warn(`Failed to publish QuestDB dependency health: ${error instanceof Error ? error.message : String(error)}`);
  });
}, QUESTDB_HEALTHCHECK_INTERVAL);

apiInput.event.on("apiGetEvent", async (event: UnsEvents["apiGetEvent"]) => {
  const { req, res } = event;
  const requestId = resolveRequestId(req?.headers?.["x-request-id"]);
  res.setHeader("x-request-id", requestId);

  try {
    // Intercept POST /api/catchall/batch before the normal GET handler
    if (isBatchRequest(req)) {
      await handleBatchRequest(req, res, requestId);
      return;
    }

    const requestPath = normalizeRequestPath(req.path ?? "");
    if (isSwaggerDefinitionRequest(requestPath, catchAll.swaggerPath)) {
      res.status(200).json(swaggerDoc);
      return;
    }

    // Stage 4b — admin-only runtime inspection endpoint.  Returns
    // per-trigger live state (lastSeenValue, lastFiredAt, fireCount,
    // suppression metrics) so the controller's UI can render an
    // "Armed / Awaiting first value" pill + drill-in detail.
    // Auth is the same JWT guard the catchall uses.
    //
    // The express api-proxy mounts its router under apiBasePath
    // (e.g. /api/catchall), so req.path can arrive as any of:
    //   - "/api/triggers/runtime"          (direct hit, no mount strip)
    //   - "/triggers/runtime"              (mount stripped the prefix)
    //   - "/api/catchall/triggers/runtime" (full original path)
    // We match all three so callers don't have to know which
    // shape they'll get.
    const isRuntimeEndpoint =
      requestPath === "/api/triggers/runtime" ||
      requestPath === "/triggers/runtime" ||
      requestPath === "/api/catchall/triggers/runtime";
    if (isRuntimeEndpoint) {
      if (!triggerService) {
        res.status(503).json({ error: "Trigger service not yet started" });
        return;
      }
      res.status(200).json({
        states: triggerService.getRuntimeStates(),
        capturedAt: new Date().toISOString(),
      });
      return;
    }

    const isCaptureRuntimeEndpoint =
      requestPath === "/api/captures/runtime" ||
      requestPath === "/captures/runtime" ||
      requestPath === `${apiBasePath}/captures/runtime`;
    if (isCaptureRuntimeEndpoint) {
      if (!captureService) {
        res.status(503).json({ error: "Capture service not yet started" });
        return;
      }
      res.status(200).json({
        states: captureService.getRuntimeStates(),
        capturedAt: new Date().toISOString(),
      });
      return;
    }

    const query = extractQueryParams(req);
    const topicFromQuery = String(query?.["topic"] ?? "").trim();
    const topicFromPath = normalizeTopicPath(req.path ?? "", apiBasePath);
    const topic = topicFromQuery || topicFromPath;
    if (!topic) {
      throw new HttpError(400, "Missing required query param: topic");
    }
    if (!isHistoryAllowed(dataSources, topic)) {
      throw new HttpError(403, `Topic '${topic}' is not configured for history queries in dataSources.`);
    }
    await validateCatchAllAccess(req, topic, catchAllAuth);

    const tableFromQuery = sanitizeTable(String(query?.["table"] ?? ""));
    const tableFromDataSource = resolveTablePrefix(dataSources, topic);
    const table =
      tableFromQuery ||
      tableFromDataSource ||
      (await resolveTableFromController(topic, {
        controllerGraphqlUrl,
        tokenProvider: controllerTokenProvider,
      }));
    if (!table) {
      throw new HttpError(
        400,
        "Missing or invalid query param: table (and no matching QuestDB mapping found). Provide ?table= or configure mappings in controller.",
      );
    }

    const summaryOnly = toBoolean(query?.["summaryOnly"] ?? query?.["summary"]);
    const limit = clampLimit(query?.["limit"], questdb.defaultLimit, questdb.maxLimit);
    const transform = parseHistoryTransformMode(query?.["transform"]);
    const counterResetPolicy = parseCounterResetPolicy(query?.["counterResetPolicy"] ?? query?.["resetPolicy"]);
    if (summaryOnly && transform !== "raw") {
      throw new HttpError(400, "summaryOnly cannot be combined with transform=delta.");
    }
    const dedupeRequested = query?.["dedupe"] === undefined ? transform !== "delta" : toBoolean(query?.["dedupe"]);
    const timeField = parseTimeFieldPreference(query?.["timeField"]);
    const requestedMaxPoints = parsePositiveIntegerParam(query?.["maxPoints"], "maxPoints");
    const requestedBucketMs = parsePositiveIntegerParam(query?.["bucketMs"], "bucketMs");
    const aggregate = parseAggregateMode(query?.["aggregate"]) ?? DEFAULT_BUCKET_AGGREGATE;
    const requestedMetricColumn = parseOptionalColumnParam(query?.["column"] ?? query?.["metricColumn"], "column");
    const sampledRequested = !summaryOnly && (requestedMaxPoints !== null || requestedBucketMs !== null);
    if (
      sampledRequested &&
      requestedMaxPoints !== null &&
      requestedBucketMs === null &&
      (!hasQueryValue(query?.["from"]) || !hasQueryValue(query?.["to"]))
    ) {
      throw new HttpError(400, "Query param maxPoints requires explicit from and to timestamps.");
    }
    const range = normalizeRange(
      query?.["from"],
      query?.["to"],
      questdb,
      sampledRequested ? questdb.maxSampleLookbackHours : undefined,
    );

    const parsedPath = parseUnsPath(topic);
    const tableSchema = await getTableSchema(questdb, table);
    const tableColumns = tableSchema.columns;
    const temporal = resolveTemporalStrategy(tableColumns, timeField);
    const dedupeApplied = canApplyDedupe(dedupeRequested, tableColumns);
    let sampling: HistorySamplingInfo;
    let sql: string;
    if (summaryOnly) {
      sampling = { mode: "summary" };
      sql = buildSummarySql(table, parsedPath, range, temporal, tableColumns);
    } else if (sampledRequested) {
      const metricColumn = resolveMetricColumn(tableSchema, parsedPath, requestedMetricColumn);
      const unitColumn = resolveUnitColumn(tableSchema, metricColumn);
      const bucketMs = requestedBucketMs ?? deriveBucketMs(range, requestedMaxPoints!);
      const bucketAggregate: AggregateMode = transform === "delta" ? "sum" : aggregate;
      sampling = {
        mode: "bucketed",
        requestedMaxPoints,
        bucketMs,
        aggregate: bucketAggregate,
        transform,
        ...(transform === "delta" ? { counterResetPolicy } : {}),
        metricColumn,
        unitColumn,
        ...(transform === "delta" ? { boundaryMode: "interpolated" as const } : {}),
      };
      if (transform === "delta") {
        sql = buildSourceSql(
          table,
          parsedPath,
          counterBoundarySourceRange(range, bucketMs),
          dedupeRequested,
          tableColumns,
          temporal,
          [metricColumn, ...(unitColumn ? [unitColumn] : [])],
        );
      } else {
        const sourceSql = buildSourceSql(
          table,
          parsedPath,
          range,
          dedupeRequested,
          tableColumns,
          temporal,
          [metricColumn, ...(unitColumn ? [unitColumn] : [])],
        );
        sql = buildBucketSql(sourceSql, temporal, metricColumn, unitColumn, aggregate, bucketMs, requestedMetricColumn);
      }
    } else {
      if (transform === "delta") {
        const metricColumn = resolveMetricColumn(tableSchema, parsedPath, requestedMetricColumn);
        const unitColumn = resolveUnitColumn(tableSchema, metricColumn);
        const sourceSql = buildSourceSql(
          table,
          parsedPath,
          range,
          dedupeRequested,
          tableColumns,
          temporal,
          [metricColumn, ...(unitColumn ? [unitColumn] : [])],
        );
        const deltaSourceSql = buildCounterDeltaSourceSql(
          sourceSql,
          temporal,
          metricColumn,
          unitColumn,
          counterResetPolicy,
          requestedMetricColumn,
        );
        sampling = { mode: "raw", transform, counterResetPolicy, metricColumn, unitColumn };
        sql = buildCounterDeltaRawSql(deltaSourceSql, limit);
      } else {
        sampling = { mode: "raw", transform };
        sql = buildDataSql(table, parsedPath, range, limit, dedupeRequested, tableColumns, temporal);
      }
    }

    const rawResult = await queryQuestDb(questdb, sql);
    const result = sampling.mode === "bucketed" && sampling.transform === "delta"
      ? buildBoundaryCounterDeltaResponse(
          rawResult,
          sql,
          range,
          temporal,
          sampling.metricColumn,
          sampling.unitColumn,
          sampling.bucketMs,
          sampling.counterResetPolicy ?? DEFAULT_COUNTER_RESET_POLICY,
          requestedMetricColumn,
        )
      : rawResult;
    const scanRowCount = extractScanRowCount(result.raw);
    if (scanRowCount !== null && scanRowCount > questdb.maxScanRows) {
      throw new HttpError(
        413,
        `Query scan cost exceeded maxScanRows (${questdb.maxScanRows}). Narrow path/time-range or reduce requested scope.`,
      );
    }

    const stats = {
      table,
      limit,
      from: range.from,
      to: range.to,
      summaryOnly,
      transform,
      counterResetPolicy: transform === "delta" ? counterResetPolicy : undefined,
      timeFieldRequested: timeField,
      timeFieldResolved: temporal.mode,
      timeFromColumn: temporal.fromColumn,
      timeToColumn: temporal.toColumn,
      dedupeRequested,
      dedupeApplied,
      note: range.note,
      rowCount: result.data?.length ?? 0,
      scanRowCount,
      sampling: sampling.mode === "bucketed"
        ? { ...sampling, returnedPoints: result.data?.length ?? 0 }
        : sampling,
    };

    const payload = summaryOnly
      ? {
          data: result.data,
          stats: { ...stats, raw: result.raw },
        }
      : {
          data: result.data,
          stats: { ...stats, raw: result.raw, truncated: sampling.mode === "raw" && (result.data?.length ?? 0) >= limit },
        };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (payloadBytes > questdb.maxResponseBytes) {
      throw new HttpError(
        413,
        `Response exceeds maxResponseBytes (${questdb.maxResponseBytes}). Reduce limit or narrow the time-range.`,
      );
    }

    res.status(200).json(payload);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message, requestId });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[${requestId}] catch-all handler error: ${message}`);
    res.status(500).json({ error: "Internal server error", requestId });
  }
});

// ─── Last-Value Cache (MQTT subscription + in-memory map) ───────────────────

type LastValueEntry = {
  values: Record<string, unknown>; // unified: data → { value: X }, table → { col1: X, col2: Y, ... }
  uom: string | null;
  timestamp: string;
  receivedAt: number;
  dataGroup: string | null;
  counter?: {
    absoluteValue: number;
    previousValue: number | null;
    previousTimestamp: string | null;
  } | undefined;
};

const lastValueMap = new Map<string, LastValueEntry>();
let lvMqttInput: UnsMqttProxy | undefined;
let lvActiveTopics: string[] = [];
let triggerService: TriggerService | undefined;
let triggerOutputProxy: UnsMqttProxy | undefined;
let captureService: CaptureService | undefined;
let captureOutputProxy: UnsMqttProxy | undefined;

function sanitizeTopic(topic: string): string {
  return typeof topic === "string" && topic.endsWith("/") ? topic.slice(0, -1) : topic;
}

function timestampMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCounterCacheState(
  topic: string,
  currentValue: unknown,
  timestamp: string,
): LastValueEntry["counter"] | undefined {
  const absoluteValue = toNumber(currentValue);
  if (absoluteValue === null) return undefined;

  const previousEntry = lastValueMap.get(topic);
  const previousEntryValue = previousEntry ? toNumber(previousEntry.values["value"]) : null;
  const currentMs = timestampMs(timestamp);
  const previousMs = timestampMs(previousEntry?.timestamp);
  const hasLaterTimestamp = currentMs === null || previousMs === null || currentMs > previousMs;
  const previousValue = hasLaterTimestamp ? previousEntryValue : null;

  return {
    absoluteValue,
    previousValue,
    previousTimestamp: previousValue === null ? null : previousEntry?.timestamp ?? null,
  };
}

function buildSeedCounterState(value: unknown): LastValueEntry["counter"] | undefined {
  const absoluteValue = toNumber(value);
  if (absoluteValue === null) return undefined;
  return {
    absoluteValue,
    previousValue: null,
    previousTimestamp: null,
  };
}

async function fetchActiveTopicsFromController(): Promise<string[]> {
  if (!controllerGraphqlUrl) return [];
  try {
    const token = await controllerTokenProvider.getAccessToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const document = gql`
      query GetUnsNodes {
        GetUnsNodes {
          id
          type
          fullTopic
        }
      }
    `;
    const result: any = await request(controllerGraphqlUrl, document, undefined, headers);
    const nodes: any[] = result?.GetUnsNodes ?? [];
    return nodes
      .filter((n: any) => n.type === "Attribute" && typeof n.fullTopic === "string")
      .map((n: any) => sanitizeTopic(n.fullTopic))
      .filter((topic: string) => isCacheAllowed(dataSources, topic));
  } catch (err) {
    logger.warn(`[last-value-cache] Failed to fetch topics from controller: ${err instanceof Error ? err.message : err}`);
    return lvActiveTopics; // keep previous set on failure
  }
}

function updateLastValue(topic: string, mqttMessage: string): void {
  try {
    if (!isCacheAllowed(dataSources, topic)) return;

    const unsPacket = UnsPacket.parseMqttPacket(mqttMessage);
    if (!unsPacket) return;

    const msg = unsPacket.message;
    const data = msg?.data;
    const table = (msg as any)?.table;

    if (data) {
      // Data attribute → single value stored as { value: X }
      const timestamp = data.time ?? new Date().toISOString();
      lastValueMap.set(topic, {
        values: { value: data.value ?? null },
        uom: data.uom ?? null,
        timestamp,
        receivedAt: Date.now(),
        dataGroup: data.dataGroup ?? null,
        counter: buildCounterCacheState(topic, data.value ?? null, timestamp),
      });
    } else if (table) {
      // Table attribute → multi-column values stored as { col1: X, col2: Y, ... }.
      // UnsPacket normalizes legacy arrays to the canonical named object first.
      const columns = tableColumnsToLastValues(table.columns);
      if (Object.keys(columns).length > 0) {
        lastValueMap.set(topic, {
          values: columns,
          uom: null,
          timestamp: table.time ?? new Date().toISOString(),
          receivedAt: Date.now(),
          dataGroup: table.dataGroup ?? null,
        });
      }
    }
  } catch {
    // best effort — drop malformed packets silently
  }
}

async function initLastValueCache(): Promise<void> {
  if (!lastValueCacheConfig.enabled) {
    logger.info("[last-value-cache] Disabled by config.");
    return;
  }

  // Initial topic fetch
  lvActiveTopics = await fetchActiveTopicsFromController();
  if (lvActiveTopics.length === 0) {
    logger.warn("[last-value-cache] No active topics found — will retry on next refresh.");
  } else {
    logger.info(`[last-value-cache] Subscribing to ${lvActiveTopics.length} data topics.`);
  }

  // Create MQTT input proxy
  const lvProcess = new UnsProxyProcess(infraChannel.host, {
    processName: `${config.uns.processName}-lvc`,
    ...mqttChannelParameters(infraChannel),
  });
  lvMqttInput = await lvProcess.createUnsMqttProxy(
    inputChannel.host,
    "lastValueCacheInput",
    config.uns.instanceMode ?? "wait",
    false, // no handover — passive listener
    {
      ...mqttChannelParameters(inputChannel),
      mqttSubToTopics: lvActiveTopics.length > 0 ? lvActiveTopics : ["$none"],
      subscribeThrottlingDelay: 0,
    },
  );

  lvMqttInput.event.on("input", async (mqttEvent: any) => {
    const topic = sanitizeTopic(mqttEvent.topic ?? "");
    if (!topic) return;
    updateLastValue(topic, mqttEvent.message);
    // Trigger evaluation hot-path.  Service skips fast (O(1) topic
    // index lookup) when no trigger is watching this topic.  We pull
    // the freshly-cached entry rather than re-parsing the packet.
    if (triggerService) {
      const entry = lastValueMap.get(topic);
      if (entry) {
        triggerService.onMessage({
          topic,
          value: entry.values?.["value"] ?? null,
          uom: entry.uom,
          sourceTimestamp: entry.timestamp,
        });
      }
    }
    if (captureService) {
      const entry = lastValueMap.get(topic);
      if (entry) {
        void captureService.onMessage({
          topic,
          sourceTimestamp: entry.timestamp,
        }).catch((err) => {
          logger.warn(`[captures] onMessage failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  });

  // Periodic topic refresh
  setInterval(async () => {
    const newTopics = await fetchActiveTopicsFromController();
    if (JSON.stringify(newTopics) === JSON.stringify(lvActiveTopics)) return;

    const oldTopics = lvActiveTopics;
    lvActiveTopics = newTopics;

    if (lvMqttInput) {
      const toUnsub = oldTopics.filter(Boolean);
      if (toUnsub.length > 0) lvMqttInput.unsubscribeAsync(toUnsub);
      if (newTopics.length > 0) lvMqttInput.subscribeAsync(newTopics);
    }

    logger.info(`[last-value-cache] Topic refresh: ${oldTopics.length} → ${newTopics.length} topics.`);
  }, lastValueCacheConfig.topicRefreshIntervalMs);

  // Periodic stale eviction
  const evictionInterval = Math.max(lastValueCacheConfig.staleTtlMs / 4, 60_000);
  setInterval(() => {
    const cutoff = Date.now() - lastValueCacheConfig.staleTtlMs;
    let evicted = 0;
    for (const [key, entry] of lastValueMap) {
      if (entry.receivedAt < cutoff) {
        lastValueMap.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.info(`[last-value-cache] Evicted ${evicted} stale entries (${lastValueMap.size} remaining).`);
    }
  }, evictionInterval);

  // Seed cache from QuestDB — fetch last known value for each topic so the
  // cache is warm even after a restart (before MQTT delivers new messages).
  seedCacheFromQuestDb(lvActiveTopics).catch(err => {
    logger.warn(`[last-value-cache] QuestDB seed failed: ${err instanceof Error ? err.message : err}`);
  });

  logger.info("[last-value-cache] Initialized.");
}

// ─── Trigger Service (Stage 1: high / low / event) ──────────────────────────
//
// Polls controller's GET /api/triggers, evaluates incoming MQTT
// messages against each matching trigger (edge-only, with optional
// cooldown), and republishes a uns-kit message to the trigger's
// outputTopic when a fire decision lands.  Output flows through a
// dedicated UnsMqttProxy on the configured `output.host` so the
// trigger fires feed back into the same broker that other producers
// publish to (uns-archiver picks them up via its catch-all flow).

async function initTriggerService(): Promise<void> {
  if (!controllerRestUrl) {
    logger.info("[triggers] No uns.rest configured — trigger service disabled.");
    return;
  }
  // Dedicated proxy (handover off — passive publisher only).
  const trProcess = new UnsProxyProcess(infraChannel.host, {
    processName: `${config.uns.processName}-triggers`,
    ...mqttChannelParameters(infraChannel),
  });
  triggerOutputProxy = await trProcess.createUnsMqttProxy(
    outputChannel.host,
    "triggerOutput",
    config.uns.instanceMode ?? "wait",
    false, // no handover — fires never need cluster handoff
    {
      ...mqttChannelParameters(outputChannel),
      // No subscriptions — this proxy only publishes.
      mqttSubToTopics: ["$none"],
      subscribeThrottlingDelay: 0,
    },
  );

  const registry = new TriggerRegistry({
    controllerRestUrl,
    getAccessToken: async () => {
      try {
        return (await controllerTokenProvider.getAccessToken()) ?? null;
      } catch {
        return null;
      }
    },
    refreshIntervalMs: lastValueCacheConfig.topicRefreshIntervalMs ?? 30_000,
  });
  const publisher = new TriggerPublisher({
    publish: async ({ outputTopic, payload }) => {
      try {
        await triggerOutputProxy!.publishMessage(outputTopic, payload);
      } catch (err) {
        logger.warn(
          `[triggers] publish to ${outputTopic} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  });
  triggerService = new TriggerService({
    registry,
    publisher,
    // Stage 2: cross-topic reads.  Compare reads the peer operand;
    // string reads the snapshotTopics at fire time.  Hand the
    // last-value cache through as a read-only accessor.  Returns
    // null on miss so the evaluator can SUPPRESS with the right
    // reason ('peer_value_missing' / 'stale_snapshot').
    getLastValue: (topic: string) => {
      const entry = lastValueMap.get(topic);
      if (!entry) return null;
      return {
        value: entry.values?.["value"] ?? null,
        uom: entry.uom,
        time: entry.timestamp,
        receivedAt: entry.receivedAt,
      };
    },
    onFire: (event) => {
      void captureService?.onTriggerFire({
        triggerId: event.trigger.id,
        triggerName: event.trigger.name,
        firedAt: new Date(event.firedAtMs).toISOString(),
      });
    },
  });
  await triggerService.start();
  logger.info("[triggers] Initialized.");
}

async function initCaptureService(): Promise<void> {
  if (!controllerRestUrl) {
    logger.info("[captures] No uns.rest configured — capture service disabled.");
    return;
  }
  const captureProcessName = `${config.uns.processName}-captures`;
  const captureProcess = new UnsProxyProcess(infraChannel.host, {
    processName: captureProcessName,
    ...mqttChannelParameters(infraChannel),
  });
  captureOutputProxy = await captureProcess.createUnsMqttProxy(
    outputChannel.host,
    "captureOutput",
    config.uns.instanceMode ?? "wait",
    false,
    {
      ...mqttChannelParameters(outputChannel),
      mqttSubToTopics: ["$none"],
      subscribeThrottlingDelay: 0,
    },
  );

  const registry = new CaptureRegistry({
    controllerRestUrl,
    getAccessToken: async () => {
      try {
        return (await controllerTokenProvider.getAccessToken()) ?? null;
      } catch {
        return null;
      }
    },
    refreshIntervalMs: lastValueCacheConfig.topicRefreshIntervalMs ?? 30_000,
  });
  const publisher = new CapturePublisher({
    publish: async ({ outputTopic, payload }) => {
      try {
        await captureOutputProxy!.publishMessage(outputTopic, payload);
      } catch (err) {
        logger.warn(
          `[captures] publish to ${outputTopic} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  });
  captureService = new CaptureService({
    registry,
    publisher,
    auditSession: async (event: CaptureSessionAuditEvent) => {
      const token = await controllerTokenProvider.getAccessToken();
      if (!token) {
        logger.warn("[captures] no access token available; skipping session audit");
        return;
      }
      const response = await fetch(`${controllerRestUrl.replace(/\/+$/, "")}/captures/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          ...event,
          runtimeProcess: captureProcessName,
        }),
      });
      if (!response.ok) {
        logger.warn(
          `[captures] controller responded ${response.status} for POST /api/captures/sessions`,
        );
      }
    },
    getLastValue: (topic: string) => {
      const entry = lastValueMap.get(topic);
      if (!entry) return null;
      return {
        value: entry.values?.["value"] ?? null,
        values: entry.values,
        uom: entry.uom,
        time: entry.timestamp,
        receivedAt: entry.receivedAt,
      };
    },
  });
  await captureService.start();
  logger.info("[captures] Initialized.");
}

async function seedCacheFromQuestDb(topics: string[]): Promise<void> {
  if (!topics.length) return;
  const resolverCfg: MappingResolverConfig = { controllerGraphqlUrl, tokenProvider: controllerTokenProvider };

  // Group topics by resolved table
  const topicsByTable = new Map<string, string[]>();
  for (const topic of topics) {
    const tableFromDs = resolveTablePrefix(dataSources, topic);
    const table = tableFromDs || (await resolveTableFromController(topic, resolverCfg));
    if (!table) continue;
    let list = topicsByTable.get(table);
    if (!list) { list = []; topicsByTable.set(table, list); }
    list.push(topic);
  }

  let seeded = 0;
  for (const [table, tableTopics] of topicsByTable) {
    try {
      const columns = await getTableColumns(questdb, table);
      const selectCols = buildDataColumnList(columns).map(quoteIdentifier).join(", ");
      const partitionCols = buildDedupePartitionColumns(columns).map(quoteIdentifier).join(", ");
      const pointTimeColumn = resolvePointTimeColumn(columns);
      if (!pointTimeColumn || !partitionCols) continue;

      // Build WHERE clause to limit to only our topics
      const topicParts = tableTopics.map(t => {
        const parsed = parseUnsPath(t);
        const conditions: string[] = [];
        if (parsed.topic && columns.has("topic")) conditions.push(`${quoteIdentifier("topic")} = ${escapeLiteral(parsed.topic)}`);
        if (parsed.asset && columns.has("asset")) conditions.push(`${quoteIdentifier("asset")} = ${escapeLiteral(parsed.asset)}`);
        if (parsed.objectType && columns.has("objectType")) conditions.push(`${quoteIdentifier("objectType")} = ${escapeLiteral(parsed.objectType)}`);
        if (parsed.objectId && columns.has("objectId")) conditions.push(`${quoteIdentifier("objectId")} = ${escapeLiteral(parsed.objectId)}`);
        if (parsed.attribute && columns.has("attribute")) conditions.push(`${quoteIdentifier("attribute")} = ${escapeLiteral(parsed.attribute)}`);
        return conditions.length ? `(${conditions.join(" AND ")})` : null;
      }).filter(Boolean);

      if (!topicParts.length) continue;

      const sql = `
        SELECT ${selectCols}
        FROM ${quoteIdentifier(table)}
        WHERE ${topicParts.join(" OR ")}
        LATEST ON ${quoteIdentifier(pointTimeColumn)} PARTITION BY ${partitionCols}
      `;
      const result = await queryQuestDb(questdb, sql);
      if (!result.data?.length) continue;

      // Parse rows back into cache entries
      const rawCols = (result.raw as any)?.columns as Array<{ name: string; type: string }> | undefined;
      const colNames = rawCols?.map((c: any) => c.name) ?? [];
      const tsIdx = colNames.indexOf(pointTimeColumn);
      const topicIdx = colNames.indexOf("topic");
      const attrIdx = colNames.indexOf("attribute");
      const assetIdx = colNames.indexOf("asset");
      const objTypeIdx = colNames.indexOf("objectType");
      const objIdIdx = colNames.indexOf("objectId");
      const valueIdx = colNames.indexOf("value");
      const numValueIdx = colNames.indexOf("numberValue");
      const strValueIdx = colNames.indexOf("stringValue");
      const uomIdx = colNames.indexOf("uom");
      const valueTypeIdx = colNames.indexOf("valueType");

      for (const row of result.data as unknown[][]) {
        // Reconstruct the full topic path
        const topicBase = topicIdx >= 0 ? String(row[topicIdx] ?? "") : "";
        const asset = assetIdx >= 0 ? String(row[assetIdx] ?? "") : "";
        const objType = objTypeIdx >= 0 ? String(row[objTypeIdx] ?? "") : "";
        const objId = objIdIdx >= 0 ? String(row[objIdIdx] ?? "") : "";
        const attr = attrIdx >= 0 ? String(row[attrIdx] ?? "") : "";
        const fullTopic = [topicBase, asset, objType, objId, attr].filter(Boolean).join("/");
        if (!fullTopic) continue;

        const ts = tsIdx >= 0 ? String(row[tsIdx] ?? "") : "";
        if (!ts) continue;

        const valueType = valueTypeIdx >= 0 ? row[valueTypeIdx] : null;
        const numVal = numValueIdx >= 0 ? row[numValueIdx] : (valueIdx >= 0 ? row[valueIdx] : null);
        const strVal = strValueIdx >= 0 ? row[strValueIdx] : null;

        // For seeded entries, set receivedAt to the actual data timestamp so
        // ageMs reflects real staleness, not time since restart.
        const seedReceivedAt = new Date(ts).getTime() || Date.now();

        if (valueType === "number" || (typeof numVal === "number" && numVal !== null)) {
          const seedCounter = buildSeedCounterState(numVal);
          lastValueMap.set(fullTopic, {
            values: { value: numVal },
            uom: uomIdx >= 0 ? (row[uomIdx] as string ?? null) : null,
            timestamp: ts,
            receivedAt: seedReceivedAt,
            dataGroup: null,
            ...(seedCounter ? { counter: seedCounter } : {}),
          });
          seeded++;
        } else if (typeof strVal === "string" && strVal.length > 0) {
          lastValueMap.set(fullTopic, {
            values: { value: strVal },
            uom: null,
            timestamp: ts,
            receivedAt: seedReceivedAt,
            dataGroup: null,
          });
          seeded++;
        } else {
          // Table attribute fallback: collect all non-standard columns into values map
          const standardCols = new Set([
            "topic", "attribute", "asset", "objectType", "objectId",
            "valueType", "value", "numberValue", "stringValue", "uom",
            "time", "timestamp", "interval", "intervalStart", "intervalEnd",
            "lastSeen", "deleted",
          ]);
          const customValues: Record<string, unknown> = {};
          for (let ci = 0; ci < colNames.length; ci++) {
            const colName = colNames[ci];
            if (standardCols.has(colName)) continue;
            const cellValue = (row as unknown[])[ci];
            if (cellValue != null) customValues[colName] = cellValue;
          }
          if (Object.keys(customValues).length > 0) {
            lastValueMap.set(fullTopic, {
              values: customValues,
              uom: null,
              timestamp: ts,
              receivedAt: seedReceivedAt,
              dataGroup: null,
            });
            seeded++;
          }
        }
      }
    } catch (err) {
      logger.warn(`[last-value-cache] QuestDB seed error for table ${table}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (seeded > 0) {
    logger.info(`[last-value-cache] Seeded ${seeded} entries from QuestDB (${lastValueMap.size} total in cache).`);
  }
}

// ─── Batch Endpoint (POST /api/catchall/batch) ─────────────────────────────
// The catch-all route middleware emits apiGetEvent for ALL HTTP methods,
// so we intercept POST /api/catchall/batch inside the existing handler.

function isBatchRequest(req: any): boolean {
  // The catch-all middleware emits apiGetEvent for all methods and strips the
  // base path from req.path. Use originalUrl (which keeps /api/catchall/batch)
  // and the real HTTP method from the underlying request.
  const method = String(req?.method ?? "").toUpperCase();
  if (method !== "POST") return false;
  const originalUrl = String(req?.originalUrl ?? req?.url ?? "").split("?")[0] ?? "";
  const normalizedUrl = normalizeRequestPath(originalUrl);
  // Accept /batch, /batch/last, and /batch/range
  return (
    normalizedUrl === `${apiBasePath}/batch` ||
    normalizedUrl === `${apiBasePath}/batch/last` ||
    normalizedUrl === `${apiBasePath}/batch/range`
  );
}

function resolveBatchMode(req: any, body: any): string {
  // URL-based mode takes priority: /batch/last → "last", /batch/range → "range"
  const originalUrl = String(req?.originalUrl ?? req?.url ?? "").split("?")[0] ?? "";
  const normalizedUrl = normalizeRequestPath(originalUrl);
  if (normalizedUrl.endsWith("/last")) return "last";
  if (normalizedUrl.endsWith("/range")) return "range";
  // Fall back to body mode field
  return String(body?.mode ?? "last").toLowerCase();
}

async function handleBatchRequest(req: any, res: any, requestId: string): Promise<void> {
  // Parse body
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const topics: string[] = Array.isArray(body?.topics) ? body.topics.map((t: unknown) => String(t).trim()).filter(Boolean) : [];

  if (topics.length === 0) {
    throw new HttpError(400, "Request body must contain a non-empty 'topics' array.");
  }
  if (topics.length > 500) {
    throw new HttpError(400, "Maximum 500 topics per batch request.");
  }

  await validateCatchAllAccessForTopics(req, topics, catchAllAuth);

  const mode = resolveBatchMode(req, body);
  if (mode !== "last" && mode !== "range") {
    throw new HttpError(400, `Unsupported mode: '${mode}'. Supported: 'last', 'range'.`);
  }

  if (mode === "last") {
    const transform = parseHistoryTransformMode(body?.transform);
    const counterResetPolicy = parseCounterResetPolicy(body?.counterResetPolicy ?? body?.resetPolicy);
    await handleBatchLast(topics, res, { transform, counterResetPolicy });
  } else {
    await handleBatchRange(topics, body, res);
  }
}

// ── Lazy QuestDB fallback for batch/last ─────────────────────────────────────
//
// When a topic is not in the in-memory MQTT cache (for example because the
// message was published while uns-api-global was down, or the publisher is
// emitting sparse lifecycle events that we missed), fall back to a single
// QuestDB "latest row" lookup. The result is also inserted into lastValueMap
// so subsequent requests hit the fast path.
//
// A short-lived throttle map prevents us from re-querying the same
// permanently-empty topic on every tick.
const BATCH_LAST_FALLBACK_LIMIT = 20;
const BATCH_LAST_FALLBACK_THROTTLE_MS = 5_000;
const batchLastFallbackAttemptAt = new Map<string, number>();

type BatchLastOptions = {
  transform: HistoryTransformMode;
  counterResetPolicy: CounterResetPolicy;
};

type BatchLastCounterResult = {
  absoluteValue: number;
  previousValue: number | null;
  previousTimestamp: string | null;
  delta: number | null;
  reset: boolean;
  resetPolicy: CounterResetPolicy;
};

type BatchLastResult = {
  topic: string;
  value: unknown;
  values: Record<string, unknown> | null;
  uom: string | null;
  timestamp: string | null;
  dataGroup: string | null;
  ageMs: number | null;
  source: "cache" | "questdb" | "miss";
  sql: string | null;
  counter: BatchLastCounterResult | null;
};

function buildBatchLastCounterResult(
  entry: LastValueEntry,
  resetPolicy: CounterResetPolicy,
): BatchLastCounterResult | null {
  const computed = computeCounterDeltaValue(
    entry.counter?.absoluteValue ?? entry.values["value"],
    entry.counter?.previousValue ?? null,
    resetPolicy,
  );
  if (!computed) return null;
  return {
    absoluteValue: computed.absoluteValue,
    previousValue: computed.previousValue,
    previousTimestamp: computed.previousValue === null ? null : entry.counter?.previousTimestamp ?? null,
    delta: computed.delta,
    reset: computed.reset,
    resetPolicy,
  };
}

function buildBatchLastResult(
  topic: string,
  entry: LastValueEntry,
  source: "cache" | "questdb",
  sql: string | null,
  now: number,
  options: BatchLastOptions,
): BatchLastResult {
  const counter = buildBatchLastCounterResult(entry, options.counterResetPolicy);
  const deltaValues: Record<string, unknown> | null = counter
    ? {
        value: counter.delta,
        counterValue: counter.absoluteValue,
        previousCounterValue: counter.previousValue,
        counterReset: counter.reset,
      }
    : null;
  return {
    topic,
    value: options.transform === "delta" ? counter?.delta ?? null : entry.values["value"] ?? null,
    values: options.transform === "delta" ? deltaValues : entry.values,
    uom: entry.uom,
    timestamp: entry.timestamp,
    dataGroup: entry.dataGroup,
    ageMs: now - entry.receivedAt,
    source,
    sql,
    counter,
  };
}

async function tryQuestDbLastRowFallback(
  topic: string,
): Promise<{ entry: LastValueEntry; sql: string } | null> {
  try {
    const tableFromDataSource = resolveTablePrefix(dataSources, topic);
    const table =
      tableFromDataSource ||
      (await resolveTableFromController(topic, { controllerGraphqlUrl, tokenProvider: controllerTokenProvider }));
    if (!table) return null;

    const parsedPath = parseUnsPath(topic);
    const tableColumns = await getTableColumns(questdb, table);
    const temporal = resolveTemporalStrategy(tableColumns, "auto");
    // A latest-value lookup is not a history query. Sparse ObjectId attributes
    // can be months old, so do not apply the raw-query lookback cap here.
    const range: TimeRange = {};
    const sql = buildDataSql(table, parsedPath, range, 1, true, tableColumns, temporal);
    const result = await queryQuestDb(questdb, sql);
    const rows = (result.data ?? []) as unknown[][];
    if (!rows.length) return null;
    const row = rows[0];
    if (!row) return null;

    // Column order for buildDataSql is buildDataColumnList(columns) — use
    // the raw response columns to map values by name. queryQuestDb only
    // returns `dataset`, so we need the column list from the raw response.
    const rawAny = result.raw as Record<string, unknown>;
    const rawColumns = Array.isArray(rawAny?.["columns"])
      ? (rawAny["columns"] as Array<{ name?: string }>).map(c => c?.name ?? "")
      : [];
    const colIdx = (name: string): number => rawColumns.indexOf(name);

    const tsIdx = colIdx(temporal.fromColumn);
    const valueTypeIdx = colIdx("valueType");
    const numValueIdx = colIdx("numberValue");
    const valueIdx = colIdx("value");
    const strValueIdx = colIdx("stringValue");
    const uomIdx = colIdx("uom");

    const ts = tsIdx >= 0 ? String(row[tsIdx] ?? "") : "";
    if (!ts) return null;

    const valueType = valueTypeIdx >= 0 ? row[valueTypeIdx] : null;
    const numVal = numValueIdx >= 0 ? row[numValueIdx] : (valueIdx >= 0 ? row[valueIdx] : null);
    const strVal = strValueIdx >= 0 ? row[strValueIdx] : null;
    const seedReceivedAt = new Date(ts).getTime() || Date.now();

    if (valueType === "number" || (typeof numVal === "number" && numVal !== null)) {
      return {
        entry: {
          values: { value: numVal },
          uom: uomIdx >= 0 ? (row[uomIdx] as string ?? null) : null,
          timestamp: ts,
          receivedAt: seedReceivedAt,
          dataGroup: null,
          counter: buildSeedCounterState(numVal),
        },
        sql,
      };
    }
    if (typeof strVal === "string" && strVal.length > 0) {
      return {
        entry: {
          values: { value: strVal },
          uom: null,
          timestamp: ts,
          receivedAt: seedReceivedAt,
          dataGroup: null,
        },
        sql,
      };
    }

    // Table-attribute fallback: collect all non-standard columns into values map
    const standardCols = new Set([
      "topic", "attribute", "asset", "objectType", "objectId",
      "valueType", "value", "numberValue", "stringValue", "uom",
      "time", "timestamp", "interval", "intervalStart", "intervalEnd",
      "lastSeen", "deleted",
    ]);
    const customValues: Record<string, unknown> = {};
    for (let ci = 0; ci < rawColumns.length; ci++) {
      const colName = rawColumns[ci];
      if (!colName || standardCols.has(colName)) continue;
      const cellValue = row[ci];
      if (cellValue != null) customValues[colName] = cellValue;
    }
    if (Object.keys(customValues).length === 0) return null;
    return {
      entry: {
        values: customValues,
        uom: null,
        timestamp: ts,
        receivedAt: seedReceivedAt,
        dataGroup: null,
      },
      sql,
    };
  } catch (err) {
    logger.debug(`[batch/last] QuestDB fallback failed for ${topic}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function handleBatchLast(topics: string[], res: any, options: BatchLastOptions): Promise<void> {
  const now = Date.now();

  // First pass: serve everything from the in-memory cache and collect misses.
  // `sql` is null for cache hits + misses — no query was run for those.
  // Only rows resolved via the QuestDB fallback (below) get a populated
  // sql string.  The controller's Show-SQL flow filters these out.
  type MissIndex = { topic: string; idx: number };
  const results: BatchLastResult[] = new Array(topics.length);
  const misses: MissIndex[] = [];

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i]!;
    const entry = lastValueMap.get(topic);
    if (entry) {
      results[i] = buildBatchLastResult(topic, entry, "cache", null, now, options);
      continue;
    }
    results[i] = {
      topic,
      value: null,
      values: null,
      uom: null,
      timestamp: null,
      dataGroup: null,
      ageMs: null,
      source: "miss",
      sql: null,
      counter: null,
    };
    misses.push({ topic, idx: i });
  }

  // Second pass: try QuestDB fallback for misses, with throttling + caps so
  // we don't hammer the database on repeat requests for permanently-empty
  // topics. Successful lookups are inserted into lastValueMap so the next
  // batch call hits the fast path.
  const eligible = misses
    .filter(m => {
      const lastAttempt = batchLastFallbackAttemptAt.get(m.topic);
      return !lastAttempt || now - lastAttempt >= BATCH_LAST_FALLBACK_THROTTLE_MS;
    })
    .slice(0, BATCH_LAST_FALLBACK_LIMIT);

  if (eligible.length > 0) {
    await Promise.all(eligible.map(async ({ topic, idx }) => {
      batchLastFallbackAttemptAt.set(topic, now);
      const fallback = await tryQuestDbLastRowFallback(topic);
      if (!fallback) return;
      const { entry, sql } = fallback;
      lastValueMap.set(topic, entry);
      const hitNow = Date.now();
      results[idx] = buildBatchLastResult(topic, entry, "questdb", sql, hitNow, options);
    }));
  }

  res.status(200).json({
    results,
    stats: {
      requested: topics.length,
      hits: results.filter(r => r.source === "cache").length,
      questdbHits: results.filter(r => r.source === "questdb").length,
      misses: results.filter(r => r.source === "miss").length,
      cacheSize: lastValueMap.size,
      transform: options.transform,
    },
  });
}

async function handleBatchRange(topics: string[], body: any, res: any): Promise<void> {
  const limit = clampLimit(body?.limit, questdb.defaultLimit, questdb.maxLimit);
  const summaryOnly = toBoolean(body?.summaryOnly ?? false);
  const transform = parseHistoryTransformMode(body?.transform);
  const counterResetPolicy = parseCounterResetPolicy(body?.counterResetPolicy ?? body?.resetPolicy);
  if (summaryOnly && transform !== "raw") {
    throw new HttpError(400, "summaryOnly cannot be combined with transform=delta.");
  }
  const dedupeRequested = body?.dedupe === undefined ? transform !== "delta" : toBoolean(body.dedupe);
  const timeField = parseTimeFieldPreference(body?.timeField);
  const requestedMaxPoints = parsePositiveIntegerParam(body?.maxPoints, "maxPoints");
  const requestedBucketMs = parsePositiveIntegerParam(body?.bucketMs, "bucketMs");
  const aggregate = parseAggregateMode(body?.aggregate) ?? DEFAULT_BUCKET_AGGREGATE;
  const requestedMetricColumn = parseOptionalColumnParam(body?.column ?? body?.metricColumn, "column");
  const sampledRequested = !summaryOnly && (requestedMaxPoints !== null || requestedBucketMs !== null);
  if (
    sampledRequested &&
    requestedMaxPoints !== null &&
    requestedBucketMs === null &&
    (!hasQueryValue(body?.from) || !hasQueryValue(body?.to))
  ) {
    throw new HttpError(400, "Body field maxPoints requires explicit from and to timestamps.");
  }
  const range = normalizeRange(
    body?.from,
    body?.to,
    questdb,
    sampledRequested ? questdb.maxSampleLookbackHours : undefined,
  );

  // Check topic filtering
  for (const topic of topics) {
    if (!isHistoryAllowed(dataSources, topic)) {
      throw new HttpError(403, `Topic '${topic}' is not configured for history queries in dataSources.`);
    }
  }

  // Resolve tables + run queries in parallel.  Each result carries the
  // full multi-line QuestDB SQL that was executed (`sql` field) so the
  // controller can surface it in the Explore dialog's "Show SQL" flow.
  // Pretty-printed form (what `buildDataSql` / `buildSummarySql` emit)
  // rather than the compacted one-liner `queryQuestDb` passes on the
  // wire — pasting into the QuestDB Web Console is the target use case,
  // and the multi-line form is drastically easier to read.
  const results = await Promise.all(
    topics.map(async (topic) => {
      try {
        const tableFromDataSource = resolveTablePrefix(dataSources, topic);
        const table =
          tableFromDataSource ||
          (await resolveTableFromController(topic, { controllerGraphqlUrl, tokenProvider: controllerTokenProvider }));
        if (!table) {
          return { topic, error: "No QuestDB table mapping found.", data: null, sql: null, stats: null };
        }

        const parsedPath = parseUnsPath(topic);
        const tableSchema = await getTableSchema(questdb, table);
        const tableColumns = tableSchema.columns;
        const temporal = resolveTemporalStrategy(tableColumns, timeField);
        let sampling: HistorySamplingInfo;
        let sql: string;
        if (summaryOnly) {
          sampling = { mode: "summary" };
          sql = buildSummarySql(table, parsedPath, range, temporal, tableColumns);
        } else if (sampledRequested) {
          const metricColumn = resolveMetricColumn(tableSchema, parsedPath, requestedMetricColumn);
          const unitColumn = resolveUnitColumn(tableSchema, metricColumn);
          const bucketMs = requestedBucketMs ?? deriveBucketMs(range, requestedMaxPoints!);
          const bucketAggregate: AggregateMode = transform === "delta" ? "sum" : aggregate;
          sampling = {
            mode: "bucketed",
            requestedMaxPoints,
            bucketMs,
            aggregate: bucketAggregate,
            transform,
            ...(transform === "delta" ? { counterResetPolicy } : {}),
            metricColumn,
            unitColumn,
            ...(transform === "delta" ? { boundaryMode: "interpolated" as const } : {}),
          };
          if (transform === "delta") {
            sql = buildSourceSql(
              table,
              parsedPath,
              counterBoundarySourceRange(range, bucketMs),
              dedupeRequested,
              tableColumns,
              temporal,
              [metricColumn, ...(unitColumn ? [unitColumn] : [])],
            );
          } else {
            const sourceSql = buildSourceSql(
              table,
              parsedPath,
              range,
              dedupeRequested,
              tableColumns,
              temporal,
              [metricColumn, ...(unitColumn ? [unitColumn] : [])],
            );
            sql = buildBucketSql(sourceSql, temporal, metricColumn, unitColumn, aggregate, bucketMs, requestedMetricColumn);
          }
        } else {
          if (transform === "delta") {
            const metricColumn = resolveMetricColumn(tableSchema, parsedPath, requestedMetricColumn);
            const unitColumn = resolveUnitColumn(tableSchema, metricColumn);
            const sourceSql = buildSourceSql(
              table,
              parsedPath,
              range,
              dedupeRequested,
              tableColumns,
              temporal,
              [metricColumn, ...(unitColumn ? [unitColumn] : [])],
            );
            const deltaSourceSql = buildCounterDeltaSourceSql(
              sourceSql,
              temporal,
              metricColumn,
              unitColumn,
              counterResetPolicy,
              requestedMetricColumn,
            );
            sampling = { mode: "raw", transform, counterResetPolicy, metricColumn, unitColumn };
            sql = buildCounterDeltaRawSql(deltaSourceSql, limit);
          } else {
            sampling = { mode: "raw", transform };
            sql = buildDataSql(table, parsedPath, range, limit, dedupeRequested, tableColumns, temporal);
          }
        }

        const rawResult = await queryQuestDb(questdb, sql);
        const result = sampling.mode === "bucketed" && sampling.transform === "delta"
          ? buildBoundaryCounterDeltaResponse(
              rawResult,
              sql,
              range,
              temporal,
              sampling.metricColumn,
              sampling.unitColumn,
              sampling.bucketMs,
              sampling.counterResetPolicy ?? DEFAULT_COUNTER_RESET_POLICY,
              requestedMetricColumn,
            )
          : rawResult;
        const scanRowCount = extractScanRowCount(result.raw);

        return {
          topic,
          error: null,
          data: result.data,
          columns: sampling.mode === "raw" ? buildDataColumnList(tableColumns) : null,
          sql,
          stats: {
            table,
            limit,
            from: range.from,
            to: range.to,
            summaryOnly,
            transform,
            counterResetPolicy: transform === "delta" ? counterResetPolicy : undefined,
            rowCount: result.data?.length ?? 0,
            scanRowCount,
            sampling: sampling.mode === "bucketed"
              ? { ...sampling, returnedPoints: result.data?.length ?? 0 }
              : sampling,
            truncated: sampling.mode === "raw" && (result.data?.length ?? 0) >= limit,
            // Keep the QuestDB column names so batch clients can map row arrays.
            raw: {
              columns: Array.isArray(result.raw["columns"])
                ? result.raw["columns"]
                : [],
            },
          },
        };
      } catch (err) {
        const message = err instanceof HttpError ? err.message : (err instanceof Error ? err.message : String(err));
        return { topic, error: message, data: null, sql: null, stats: null };
      }
    }),
  );

  res.status(200).json({
    results,
    stats: {
      requested: topics.length,
      succeeded: results.filter(r => r.error === null).length,
      failed: results.filter(r => r.error !== null).length,
      from: range.from,
      to: range.to,
      transform,
      counterResetPolicy: transform === "delta" ? counterResetPolicy : undefined,
    },
  });
}

// Start last-value cache (non-blocking — errors logged, not thrown)
initLastValueCache().catch(err => {
  logger.error(`[last-value-cache] Init failed: ${err instanceof Error ? err.message : err}`);
});

// Start trigger service (non-blocking — errors logged, not thrown).
// Independent of the last-value cache init; safe even when cache is
// disabled, since the input handler already sets up correctly.
initTriggerService().catch(err => {
  logger.error(`[triggers] Init failed: ${err instanceof Error ? err.message : err}`);
});

// Start capture service (non-blocking — errors logged, not thrown).
// It depends on the same last-value cache path as triggers; if the
// cache is disabled, runtime registration still works but no MQTT
// messages will drive sessions.
initCaptureService().catch(err => {
  logger.error(`[captures] Init failed: ${err instanceof Error ? err.message : err}`);
});

// ─── End Last-Value Cache ───────────────────────────────────────────────────

type MappingResolverConfig = {
  controllerGraphqlUrl: string | null;
  tokenProvider: AccessTokenProvider;
};

type QuestDbMappingEntry = {
  topicPrefix?: string | null;
  tableName?: string | null;
  tablePrefix?: string | null;
};

type TableSchemaCacheEntry = {
  schema: TableSchema;
  fetchedAt: number;
};
type TemporalStrategy = {
  mode: "timestamp" | "interval";
  fromColumn: string;
  toColumn: string;
  orderBy: string;
};

const mappingCache: { entries: QuestDbMappingEntry[]; fetchedAt: number } = { entries: [], fetchedAt: 0 };
const MAPPINGS_TTL_MS = 60_000;
const jwksCache: { keys: JwkKey[]; fetchedAt: number } = { keys: [], fetchedAt: 0 };
const JWKS_TTL_MS = 5 * 60_000;
const tableSchemaCache = new Map<string, TableSchemaCacheEntry>();
const TABLE_COLUMNS_TTL_MS = 60_000;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function resolveTableFromController(topic: string, cfg: MappingResolverConfig): Promise<string | null> {
  try {
    const mappings = await getQuestDbMappings(cfg);
    if (!mappings.length) return null;
    const normalizedTopic = topic.replace(/^\/+|\/+$/g, "");
    let best: { prefix: string; table: string } | null = null;

    for (const entry of mappings) {
      const prefix = (entry.topicPrefix ?? "").replace(/^\/+|\/+$/g, "");
      const tableCandidate = sanitizeTable((entry.tableName ?? entry.tablePrefix ?? "").trim() || "");
      if (!prefix || !tableCandidate) continue;
      if (normalizedTopic.startsWith(prefix)) {
        if (!best || prefix.length > best.prefix.length) {
          best = { prefix, table: tableCandidate };
        }
      }
    }

    if (best) return best.table;

    // Sibling fallback: if no exact prefix match, try finding a mapping for a sibling
    // topic with the same attribute name but a different objectId (dynamic segment).
    // For example: mat-c7d77380/location → find mat-*/location mapping.
    const segments = normalizedTopic.split("/");
    if (segments.length >= 2) {
      const attributeName = segments[segments.length - 1];
      // Try replacing the objectId (second-to-last segment) with a wildcard search
      const parentPrefix = segments.slice(0, -2).join("/");
      for (const entry of mappings) {
        const prefix = (entry.topicPrefix ?? "").replace(/^\/+|\/+$/g, "");
        const tableCandidate = sanitizeTable((entry.tableName ?? entry.tablePrefix ?? "").trim() || "");
        if (!prefix || !tableCandidate) continue;
        // Check if this mapping has the same parent prefix and attribute name
        if (prefix.startsWith(parentPrefix + "/") && prefix.endsWith("/" + attributeName)) {
          logger.debug(`resolveTableFromController sibling fallback: ${normalizedTopic} → ${tableCandidate} (via ${prefix})`);
          return tableCandidate;
        }
      }
    }

    return null;
  } catch (error) {
    logger.warn(`resolveTableFromController failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function getQuestDbMappings(cfg: MappingResolverConfig): Promise<QuestDbMappingEntry[]> {
  const now = Date.now();
  if (mappingCache.entries.length && now - mappingCache.fetchedAt < MAPPINGS_TTL_MS) {
    return mappingCache.entries;
  }
  if (!cfg.controllerGraphqlUrl) return [];
  let token: string | null = null;
  try {
    token = await cfg.tokenProvider.getAccessToken() ?? null;
  } catch (error) {
    logger.warn(`QuestDBMappings auth error: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (!token) return [];

  const query = `
    query QuestMappings {
      QuestDBMappings {
        topicPrefix
        tableName
        tablePrefix
      }
    }
  `;

  try {
    const response = await fetch(cfg.controllerGraphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });
    const payload = (await response.json()) as {
      data?: { QuestDBMappings?: QuestDbMappingEntry[] | null } | null;
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok) {
      const message = payload?.errors?.[0]?.message ?? `status ${response.status}`;
      logger.warn(`QuestDBMappings query failed: ${message}`);
      return [];
    }
    const entries = (payload.data?.QuestDBMappings ?? []).filter(
      (m): m is QuestDbMappingEntry => !!m && typeof m === "object",
    );
    mappingCache.entries = entries;
    mappingCache.fetchedAt = now;
    return entries;
  } catch (error) {
    logger.warn(`QuestDBMappings fetch error: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function parseProjectExtras(config: { questdb?: unknown; catchAll?: unknown; lastValueCache?: unknown; dataSources?: unknown }): {
  questdb: QuestDbConfig;
  catchAll: CatchAllConfig;
  lastValueCache: ProjectExtras["lastValueCache"];
  dataSources: DataSourceConfig[];
} {
  const parsed = projectExtrasSchema.safeParse({ questdb: config.questdb, catchAll: config.catchAll, lastValueCache: config.lastValueCache, dataSources: config.dataSources });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    const message = `Invalid questdb/catchAll configuration: ${details}`;
    logger.error(message);
    throw new Error(message);
  }

  return parsed.data;
}

function normalizeBasePath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed.startsWith("/")) return `/${trimmed}`;
  return trimmed.replace(/\/+$/, "") || "/";
}

function normalizeTopicPath(rawPath: string, basePath: string): string {
  const stripLeading = (value: string) => value.replace(/^\/+/, "");
  const base = stripLeading(basePath);
  let cleaned = stripLeading(rawPath);
  if (cleaned.startsWith(base)) {
    cleaned = cleaned.slice(base.length);
  }
  cleaned = cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
  cleaned = cleaned.replace(/^api\/catchall\//, "");
  cleaned = cleaned.replace(/^catchall\//, "");
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

function extractQueryParams(req: UnsEvents["apiGetEvent"]["req"]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  const addValue = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length > 0) merged[key] = value[0];
      return;
    }
    merged[key] = value;
  };

  if (req?.query && typeof req.query === "object") {
    for (const [key, value] of Object.entries(req.query as Record<string, unknown>)) {
      addValue(key, value);
    }
  }

  const parseFromUrl = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const idx = raw.indexOf("?");
    if (idx < 0) return;
    const qs = raw.slice(idx + 1);
    if (!qs.length) return;
    const params = new URLSearchParams(qs);
    for (const [key, value] of params.entries()) {
      if (!(key in merged)) merged[key] = value;
    }
  };

  parseFromUrl(req?.originalUrl);
  parseFromUrl(req?.url);
  return merged;
}

type ParsedPath = {
  fullPath: string;
  topic?: string | undefined;
  asset?: string | undefined;
  objectType?: string | undefined;
  objectId?: string | undefined;
  attribute?: string | undefined;
};

function parseUnsPath(path: string): ParsedPath {
  const cleaned = path.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (!parts.length) return { fullPath: cleaned };
  const attribute = parts.pop();
  const objectId = parts.pop();
  const objectType = parts.pop();
  const asset = parts.pop();
  const topic = parts.join("/");
  return {
    fullPath: cleaned,
    topic: topic || undefined,
    asset: asset || undefined,
    objectType: objectType || undefined,
    objectId: objectId || undefined,
    attribute: attribute || undefined,
  };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const num = toNumber(value);
  if (num === null) return fallback;
  return Math.min(max, Math.max(1, Math.floor(num)));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  return false;
}

function hasQueryValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function parsePositiveIntegerParam(value: unknown, paramName: string): number | null {
  if (!hasQueryValue(value)) return null;
  const numericValue = toNumber(value);
  if (numericValue === null || !Number.isInteger(numericValue) || numericValue <= 0) {
    throw new HttpError(400, `Invalid query param: ${paramName} (must be a positive integer)`);
  }
  return numericValue;
}

function parseOptionalColumnParam(value: unknown, paramName: string): string | null {
  if (!hasQueryValue(value)) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, `Invalid query param: ${paramName} (must be a column name)`);
  }
  const trimmed = value.trim();
  if (!trimmed || !/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new HttpError(400, `Invalid query param: ${paramName} (must be a column name)`);
  }
  return trimmed;
}

function parseTimeFieldPreference(value: unknown): TimeFieldPreference {
  if (value === undefined || value === null) return "auto";
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: timeField (allowed: auto|timestamp|interval)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "auto";
  if (normalized === "auto") return "auto";
  if (normalized === "timestamp" || normalized === "interval") return normalized;
  throw new HttpError(400, "Invalid query param: timeField (allowed: auto|timestamp|interval)");
}

function parseAggregateMode(value: unknown): AggregateMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: aggregate (allowed: avg|min|max|last|sum|count)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "avg" ||
    normalized === "min" ||
    normalized === "max" ||
    normalized === "last" ||
    normalized === "sum" ||
    normalized === "count"
  ) {
    return normalized;
  }
  throw new HttpError(400, "Invalid query param: aggregate (allowed: avg|min|max|last|sum|count)");
}

function parseHistoryTransformMode(value: unknown): HistoryTransformMode {
  if (value === undefined || value === null) return DEFAULT_HISTORY_TRANSFORM;
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: transform (allowed: raw|delta)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "raw") return "raw";
  if (normalized === "delta") return "delta";
  throw new HttpError(400, "Invalid query param: transform (allowed: raw|delta)");
}

function parseCounterResetPolicy(value: unknown): CounterResetPolicy {
  if (value === undefined || value === null) return DEFAULT_COUNTER_RESET_POLICY;
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid query param: counterResetPolicy (allowed: new-value|null)");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "new-value") return "new-value";
  if (normalized === "null") return "null";
  if (normalized === "rollover") {
    throw new HttpError(400, "counterResetPolicy=rollover is not supported yet; use new-value or null.");
  }
  throw new HttpError(400, "Invalid query param: counterResetPolicy (allowed: new-value|null)");
}

function estimateBucketCount(fromMs: number, toMs: number, bucketMs: number): number {
  return Math.floor(toMs / bucketMs) - Math.floor(fromMs / bucketMs) + 1;
}

function deriveBucketMs(range: TimeRange, maxPoints: number): number {
  const fromMs = new Date(range.from!).getTime();
  const toMs = new Date(range.to!).getTime();
  let bucketMs = Math.max(1, Math.ceil((toMs - fromMs + 1) / maxPoints));
  while (estimateBucketCount(fromMs, toMs, bucketMs) > maxPoints) {
    bucketMs += 1;
  }
  return bucketMs;
}

function resolveTemporalStrategy(columns: Set<string>, preference: TimeFieldPreference): TemporalStrategy {
  const pointTimeColumn = resolvePointTimeColumn(columns);
  const hasInterval = columns.has("intervalStart") && columns.has("intervalEnd");

  if (preference === "interval" && !hasInterval) {
    throw new HttpError(400, "Requested timeField=interval, but table does not contain intervalStart and intervalEnd columns.");
  }
  if (preference === "timestamp" && !pointTimeColumn) {
    throw new HttpError(400, "Requested timeField=timestamp, but table does not contain a time or timestamp column.");
  }

  if (preference === "interval" && hasInterval) {
    if (!pointTimeColumn) {
      return {
        mode: "interval",
        fromColumn: "intervalStart",
        toColumn: "intervalEnd",
        orderBy: `"intervalStart" DESC`,
      };
    }
    return {
      mode: "interval",
      fromColumn: "intervalStart",
      toColumn: "intervalEnd",
      orderBy: `"intervalStart" DESC, ${quoteIdentifier(pointTimeColumn)} DESC`,
    };
  }

  if (!pointTimeColumn) {
    throw new HttpError(400, "Table does not contain a time or timestamp column required for time filtering.");
  }
  return {
    mode: "timestamp",
    fromColumn: pointTimeColumn,
    toColumn: pointTimeColumn,
    orderBy: `${quoteIdentifier(pointTimeColumn)} DESC`,
  };
}

function resolvePointTimeColumn(columns: Set<string>): "time" | "timestamp" | null {
  return resolvePointTimeColumnFromSchema({
    columns,
    orderedColumns: [],
    columnTypes: new Map(),
  });
}

function normalizeRange(from: unknown, to: unknown, cfg: QuestDbConfig, maxLookbackHoursOverride?: number): TimeRange {
  const maxLookbackHours = maxLookbackHoursOverride ?? cfg.maxLookbackHours;
  const maxWindowMs = maxLookbackHours * 60 * 60 * 1000;
  const defaultWindowMs = cfg.defaultLookbackHours * 60 * 60 * 1000;
  const parse = (value: unknown): Date | null => {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const hasValue = (value: unknown): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    return true;
  };
  const fromProvided = hasValue(from);
  const toProvided = hasValue(to);

  let fromDate = parse(from);
  let toDate = parse(to);
  if (fromProvided && !fromDate) {
    throw new HttpError(400, "Invalid query param: from (must be ISO timestamp/date)");
  }
  if (toProvided && !toDate) {
    throw new HttpError(400, "Invalid query param: to (must be ISO timestamp/date)");
  }

  if (!toDate) toDate = new Date();
  if (!fromDate) fromDate = new Date(toDate.getTime() - defaultWindowMs);

  if (fromDate.getTime() > toDate.getTime()) {
    [fromDate, toDate] = [toDate, fromDate];
  }

  const span = toDate.getTime() - fromDate.getTime();
  const range: TimeRange = { from: fromDate.toISOString(), to: toDate.toISOString() };
  if (span > maxWindowMs) {
    if (fromProvided || toProvided) {
      throw new HttpError(
        400,
        `Requested time-range exceeds maxLookbackHours (${maxLookbackHours}h). Reduce from/to window.`,
      );
    }
    const adjustedFrom = new Date(toDate.getTime() - maxWindowMs);
    range.from = adjustedFrom.toISOString();
    range.note = "Window truncated to maxLookbackHours.";
  }
  return range;
}

function sanitizeTable(table: string): string | null {
  const trimmed = table.trim();
  if (!trimmed) return null;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function buildDataColumnList(columns: Set<string>): string[] {
  const preferredOrder = [
    "topic",
    "attribute",
    "asset",
    "objectType",
    "objectId",
    "valueType",
    "value",
    "numberValue",
    "stringValue",
    "uom",
    "intervalStart",
    "intervalEnd",
    "time",
    "timestamp",
    "interval",
  ];
  const knownSet = new Set(preferredOrder);
  const selected = preferredOrder.filter(column => columns.has(column));
  // Append any custom/dynamic columns not in the known list (e.g. batchId,
  // materialId, recipeId, event, quantity — from table-type attributes).
  const custom = Array.from(columns).filter(col => !knownSet.has(col)).sort();
  const result = [...selected, ...custom];
  if (result.length) return result;
  return ["timestamp"];
}

function buildDedupePartitionColumns(columns: Set<string>): string[] {
  const preferredPartition = ["topic", "asset", "objectType", "objectId", "attribute", "intervalStart", "intervalEnd"];
  const selected = preferredPartition.filter(column => columns.has(column));
  if (selected.length) return selected;
  return ["topic", "asset", "objectType", "objectId", "attribute"].filter(column => columns.has(column));
}

function canApplyDedupe(dedupeRequested: boolean, columns: Set<string>): boolean {
  if (!dedupeRequested) return false;
  if (!resolvePointTimeColumn(columns)) return false;
  return buildDedupePartitionColumns(columns).length > 0;
}

function isNumericQuestDbType(typeName: string | undefined): boolean {
  if (!typeName) return false;
  return NUMERIC_QUESTDB_TYPES.has(typeName.trim().toUpperCase());
}

function resolveMetricColumn(schema: TableSchema, parsed: ParsedPath, requestedColumn: string | null = null): string {
  if (requestedColumn) {
    if (!schema.columns.has(requestedColumn)) {
      throw new HttpError(400, `Requested metric column '${requestedColumn}' does not exist in this QuestDB table.`);
    }
    if (!isNumericQuestDbType(schema.columnTypes.get(requestedColumn))) {
      throw new HttpError(400, `Requested metric column '${requestedColumn}' is not numeric.`);
    }
    return requestedColumn;
  }

  const attributeCandidate = parsed.attribute?.trim();
  if (
    attributeCandidate &&
    schema.columns.has(attributeCandidate) &&
    isNumericQuestDbType(schema.columnTypes.get(attributeCandidate))
  ) {
    return attributeCandidate;
  }
  if (schema.columns.has("numberValue") && isNumericQuestDbType(schema.columnTypes.get("numberValue"))) {
    return "numberValue";
  }
  if (schema.columns.has("value") && isNumericQuestDbType(schema.columnTypes.get("value"))) {
    return "value";
  }

  const numericCandidates = schema.orderedColumns.filter(
    column => !NON_VALUE_COLUMNS.has(column) && isNumericQuestDbType(schema.columnTypes.get(column)),
  );
  if (numericCandidates.length === 1) {
    return numericCandidates[0]!;
  }
  if (!numericCandidates.length) {
    throw new HttpError(
      400,
      "Sampled requests require a numeric value column. Expected numberValue, value, or exactly one numeric data column.",
    );
  }
  throw new HttpError(
    400,
    "Sampled requests are ambiguous for this table. Add a single numeric value column or expose a dedicated numeric attribute.",
  );
}

function resolveUnitColumn(schema: TableSchema, metricColumn: string | null = null): string | null {
  if (metricColumn) {
    const lowerCompanion = `${metricColumn}_uom`;
    const upperCompanion = `${metricColumn}_UOM`;
    if (schema.columns.has(lowerCompanion)) return lowerCompanion;
    if (schema.columns.has(upperCompanion)) return upperCompanion;
  }
  if (schema.columns.has("uom")) return "uom";
  if (schema.columns.has("unit")) return "unit";
  return null;
}

function buildWhere(parsed: ParsedPath, range: TimeRange, temporal: TemporalStrategy, columns: Set<string>): string {
  const parts: string[] = [];
  const addIfPresent = (column: string, value: string | undefined) => {
    if (!value || !columns.has(column)) return;
    parts.push(`${quoteIdentifier(column)} = ${escapeLiteral(value)}`);
  };
  addIfPresent("topic", parsed.topic);
  addIfPresent("asset", parsed.asset);
  addIfPresent("objectType", parsed.objectType);
  addIfPresent("objectId", parsed.objectId);
  addIfPresent("attribute", parsed.attribute);
  // Fallback if nothing else matched and table has plain topic column only
  if (!parts.length && parsed.fullPath && columns.has("topic")) {
    parts.push(`${quoteIdentifier("topic")} = ${escapeLiteral(parsed.fullPath)}`);
  }
  if (!parts.length && parsed.fullPath) {
    throw new HttpError(
      400,
      "Table schema does not contain expected UNS path columns (topic/asset/objectType/objectId/attribute).",
    );
  }
  if (range.from) {
    parts.push(`${quoteIdentifier(temporal.toColumn)} >= ${escapeLiteral(range.from)}`);
  }
  if (range.to) {
    parts.push(`${quoteIdentifier(temporal.fromColumn)} <= ${escapeLiteral(range.to)}`);
  }
  return parts.join(" AND ");
}

function buildDataSql(
  table: string,
  parsed: ParsedPath,
  range: TimeRange,
  limit: number,
  dedupe: boolean,
  columns: Set<string>,
  temporal: TemporalStrategy,
): string {
  const where = buildWhere(parsed, range, temporal, columns);
  const selectColumns = buildDataColumnList(columns).map(quoteIdentifier).join(", ");
  const partitionColumns = buildDedupePartitionColumns(columns).map(quoteIdentifier).join(", ");
  const tableId = quoteIdentifier(table);
  const canDedupe = canApplyDedupe(dedupe, columns);
  const pointTimeColumn = resolvePointTimeColumn(columns);
  if (canDedupe) {
    return `
      SELECT * FROM (
        SELECT ${selectColumns}
        FROM ${tableId}
        WHERE ${where}
        LATEST ON ${quoteIdentifier(pointTimeColumn!)} PARTITION BY ${partitionColumns}
      )
      ORDER BY ${temporal.orderBy}
      LIMIT ${limit}
    `;
  }
  return `
    SELECT ${selectColumns}
    FROM ${tableId}
    WHERE ${where}
    ORDER BY ${temporal.orderBy}
    LIMIT ${limit}
  `;
}

function buildSourceSql(
  table: string,
  parsed: ParsedPath,
  range: TimeRange,
  dedupe: boolean,
  columns: Set<string>,
  temporal: TemporalStrategy,
  requestedColumns: string[],
): string {
  const where = buildWhere(parsed, range, temporal, columns);
  const tableId = quoteIdentifier(table);
  const canDedupe = canApplyDedupe(dedupe, columns);
  const pointTimeColumn = resolvePointTimeColumn(columns);
  const selectedColumns = Array.from(
    new Set(
      requestedColumns
        .concat([temporal.fromColumn, temporal.toColumn])
        .concat(canDedupe && pointTimeColumn ? [pointTimeColumn, ...buildDedupePartitionColumns(columns)] : [])
        .filter(column => columns.has(column)),
    ),
  );
  const selectColumns = selectedColumns.map(quoteIdentifier).join(", ");
  if (canDedupe) {
    const partitionColumns = buildDedupePartitionColumns(columns).map(quoteIdentifier).join(", ");
    return `
      SELECT ${selectColumns}
      FROM ${tableId}
      WHERE ${where}
      LATEST ON ${quoteIdentifier(pointTimeColumn!)} PARTITION BY ${partitionColumns}
    `;
  }
  return `
    SELECT ${selectColumns}
    FROM ${tableId}
    WHERE ${where}
  `;
}

function buildSummarySql(
  table: string,
  parsed: ParsedPath,
  range: TimeRange,
  temporal: TemporalStrategy,
  columns: Set<string>,
): string {
  const where = buildWhere(parsed, range, temporal, columns);
  const startColumn = quoteIdentifier(temporal.fromColumn);
  const endColumn = quoteIdentifier(temporal.toColumn);
  const numberValueColumn = columns.has("numberValue") ? quoteIdentifier("numberValue") : null;
  const numericAggregates = numberValueColumn
    ? `
      min(${numberValueColumn}) AS minNumber,
      max(${numberValueColumn}) AS maxNumber,
      avg(${numberValueColumn}) AS avgNumber,
      first(${numberValueColumn}) AS firstNumber,
      last(${numberValueColumn}) AS lastNumber`
    : `
      null AS minNumber,
      null AS maxNumber,
      null AS avgNumber,
      null AS firstNumber,
      null AS lastNumber`;
  return `
    SELECT
      count() AS rows,
      min(${startColumn}) AS firstTimestamp,
      max(${endColumn}) AS lastTimestamp,
      ${numericAggregates}
    FROM ${quoteIdentifier(table)}
    WHERE ${where}
  `;
}

function buildAggregateExpression(metricColumn: string, aggregate: AggregateMode): string {
  const metricId = quoteIdentifier(metricColumn);
  switch (aggregate) {
    case "avg":
      return `avg(${metricId})`;
    case "min":
      return `min(${metricId})`;
    case "max":
      return `max(${metricId})`;
    case "last":
      return `last(${metricId})`;
    case "sum":
      return `sum(${metricId})`;
    case "count":
      return "count()";
  }
}

function buildBucketSql(
  sourceSql: string,
  temporal: TemporalStrategy,
  metricColumn: string,
  unitColumn: string | null,
  aggregate: AggregateMode,
  bucketMs: number,
  outputMetricColumn: string | null = null,
): string {
  const timeBucketExpression = `timestamp_floor('${bucketMs}T', ${quoteIdentifier(temporal.fromColumn)})`;
  const aggregateExpression = buildAggregateExpression(metricColumn, aggregate);
  const selectParts = [
    `${timeBucketExpression} AS timestamp`,
    `${aggregateExpression} AS value`,
  ];
  if (outputMetricColumn && outputMetricColumn !== "value") {
    selectParts.push(`${aggregateExpression} AS ${quoteIdentifier(outputMetricColumn)}`);
  }
  if (unitColumn) {
    selectParts.push(`last(${quoteIdentifier(unitColumn)}) AS uom`);
    const unitAlias = outputMetricColumn ? `${outputMetricColumn}_uom` : null;
    if (unitAlias && unitAlias !== "uom") {
      selectParts.push(`last(${quoteIdentifier(unitColumn)}) AS ${quoteIdentifier(unitAlias)}`);
    }
  }
  return `
    SELECT ${selectParts.join(", ")}
    FROM (${sourceSql})
    GROUP BY ${timeBucketExpression}
    ORDER BY 1 ASC
  `;
}

function buildCounterDeltaSourceSql(
  sourceSql: string,
  temporal: TemporalStrategy,
  metricColumn: string,
  unitColumn: string | null,
  resetPolicy: CounterResetPolicy,
  outputMetricColumn: string | null = null,
): string {
  const sourceTimestamp = quoteIdentifier(temporal.fromColumn);
  const sourceMetric = quoteIdentifier(metricColumn);
  const selectParts = [
    `${sourceTimestamp} AS "timestamp"`,
    `${sourceMetric} AS "counterValue"`,
    `lag(${sourceMetric}) OVER (ORDER BY ${sourceTimestamp} ASC) AS "previousCounterValue"`,
  ];
  if (unitColumn) {
    selectParts.push(`${quoteIdentifier(unitColumn)} AS "uom"`);
  }

  const counterValue = quoteIdentifier("counterValue");
  const previousCounterValue = quoteIdentifier("previousCounterValue");
  const deltaExpression = resetPolicy === "new-value"
    ? `CASE WHEN ${counterValue} >= ${previousCounterValue} THEN ${counterValue} - ${previousCounterValue} ELSE ${counterValue} END`
    : `CASE WHEN ${counterValue} >= ${previousCounterValue} THEN ${counterValue} - ${previousCounterValue} ELSE null END`;
  const outputParts = [
    `${quoteIdentifier("timestamp")} AS ${quoteIdentifier("timestamp")}`,
    `${deltaExpression} AS ${quoteIdentifier("value")}`,
  ];
  if (outputMetricColumn && outputMetricColumn !== "value") {
    outputParts.push(`${deltaExpression} AS ${quoteIdentifier(outputMetricColumn)}`);
  }
  if (unitColumn) {
    outputParts.push(`${quoteIdentifier("uom")} AS ${quoteIdentifier("uom")}`);
    const unitAlias = outputMetricColumn ? `${outputMetricColumn}_uom` : null;
    if (unitAlias && unitAlias !== "uom") {
      outputParts.push(`${quoteIdentifier("uom")} AS ${quoteIdentifier(unitAlias)}`);
    }
  }
  const resetFilter = resetPolicy === "null" ? `AND ${counterValue} >= ${previousCounterValue}` : "";

  return `
    SELECT ${outputParts.join(", ")}
    FROM (
      SELECT ${selectParts.join(", ")}
      FROM (${sourceSql})
    )
    WHERE ${previousCounterValue} IS NOT NULL
      AND ${counterValue} IS NOT NULL
      ${resetFilter}
  `;
}

function buildCounterDeltaRawSql(deltaSourceSql: string, limit: number): string {
  return `
    SELECT *
    FROM (${deltaSourceSql})
    ORDER BY ${quoteIdentifier("timestamp")} DESC
    LIMIT ${limit}
  `;
}

function buildCounterDeltaBucketSql(
  deltaSourceSql: string,
  unitColumn: string | null,
  bucketMs: number,
  outputMetricColumn: string | null = null,
): string {
  const timeBucketExpression = `timestamp_floor('${bucketMs}T', ${quoteIdentifier("timestamp")})`;
  const valueAggregate = `sum(${quoteIdentifier("value")})`;
  const selectParts = [
    `${timeBucketExpression} AS timestamp`,
    `${valueAggregate} AS value`,
  ];
  if (outputMetricColumn && outputMetricColumn !== "value") {
    selectParts.push(`${valueAggregate} AS ${quoteIdentifier(outputMetricColumn)}`);
  }
  if (unitColumn) {
    selectParts.push(`last(${quoteIdentifier("uom")}) AS uom`);
    const unitAlias = outputMetricColumn ? `${outputMetricColumn}_uom` : null;
    if (unitAlias && unitAlias !== "uom") {
      selectParts.push(`last(${quoteIdentifier("uom")}) AS ${quoteIdentifier(unitAlias)}`);
    }
  }
  return `
    SELECT ${selectParts.join(", ")}
    FROM (${deltaSourceSql})
    GROUP BY ${timeBucketExpression}
    ORDER BY 1 ASC
  `;
}

async function queryQuestDb(
  cfg: QuestDbConfig,
  sql: string,
): Promise<{ data: unknown[]; raw: Record<string, unknown> }> {
  const compactSql = sql.replace(/\s+/g, " ").trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("QuestDB request timed out")), cfg.statementTimeoutMs);

  try {
    const url = new URL("/exec", cfg.url);
    url.searchParams.set("query", compactSql);
    url.searchParams.set("timings", "true");
    url.searchParams.set("count", "true");

    const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const rawText = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }

    if (!response.ok) {
      const parsedObject = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      const detailedError =
        (parsedObject?.["error"] as string | undefined) ??
        (parsedObject?.["message"] as string | undefined) ??
        (typeof parsed === "string" ? parsed : undefined);
      throw new Error(detailedError ? `QuestDB error ${response.status}: ${detailedError}` : `QuestDB error ${response.status}`);
    }

    const dataset =
      typeof parsed === "object" && parsed !== null && "dataset" in (parsed as Record<string, unknown>)
        ? ((parsed as { dataset?: unknown[] }).dataset ?? [])
        : Array.isArray(parsed)
          ? parsed
          : undefined;

    const rawWithQuery = stripDatasetFromQuestDbResponse(parsed, compactSql);

    return { data: dataset ?? [], raw: rawWithQuery };
  } finally {
    clearTimeout(timer);
  }
}

async function getTableSchema(cfg: QuestDbConfig, table: string): Promise<TableSchema> {
  const now = Date.now();
  const cached = tableSchemaCache.get(table);
  if (cached && now - cached.fetchedAt < TABLE_COLUMNS_TTL_MS) {
    return cached.schema;
  }

  const result = await queryQuestDb(cfg, `SHOW COLUMNS FROM ${quoteIdentifier(table)}`);
  const columns = new Set<string>();
  const orderedColumns: string[] = [];
  const columnTypes = new Map<string, string>();
  for (const row of result.data) {
    if (Array.isArray(row) && typeof row[0] === "string") {
      const columnName = row[0];
      columns.add(columnName);
      orderedColumns.push(columnName);
      if (typeof row[1] === "string") {
        columnTypes.set(columnName, row[1]);
      }
      continue;
    }
    if (row && typeof row === "object") {
      const rowObject = row as Record<string, unknown>;
      const columnName = rowObject["column"];
      if (typeof columnName === "string") {
        columns.add(columnName);
        orderedColumns.push(columnName);
        const columnType = rowObject["type"];
        if (typeof columnType === "string") {
          columnTypes.set(columnName, columnType);
        }
      }
    }
  }
  const schema = { columns, orderedColumns, columnTypes };
  tableSchemaCache.set(table, { schema, fetchedAt: now });
  return schema;
}

async function getTableColumns(cfg: QuestDbConfig, table: string): Promise<Set<string>> {
  const schema = await getTableSchema(cfg, table);
  return schema.columns;
}

function stripDatasetFromQuestDbResponse(parsed: unknown, query: string): Record<string, unknown> {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const clone: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    delete clone["dataset"];
    clone["query"] = query;
    return clone;
  }

  if (Array.isArray(parsed)) {
    return { query, format: "array", rowCount: parsed.length };
  }

  if (typeof parsed === "string") {
    return { query, message: parsed };
  }

  return { query };
}

function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue === "string" && headerValue.trim().length > 0) return headerValue.trim();
  if (Array.isArray(headerValue) && typeof headerValue[0] === "string" && headerValue[0].trim().length > 0) {
    return headerValue[0].trim();
  }
  return randomUUID();
}

async function validateCatchAllAccess(
  req: UnsEvents["apiGetEvent"]["req"],
  requestedTopic: string,
  authCfg: CatchAllAuthConfig,
): Promise<void> {
  const accessRules = await resolveCatchAllAccessRules(req, authCfg);
  validateCatchAllTopicAccess(requestedTopic, accessRules);
}

async function validateCatchAllAccessForTopics(
  req: UnsEvents["apiGetEvent"]["req"],
  requestedTopics: string[],
  authCfg: CatchAllAuthConfig,
): Promise<void> {
  const accessRules = await resolveCatchAllAccessRules(req, authCfg);
  for (const topic of requestedTopics) {
    validateCatchAllTopicAccess(topic, accessRules);
  }
}

async function resolveCatchAllAccessRules(
  req: UnsEvents["apiGetEvent"]["req"],
  authCfg: CatchAllAuthConfig,
): Promise<string[]> {
  const token = extractBearerToken(req?.headers?.["authorization"]);
  if (!token) {
    throw new HttpError(401, "Missing or invalid Authorization header");
  }

  const claims = await verifyTokenClaims(token, authCfg);
  const scopes = extractScopeSet(claims);
  if (!(scopes.has("read:uns") || scopes.has("uns:read") || scopes.has("read:*") || scopes.has("*"))) {
    throw new HttpError(403, "Missing required token scope: read:uns");
  }

  const accessRules = extractAccessRules(claims);
  if (!accessRules.length) {
    throw new HttpError(403, "Token does not contain path access rules.");
  }

  return accessRules;
}

function validateCatchAllTopicAccess(topic: string, accessRules: string[]): void {
  if (!isTopicAllowedByAccessRules(topic, accessRules)) {
    throw new HttpError(403, "Requested path is not allowed by token access rules.");
  }
}

function extractBearerToken(headerValue: unknown): string | null {
  if (typeof headerValue === "string") {
    if (!headerValue.startsWith("Bearer ")) return null;
    const token = headerValue.slice(7).trim();
    return token.length ? token : null;
  }
  if (Array.isArray(headerValue)) {
    return extractBearerToken(headerValue[0]);
  }
  return null;
}

async function verifyTokenClaims(token: string, authCfg: CatchAllAuthConfig): Promise<JwtClaims> {
  try {
    const decoded =
      authCfg.jwksWellKnownUrl !== undefined
        ? jwt.verify(token, await getPublicKeyFromJwks(token, authCfg), { algorithms: authCfg.algorithms ?? ["RS256"] })
        : jwt.verify(token, authCfg.jwtSecret!);
    if (!decoded || typeof decoded !== "object") {
      throw new HttpError(401, "Invalid token");
    }
    return decoded as JwtClaims;
  } catch {
    throw new HttpError(401, "Invalid token");
  }
}

function extractScopeSet(claims: JwtClaims): Set<string> {
  const scopes: string[] = [];
  if (typeof claims.scope === "string") scopes.push(...claims.scope.split(/\s+/));
  if (typeof claims.scopes === "string") scopes.push(...claims.scopes.split(/\s+/));
  if (Array.isArray(claims.scopes)) {
    const scopeValues = claims.scopes.filter((value: unknown): value is string => typeof value === "string");
    scopes.push(...scopeValues);
  }
  if (Array.isArray(claims.permissions)) {
    const permissionValues = claims.permissions.filter((value: unknown): value is string => typeof value === "string");
    scopes.push(...permissionValues);
  }

  const normalized = scopes.map(scope => scope.trim().toLowerCase()).filter(Boolean);
  return new Set(normalized);
}

function extractAccessRules(claims: JwtClaims): string[] {
  const fromAccessRules = Array.isArray(claims.accessRules)
    ? claims.accessRules.filter((rule: unknown): rule is string => typeof rule === "string")
    : [];
  const fromPathFilter = typeof claims.pathFilter === "string" ? [claims.pathFilter] : [];

  return [...fromAccessRules, ...fromPathFilter]
    .map(rule => rule.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

function extractScanRowCount(raw: Record<string, unknown>): number | null {
  const candidates = [raw["count"], raw["rowCount"], raw["rows"]].map(toNumber).filter((v): v is number => v !== null);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

async function getPublicKeyFromJwks(token: string, authCfg: CatchAllAuthConfig): Promise<string> {
  if (!authCfg.jwksWellKnownUrl) {
    throw new Error("JWKS configuration missing");
  }

  const decoded = jwt.decode(token, { complete: true }) as { header?: { kid?: string } } | null;
  const kid = decoded?.header?.kid;
  const keys = await fetchJwksKeys(authCfg.jwksWellKnownUrl);
  let jwk = kid ? keys.find(key => key.kid === kid) : undefined;

  if (!jwk && authCfg.activeKidUrl) {
    try {
      const response = await fetch(authCfg.activeKidUrl);
      if (response.ok) {
        const activeKid = (await response.text()).trim();
        jwk = keys.find(key => key.kid === activeKid);
      }
    } catch {
      // no-op
    }
  }

  if (!jwk && keys.length === 1) {
    jwk = keys[0];
  }
  if (!jwk) {
    throw new Error("Signing key not found in JWKS");
  }

  if (Array.isArray(jwk.x5c) && jwk.x5c.length > 0) {
    const firstCertificate = jwk.x5c[0];
    if (firstCertificate) {
      return certFromX5c(firstCertificate);
    }
  }
  if (jwk.kty === "RSA" && jwk.n && jwk.e) {
    const keyObj = createPublicKey({
      key: { kty: "RSA", n: jwk.n, e: jwk.e },
      format: "jwk",
    });
    return keyObj.export({ type: "spki", format: "pem" }).toString();
  }

  throw new Error("Unsupported JWK format");
}

async function fetchJwksKeys(url: string): Promise<JwkKey[]> {
  const now = Date.now();
  if (jwksCache.keys.length && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS (${response.status})`);
  }
  const payload = (await response.json()) as { keys?: unknown };
  const keys = Array.isArray(payload.keys)
    ? payload.keys.filter((k): k is JwkKey => !!k && typeof k === "object")
    : [];

  jwksCache.keys = keys;
  jwksCache.fetchedAt = now;
  return keys;
}

function certFromX5c(x5cValue: string): string {
  const pemBody = x5cValue.match(/.{1,64}/g)?.join("\n") ?? x5cValue;
  return `-----BEGIN CERTIFICATE-----\n${pemBody}\n-----END CERTIFICATE-----\n`;
}

function normalizeRequestPath(rawPath: string): string {
  const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  const withoutTrailing = collapsed.replace(/\/+$/, "");
  return withoutTrailing || "/";
}

function isSwaggerDefinitionRequest(requestPath: string, configuredSwaggerPath: string | undefined): boolean {
  const normalizedConfigured = normalizeRequestPath(configuredSwaggerPath ?? "/uns-api-global/general-api/catchall-swagger.json");
  const normalizedRequest = normalizeRequestPath(requestPath);

  const knownSwaggerPaths = new Set<string>([
    normalizedConfigured,
    "/swagger",
    "/swagger.json",
    "/catchall-swagger.json",
  ]);

  if (knownSwaggerPaths.has(normalizedRequest)) {
    return true;
  }

  return normalizedRequest.endsWith("/catchall-swagger.json");
}
