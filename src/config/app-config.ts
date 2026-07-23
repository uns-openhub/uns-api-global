/* Auto-generated. Do not edit by hand. */
export interface ProjectAppConfig {
    uns: {
        graphql: string;
        rest: string;
        /** Bearer token used for service-to-service access to the UNS instance. */
        token?: string | undefined;
        /** Email used when authenticating to graphql endpoint of the UNS instance. */
        email?: string | undefined;
        /** Password or secret value paired with the UNS email. */
        password?: string | undefined;
        instanceMode?: "wait" | "force" | "handover";
        /** Process name used in MQTT topics and logs. */
        processName: string;
        handover?: boolean;
        /** Optional PM2/controller supervisor guard settings for this RTT instance. */
        supervisor?: {
            /** Enable controller/PM2 supervisor handling for this RTT instance. */
            enabled?: boolean;
            /** Let PM2 restart the process when it exits unexpectedly. */
            restartOnExit?: boolean;
            /** Optional PM2 memory restart limit in megabytes. */
            maxMemoryMb?: number | undefined;
            /** Let the controller auto-start this instance when required system-service runtime signals are absent. */
            restartOnUnhealthy?: boolean;
            /** How long runtime signals must stay unhealthy before the controller supervisor can act. */
            unhealthyAfterMs?: number;
            /** Minimum time between controller supervisor restart attempts for this instance. */
            restartCooldownMs?: number;
        } | undefined;
        jwksWellKnownUrl?: string | undefined;
        kidWellKnownUrl?: string | undefined;
        env?: "dev" | "staging" | "test" | "prod";
    };
    logging?: {
        adapter?: string;
        host: string;
        port?: number;
        level?: "error" | "warn" | "info" | "http" | "verbose" | "debug" | "silly";
    } | undefined;
    input?: {
        host?: string | undefined;
        hosts?: string[] | undefined;
        servers?: {
            host: string;
            port?: number | undefined;
            protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        }[] | undefined;
        port?: number | undefined;
        protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        username?: string | undefined;
        password?: string | undefined;
        clientId?: string | undefined;
        clean?: boolean | undefined;
        keepalive?: number | undefined;
        connectTimeout?: number | undefined;
        reconnectPeriod?: number | undefined;
        reconnectOnConnackError?: boolean | undefined;
        resubscribe?: boolean | undefined;
        queueQoSZero?: boolean | undefined;
        rejectUnauthorized?: boolean | undefined;
        properties?: {
            sessionExpiryInterval?: number | undefined;
            receiveMaximum?: number | undefined;
            maximumPacketSize?: number | undefined;
            topicAliasMaximum?: number | undefined;
            requestResponseInformation?: boolean | undefined;
            requestProblemInformation?: boolean | undefined;
            userProperties?: {
                [x: string]: string;
            } | undefined;
        } | undefined;
        ca?: string | undefined;
        cert?: string | undefined;
        key?: string | undefined;
        servername?: string | undefined;
    } | undefined;
    output?: {
        host?: string | undefined;
        hosts?: string[] | undefined;
        servers?: {
            host: string;
            port?: number | undefined;
            protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        }[] | undefined;
        port?: number | undefined;
        protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        username?: string | undefined;
        password?: string | undefined;
        clientId?: string | undefined;
        clean?: boolean | undefined;
        keepalive?: number | undefined;
        connectTimeout?: number | undefined;
        reconnectPeriod?: number | undefined;
        reconnectOnConnackError?: boolean | undefined;
        resubscribe?: boolean | undefined;
        queueQoSZero?: boolean | undefined;
        rejectUnauthorized?: boolean | undefined;
        properties?: {
            sessionExpiryInterval?: number | undefined;
            receiveMaximum?: number | undefined;
            maximumPacketSize?: number | undefined;
            topicAliasMaximum?: number | undefined;
            requestResponseInformation?: boolean | undefined;
            requestProblemInformation?: boolean | undefined;
            userProperties?: {
                [x: string]: string;
            } | undefined;
        } | undefined;
        ca?: string | undefined;
        cert?: string | undefined;
        key?: string | undefined;
        servername?: string | undefined;
    } | undefined;
    infra: {
        host?: string | undefined;
        hosts?: string[] | undefined;
        servers?: {
            host: string;
            port?: number | undefined;
            protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        }[] | undefined;
        port?: number | undefined;
        protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        username?: string | undefined;
        password?: string | undefined;
        clientId?: string | undefined;
        clean?: boolean | undefined;
        keepalive?: number | undefined;
        connectTimeout?: number | undefined;
        reconnectPeriod?: number | undefined;
        reconnectOnConnackError?: boolean | undefined;
        resubscribe?: boolean | undefined;
        queueQoSZero?: boolean | undefined;
        rejectUnauthorized?: boolean | undefined;
        properties?: {
            sessionExpiryInterval?: number | undefined;
            receiveMaximum?: number | undefined;
            maximumPacketSize?: number | undefined;
            topicAliasMaximum?: number | undefined;
            requestResponseInformation?: boolean | undefined;
            requestProblemInformation?: boolean | undefined;
            userProperties?: {
                [x: string]: string;
            } | undefined;
        } | undefined;
        ca?: string | undefined;
        cert?: string | undefined;
        key?: string | undefined;
        servername?: string | undefined;
    };
    devops?: {
        provider?: "azure-devops";
        organization: string;
        project?: string | undefined;
    } | undefined;
    questdb: {
        /** Base URL for QuestDB HTTP API (e.g. http://questdb:9000) */
        url: string;
        /** QuestDB HTTP username (Basic Auth) */
        username: string;
        /** QuestDB HTTP password (Basic Auth) */
        password: string;
        /** Default row limit for data queries */
        defaultLimit?: number;
        /** Maximum allowed row limit for data queries */
        maxLimit?: number;
        /** Default lookback window (hours) when no from/to is supplied */
        defaultLookbackHours?: number;
        /** Maximum allowed lookback window (hours) for raw queries */
        maxLookbackHours?: number;
        /** Maximum allowed lookback window (hours) for sampled maxPoints/bucketMs queries */
        maxSampleLookbackHours?: number;
        /** Timeout in milliseconds for QuestDB HTTP requests */
        statementTimeoutMs?: number;
        /** Maximum allowed scan rows reported by QuestDB query metadata */
        maxScanRows?: number;
        /** Maximum JSON payload bytes returned by catch-all endpoint */
        maxResponseBytes?: number;
    };
    /** Topic scoping for both QuestDB history queries and the MQTT last-value cache. Each entry defines an MQTT topic filter pattern. Topics not matching any entry are rejected. Similar to uns-archiver dataStorage — supports # and + wildcards. */
    dataSources?: {
        /** MQTT topic filter pattern (supports # and + wildcards, e.g. 'enterprise/#') */
        topic: string;
        /** QuestDB table name prefix for history queries (optional — falls back to controller mapping resolution) */
        tablePrefix?: string | undefined;
        /** Enable QuestDB history queries for topics matching this pattern */
        history?: boolean;
        /** Enable MQTT last-value cache for topics matching this pattern */
        cache?: boolean;
    }[];
    catchAll?: {
        /** Path prefix exposed for the catch-all API (avoid /api to not clash with controller). */
        apiBasePath?: string;
        /** Path where the catch-all Swagger JSON is served. */
        swaggerPath?: string;
        /** Swagger description for the catch-all endpoint */
        description?: string;
        /** Swagger tag shown for the catch-all endpoint */
        swaggerTag?: string;
    };
    lastValueCache?: {
        /** Enable MQTT subscription and in-memory last-value cache for batch queries */
        enabled?: boolean;
        /** Interval for refreshing active topic subscriptions from controller (ms) */
        topicRefreshIntervalMs?: number;
        /** Evict cache entries not updated within this TTL (ms, default 24h) */
        staleTtlMs?: number;
    };
}

export interface AppConfig extends ProjectAppConfig {}

type GeneratedProjectAppConfig = ProjectAppConfig;
type GeneratedAppConfig = AppConfig;

declare module "@uns-kit/core/config/app-config.js" {
  interface ProjectAppConfig extends GeneratedProjectAppConfig {}
  interface AppConfig extends GeneratedAppConfig {}
}
