import { z } from "zod";
import { secretValueSchema } from "@uns-kit/core/uns-config/secret-placeholders.js";

const dataSourceSchema = z.object({
  topic: z
    .string()
    .min(1, "dataSources[].topic is required")
    .describe(
      "MQTT topic filter pattern (supports # and + wildcards, e.g. 'enterprise/#')",
    ),
  tablePrefix: z
    .string()
    .optional()
    .describe(
      "QuestDB table name prefix for history queries (optional — falls back to controller mapping resolution)",
    ),
  history: z
    .boolean()
    .default(true)
    .describe(
      "Enable QuestDB history queries for topics matching this pattern",
    ),
  cache: z
    .boolean()
    .default(true)
    .describe("Enable MQTT last-value cache for topics matching this pattern"),
});

export type DataSourceConfig = z.infer<typeof dataSourceSchema>;

const nonEmptySecretValueSchema = secretValueSchema.refine(
  (value) => typeof value !== "string" || value.trim().length > 0,
  "QuestDB credential must not be empty",
);

const questDbUrlSchema = secretValueSchema.refine(
  (value) => typeof value !== "string" || z.url().safeParse(value).success,
  "questdb.url must be an absolute URL",
);

export const projectExtrasSchema = z.object({
  questdb: z.object({
    queryDiagnostics: z
      .object({
        databaseLabel: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
          .default("questdb")
          .describe(
            "Non-secret logical database label, for example history-replica",
          ),
        failureCooldownMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .default(5000)
          .describe(
            "Pause new queries after dependency timeouts, connection failures or HTTP 5xx",
          ),
        maxConcurrent: z
          .number()
          .int()
          .min(1)
          .max(64)
          .default(4)
          .describe("Maximum simultaneous QuestDB queries in this API process"),
        maxQueued: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .default(64)
          .describe("Bounded waiting queue; excess work returns 503"),
        queueTimeoutMs: z
          .number()
          .int()
          .min(1)
          .max(60000)
          .default(1000)
          .describe("Maximum queue wait before 503"),
        slowQueryMs: z
          .number()
          .int()
          .positive()
          .default(1000)
          .describe("Slow-query diagnostic threshold in milliseconds"),
      })
      .default({
        databaseLabel: "questdb",
        failureCooldownMs: 5000,
        maxConcurrent: 4,
        maxQueued: 64,
        queueTimeoutMs: 1000,
        slowQueryMs: 1000,
      }),
    url: questDbUrlSchema.describe(
      "Base URL for QuestDB HTTP API (e.g. http://questdb:9000)",
    ),
    username: nonEmptySecretValueSchema.describe(
      "QuestDB HTTP username (Basic Auth)",
    ),
    password: nonEmptySecretValueSchema.describe(
      "QuestDB HTTP password (Basic Auth)",
    ),
    defaultLimit: z
      .number()
      .int()
      .positive()
      .default(500)
      .describe("Default row limit for data queries"),
    maxLimit: z
      .number()
      .int()
      .positive()
      .default(2000)
      .describe("Maximum allowed row limit for data queries"),
    defaultLookbackHours: z
      .number()
      .int()
      .positive()
      .default(24)
      .describe("Default lookback window (hours) when no from/to is supplied"),
    maxLookbackHours: z
      .number()
      .int()
      .positive()
      .default(168)
      .describe("Maximum allowed lookback window (hours) for raw queries"),
    maxSampleLookbackHours: z
      .number()
      .int()
      .positive()
      .default(744)
      .describe(
        "Maximum allowed lookback window (hours) for sampled maxPoints/bucketMs queries",
      ),
    statementTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(20000)
      .describe("Timeout in milliseconds for QuestDB HTTP requests"),
    maxScanRows: z
      .number()
      .int()
      .positive()
      .default(200000)
      .describe("Maximum allowed scan rows reported by QuestDB query metadata"),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .default(1048576)
      .describe("Maximum JSON payload bytes returned by catch-all endpoint"),
  }),
  dataSources: z
    .array(dataSourceSchema)
    .default([{ topic: "#", history: true, cache: true }])
    .describe(
      "Topic scoping for both QuestDB history queries and the MQTT last-value cache. " +
        "Each entry defines an MQTT topic filter pattern. Topics not matching any entry are rejected. " +
        "Similar to uns-archiver dataStorage — supports # and + wildcards.",
    ),
  catchAll: z
    .object({
      apiBasePath: z
        .string()
        .default("/api/catchall")
        .describe(
          "Path prefix exposed for the catch-all API (avoid /api to not clash with controller).",
        ),
      swaggerPath: z
        .string()
        .default("/uns-api-global/general-api/catchall-swagger.json")
        .describe("Path where the catch-all Swagger JSON is served."),
      description: z
        .string()
        .default("Catch-all UNS data API")
        .describe("Swagger description for the catch-all endpoint"),
      swaggerTag: z
        .string()
        .default("CatchAll")
        .describe("Swagger tag shown for the catch-all endpoint"),
    })
    .default({
      apiBasePath: "/api/catchall",
      swaggerPath: "/uns-api-global/general-api/catchall-swagger.json",
      description: "Catch-all UNS data API",
      swaggerTag: "CatchAll",
    }),
  lastValueCache: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Enable MQTT subscription and in-memory last-value cache for batch queries",
        ),
      topicRefreshIntervalMs: z
        .number()
        .int()
        .positive()
        .default(30000)
        .describe(
          "Interval for refreshing active topic subscriptions from controller (ms)",
        ),
      staleTtlMs: z
        .number()
        .int()
        .positive()
        .default(86400000)
        .describe(
          "Evict cache entries not updated within this TTL (ms, default 24h)",
        ),
    })
    .default({
      enabled: false,
      topicRefreshIntervalMs: 30000,
      staleTtlMs: 86400000,
    }),
});

export type ProjectExtras = z.infer<typeof projectExtrasSchema>;
