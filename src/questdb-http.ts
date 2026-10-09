import { QuestDbRequestError } from "./history-source-diagnostics.js";
import { QueryDiagnostics } from "./query-diagnostics.js";
import { stripDatasetFromQuestDbResponse } from "./catchall-helpers.js";

export class QuestDbQueryError extends QuestDbRequestError {
  readonly status = 503;
  constructor(
    readonly code:
      | "timeout"
      | "http-error"
      | "invalid-response"
      | "connection-error"
      | "cancelled",
    readonly httpStatus?: number,
    missingTable?: string,
  ) {
    super(
      code === "timeout" || code === "cancelled"
        ? "timeout"
        : code === "http-error"
          ? "response"
          : "unavailable",
      httpStatus,
      missingTable ? `table does not exist [table=${missingTable}]` : undefined,
    );
    this.message = `QuestDB query unavailable (${code}). Use the request ID to inspect diagnostics.`;
  }
}

export function queryQuestDbHttp(
  diagnostics: QueryDiagnostics,
  cfg: {
    url: string;
    username: string;
    password: string;
    statementTimeoutMs: number;
  },
  sql: string,
  purpose: string,
  signal?: AbortSignal,
): Promise<{ data: unknown[]; raw: Record<string, unknown> }> {
  // Do not compact whitespace inside SQL literals; it changes exact topic matching.
  const query = sql.trim();
  return diagnostics.query(
    JSON.stringify([
      cfg.url,
      cfg.username,
      cfg.password,
      cfg.statementTimeoutMs,
    ]),
    query,
    purpose,
    async ({ requestId, queryId }) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        cfg.statementTimeoutMs,
      );
      try {
        const url = new URL("/exec", cfg.url);
        url.searchParams.set("query", query);
        url.searchParams.set("timings", "true");
        url.searchParams.set("count", "true");
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`,
            Accept: "application/json",
            "x-request-id": requestId,
            "x-query-id": queryId,
          },
          signal: signal
            ? AbortSignal.any([controller.signal, signal])
            : controller.signal,
        });
        if (!response.ok) {
          // QuestDB errors may echo SQL, topics, parameters or upstream credentials.
          // Preserve only the literal missing-table classification used by history
          // diagnostics. Every other part of the upstream error is discarded.
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (reader) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > 8192) {
                await reader.cancel();
                break;
              }
              chunks.push(value);
            }
          } finally {
            reader?.releaseLock();
          }
          let missingTable: string | undefined;
          if (bytes <= 8192) {
            try {
              const error = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as { error?: unknown };
              if (typeof error.error === "string")
                missingTable =
                  /^table does not exist \[table=([a-zA-Z0-9_-]+)\]$/i.exec(
                    error.error,
                  )?.[1];
            } catch {
              /* discard all unclassified upstream evidence */
            }
          }
          throw new QuestDbQueryError(
            "http-error",
            response.status,
            missingTable,
          );
        }
        const rawText = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          throw new QuestDbQueryError("invalid-response", response.status);
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          (!Array.isArray(parsed) &&
            !Array.isArray((parsed as Record<string, unknown>)["dataset"]))
        ) {
          throw new QuestDbQueryError("invalid-response", response.status);
        }
        const dataset = Array.isArray(parsed)
          ? parsed
          : (parsed as { dataset: unknown[] }).dataset;
        const raw = stripDatasetFromQuestDbResponse(parsed, query);
        const reportedCount =
          typeof raw["count"] === "number" && Number.isFinite(raw["count"])
            ? raw["count"]
            : undefined;
        return {
          value: { data: dataset, raw },
          rows: dataset.length,
          responseBytes: Buffer.byteLength(rawText),
          httpStatus: response.status,
          ...(reportedCount === undefined ? {} : { reportedCount }),
        };
      } catch (error) {
        if (error instanceof QuestDbQueryError) throw error;
        throw new QuestDbQueryError(
          controller.signal.aborted
            ? "timeout"
            : signal?.aborted
              ? "cancelled"
              : "connection-error",
        );
      } finally {
        clearTimeout(timer);
      }
    },
    signal,
  );
}
