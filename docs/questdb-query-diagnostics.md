# QuestDB query attribution and workload protection

## Development and release boundary

Release candidate **4.1.13** is based on released API **4.1.12**, commit
`fbf3ede3a0952ab0958214978628d1d7246e2e95`, with the diagnostics/workload
changes applied as a separate delta. Retained history mappings
(`QuestDBMappings(includeHistory: true)`), multi-source history, latest-value
recovery and automation recovery remain from that released baseline. The earlier
4.1.11 development snapshot is retained only as historical evidence.

The declared supported controller baseline is **2.1.144 or newer, below 3**.
Controller main at `4ae108d5c05d7bd9456988461f5526dfa6bba466` already contains
the required history contract. No new controller runtime code is required for
this slice. Upgrade the controller before installing this API where an older
controller is still deployed. Old production controller 2.1.138 is not a target;
there is no legacy mapping fallback. Package versions and source/CI evidence do
not by themselves approve a production rollout.

The controller signs user subjects and machine identity IDs/names and forwards
the bearer token. API Global verifies the signature before using the caller
label. No unsigned caller header or new identity-forwarding protocol is needed.
The safe toolkit HTTP logger is required because earlier toolkit versions logged
URLs and unverified decoded emails before the API handler could redact them.

UNS kit 3.0.22 was published on 2026-10-09. This API now declares minimum
API/core package versions `^3.0.22`, with both packages locked to npm 3.0.22.
Verification used a fresh registry installation and `pnpm install
--frozen-lockfile`, with no local toolkit links. Startup rejects the old logger;
the safe logger prerequisite passed against the installed published API package.

## Source findings: old incident versus current development

These are source observations, not retrospective attribution of the production
incident:

| Path | Released 4.1.11 incident paths | Latest development behavior retained here |
| --- | --- | --- |
| Cache startup seed | Table-wide `LATEST ON` over subscribed topic/interval partitions | Four workers recover individual topics through the shared latest coordinator |
| `batch/last` cache miss | Interval-deduplicating `LATEST ON`; up to 20 fallbacks per call; attempt throttle can expire during slow reads | Topic-scoped ordering across retained history sources, `LIMIT 65` for equal-time tie checking; one lookup per topic, five-second owner deadline; bounded followers |
| History and `batch/range` | Deduplication and batches can multiply expensive SQL | Existing interval deduplication still uses `LATEST ON`; global database concurrency/queue limits now cover all execution paths |
| Schema discovery | Duplicate cold `SHOW COLUMNS` requests | Ordinary requests can share identical SQL; separately cancellable lookup owners remain isolated |

Latest-value ordering already existed in the latest development baseline; this
slice adds diagnostics, request/query attribution and global workload protection
around it. Equal-time conflicts, source completeness, sparse old readings and
fresh MQTT values retain their existing behavior. A bounded returned row count
is not proof that database scanning is cheap: benchmark representative tables
before claiming a measured performance improvement.

Existing incident logs cannot reconstruct the authenticated caller-to-query
chain reliably. Collect new evidence during controlled staging/rollout before
choosing further SQL or index changes.

## Operator workflow

1. Obtain `x-request-id` from the failing/slow HTTP response (browser Network,
   Swagger, or integration response headers). It is server-generated; an
   incoming caller-supplied request ID cannot forge the evidence chain.
2. Search structured logs by `requestId`. `http.completed` identifies the
   authenticated caller, operation, duration, query counts, cache hits/misses,
   throttled misses, failures, coalesced requests and workload rejections.
3. `query.started` identifies an actual execution by `queryId`, SQL shape
   fingerprint, target tables, purpose, queue wait and active/queued counts.
   `query.completed` adds execution duration, outcome, slow marker, returned
   rows, response bytes and available HTTP status. The safe correlation IDs
   are also sent to QuestDB in HTTP headers; QuestDB may not record them itself.
4. For a query still running, open the authenticated **administrator-only**
   `GET /api/catchall/diagnostics/queries` endpoint from Swagger. It returns
   current executions with elapsed durations, queue/concurrency limits,
   cooldown state, lifetime counters and the last 128 diagnostic events.
   This endpoint performs no QuestDB query. Snapshots are process-local and
   reset after restart; durable evidence remains in the configured logs.
5. Group by `caller.id`, `operation`, `purpose` and `fingerprint` to determine
   whether a client is polling history, recovering cache misses, or sharing
   an existing query. Follow `query.coalesced.queryId` to the owner execution.

Latest lookups also carry `lookupId`: `lookup.joined` links each waiting caller's
request ID to `lookup.started`; schema/data query events carry the same lookup
ID. This preserves attribution when sharing happens above the SQL execution
layer. No topic is used as a public lookup identifier.

Example safe fields (there is deliberately no SQL or topic):

```json
{
  "event": "query.completed",
  "requestId": "a server-generated UUID",
  "queryId": "an execution UUID",
  "caller": { "kind": "machine", "id": "an identity UUID", "name": "integration-one" },
  "operation": "batch-last",
  "purpose": "latest-fallback",
  "database": "history-replica",
  "queryType": "history",
  "tables": ["uns_data"],
  "fingerprint": "a normalized SQL hash",
  "outcome": "ok",
  "durationMs": 1200,
  "slow": true
}
```

An older service token minted on behalf of a user identifies that user rather
than a unique external application. Shared tokens therefore remain
indistinguishable: issue a separate named machine identity per integration.
Non-opaque subjects such as email addresses are hashed; emails, token contents,
token hashes, access rules, body/query parameters and raw SQL are not logged.
Machine names are included only when they match the conservative label syntax.

`reportedCount` is QuestDB's reported count, **not a measured physical scan
count**. HTTP diagnostics do not measure database CPU, RAM, I/O or replica lag.
Correlate those separately with database monitoring. Successful API responses
retain their existing authorized Show SQL / tuple / columns contract; that
information is not copied into operational logs or diagnostic snapshots.

## Workload controls

Optional configuration with backward-compatible defaults:

```json
{
  "questdb": {
    "queryDiagnostics": {
      "databaseLabel": "history-replica",
      "maxConcurrent": 4,
      "maxQueued": 64,
      "queueTimeoutMs": 1000,
      "slowQueryMs": 1000,
      "failureCooldownMs": 5000
    }
  }
}
```

- The semaphore covers all QuestDB HTTP calls in the API process, including
  startup seed, latest fallback, history, schema and health probes.
- Ordinary exact in-flight SQL/database/credential/timeout matches share execution.
  Independently cancelled latest lookup owners remain separate at the SQL layer;
  callers for the same topic instead share the complete latest lookup. Both
  sharing layers retain caller/request links and independent result objects. SQL fingerprints never serve as result keys:
  different topics/ranges can have the same normalized shape.
- Coalescing follows per-request topic/entity authorization. It does not
  authorize a caller or cache arbitrary historical results after completion.
- SQL queue and SQL followers share the configurable waiting bound. Latest
  lookup followers have a separate global bound of 64 (with at most 20 lookup
  owners); their overload is reported as a recoverable item failure. SQL queue
  overflow/deadline returns a safe `503`. Batch responses keep the
  existing envelope; unavailable latest-value items explicitly carry
  `status: 503` and an error instead of silently reporting an ordinary miss.
- Timeouts, connection failures and upstream HTTP 5xx activate a short cooldown
  for new and queued work. There is no automatic SQL retry loop.
- Concurrent latest requests join the pending lookup. Negative results/errors
  are throttled and counted. Fresh MQTT values arriving during fallback are
  preserved. Cancelling an owner removes queued work and aborts its HTTP fetch;
  cancellation does not start a database-failure cooldown or cancel another owner.
- Limits are per process, not cluster-wide. Multiple API instances multiply
  the total ceiling. Client HTTP abort does **not** prove database execution
  was cancelled; server-side statement/resource controls are still needed.
- History deduplication, interval ordering, sparse old latest values, access
  rules, lookback and response-size contracts remain intact. Removing `LATEST
  ON` indiscriminately could change interval semantics. Choose a SQL optimization
  only after the new evidence identifies its path and a representative database
  benchmark verifies identical results and lower cost.

## Verification and rollout

Run `pnpm run verify`. New tests cover SQL-shape redaction, caller privacy,
cross-request attribution, exact-query coalescing, topic/database isolation,
concurrency/queue deadlines, cooldown and recovery, bounded snapshots, cache
counters and actual loopback HTTP execution/failures/timeouts. Kit tests verify
that middleware omits URL/token/email and logs completion/disconnect once.

No production database queries or deployment are part of this verification.
The latest integration passed 210 tests, typecheck and build with both the local
built toolkit and, subsequently, the npm-installed kit 3.0.22. The safe logger
startup prerequisite also passed against the installed published package.
Configuration schema regeneration produced no additional changes.
Loopback HTTP tests include preserved history-source error classification and
independent cancellation; coordinator tests link joined callers to schema/data
executions. This is not live controller-to-API acceptance.

Toolkit publication, API dependency locking and registry-package verification are
complete. The source release candidate is API 4.1.13 with controller 2.1.144 or
newer. Merging its version PR creates a Git tag and GitHub source release via
the repository workflow; that does not verify an installed Runtime artifact.
In staging, exercise the actual controller → API proxy/auth path, browser headers,
administrator-only Swagger endpoint, partial batch failures and representative
multi-source/interval history. Then approve a coordinated production upgrade,
compare caller/query-family rates and replica metrics, and tune from evidence.
Keep the prior controller/API artifact pair together for rollback.


## Local Runtime acceptance follow-up

P2a now verifies the normal controller-issued identity and Caddy proxy path,
real history/latest SQL oracles, query/lookup attribution, bounded overload,
cooldown and timeout recovery. The mounted diagnostics route bug was fixed.
See [Runtime acceptance](query-diagnostics-runtime-acceptance.md) for measured
results, controller worker-preload fix and remaining multi-source/replica work.
This follow-up is uncommitted candidate evidence, not an issued release or
production load test; it supersedes the earlier no-live-acceptance statement
only for the explicit P2a scope.


## Optional deployment allocation (P2b, not yet released)

```json
{"questdb":{"queryDiagnostics":{"maxConcurrent":4,"maxQueued":8,
  "deploymentBudget":{"totalMaxConcurrent":2,"maxInstances":2}}}}
```

The effective per-process limit is the smaller of maxConcurrent and
floor(totalMaxConcurrent/maxInstances). totalMaxConcurrent must be at least
maxInstances; invalid or zero-slot allocations reject startup. Without this
optional object the existing per-process defaults remain. Diagnostics expose the
static plan/per-process limit and observedProcessCount:null. Every deployed API
must use the same declared plan and the operator must cap instance count,
including overlapping handover processes. Older APIs and other DB clients do
not participate. This is not a distributed semaphore or automatic enforcement.
Per-process maxQueued remains unchanged; plannedMaxQueued reports its product
with the declared maximum. No GraphQL change is required for this option.

[Retained history and MQTT Runtime acceptance](query-retained-runtime-acceptance.md)
records216 tests/typecheck/build, actual local interval-only bug/fix and restored
Runtime state. Two OS processes verify the compiled limiter against a synthetic
HTTP sink; `node scripts/test-query-budget-processes.mjs` runs after build.
Production replica capacity and old-binary auth compatibility remain rollout gates.
