# uns-api-global

`uns-api-global` exposes authenticated REST endpoints for current and historical
Unified Namespace (UNS) data. It runs as an UNS OpenHub add-on, resolves topic
paths to QuestDB tables, and can combine persisted history with an MQTT-backed
last-value cache.

## Capabilities

- Query one UNS attribute by its full topic path.
- Fetch current values or time ranges for multiple topic paths.
- Return raw rows, summaries, or bucketed numeric series.
- Derive boundary-aware deltas from absolute counter history.
- Inspect trigger and capture runtime state.
- Enforce `read:uns` scopes and path access rules.
- Publish service metadata and dependency health to the DataHub controller.

The default API base path is `/api/catchall`. Its OpenAPI document is registered
at `/uns-api-global/general-api/catchall-swagger.json`.

## Requirements

- Node.js 22 or newer
- pnpm 10
- An UNS OpenHub controller and MQTT broker
- QuestDB containing archived UNS data

## Configuration profiles

The service ships three topology-specific profiles. They contain no deployment
credentials or customer endpoints.

| Profile | Use it when | MQTT and QuestDB | Service credential |
| --- | --- | --- | --- |
| `config-development-host.json` | Running the service directly with `pnpm run dev` on the host | `localhost` | `UNS_SERVICE_TOKEN` from untracked `.env` |
| `config-development-podman.json` | Deploying through a local Podman OpenHub controller | Compose DNS: `mosquitto`, `questdb` | Controller-managed `UNS_SERVICE_TOKEN_FILE` |
| `config-production.json` | Creating a production controller instance | Compose/Runtime DNS: `mosquitto`, `questdb` | Controller-managed `/run` token file |

The Podman and production profiles intentionally share their internal network
names: in both cases the RTT process runs alongside the controller. The
production profile sets `uns.env` to `prod` and is only a safe starting point;
the controller copies it into a per-instance configuration that is retained
across add-on releases.

## Direct host development

```bash
corepack enable
pnpm install
cp config-development-host.json config.json
cp .env.example .env
# Set UNS_SERVICE_TOKEN in .env to a development machine token.
pnpm run dev
```

For a controller-managed local Podman or production installation, deploy the
add-on from **Micro services** and select the matching profile. Do not copy the
repository `.env` into that instance. `input` and `output` inherit all broker
settings from `infra`; add either section only to override a specific channel.

The QuestDB password has a separate lifecycle from the service credential: set
`QUESTDB_PASSWORD` in `.env` only for direct host development. A controller-managed
Podman or production process must receive it from the controller environment or its
approved secret provider, never from the profile or an instance `config.json`.

`config.json` and `.env` are intentionally ignored. A directly started development
process uses a dedicated machine token:

```bash
UNS_SERVICE_TOKEN=your-development-machine-token
QUESTDB_PASSWORD=quest
```

Controller authentication resolves the controller-managed `UNS_SERVICE_TOKEN_FILE`
first, then `UNS_SERVICE_TOKEN`, `uns.token`, and only then legacy
`uns.email`/`uns.password`. The legacy credentials are retained solely for bootstrap
or replacement of a development machine token; they are not part of either committed
configuration profile. None of the committed profiles requires an email or password.

For API authentication, configure `uns.jwksWellKnownUrl` (recommended). A local
standalone setup can alternatively provide `UNS_API_JWT_SECRET`; when those
HMAC tokens are not issued by the controller, explicitly choose the offline mode
described below. The controller status endpoint accepts controller-verifiable JWTs.

### Caller revocation (upgrade candidate)

Catch-all data reads, batch reads and protected runtime/diagnostic endpoints first
verify JWT signature and expiry on every request. They then check the caller's own
status with `POST <uns.rest>/auth/token-status`. This contract requires controller
**2.1.145 or newer**; upgrading the API alone against an older controller fails
closed with HTTP 503. Roll out the controller before this API candidate.

`authorization.mode` defaults to `controller`, with `statusCacheMs: 5000` (allowed
250–30000 ms). A cached positive status can remain usable until its expiry after a
revocation; JWT expiry still applies immediately. Concurrent requests using the
same token share one status check. Checks have a 1500 ms timeout, at most four
concurrent calls, no waiting queue, 1024 cached token digests and a one-second
failure cooldown. Expired positive status is never reused on authority errors.
Revoked/deleted/inactive principals or changed machine token versions are denied.
The endpoint returns only self-status; it cannot inspect another identity.

Explicit `authorization.mode: "offline"` supports standalone JWT validation and
emits a startup warning. It cannot enforce identity revocation before JWT expiry.
There is no automatic offline fallback on timeout, 404, bad JSON or database error.
The administrator diagnostics response includes non-secret authorization counters
and limits, without tokens or cache digests. These checks do not control MQTT
shutdown or the independent microservice lifecycle.

## Configuration

Project-specific configuration is defined in
`src/config/project.config.extension.ts` and documented by
`config.schema.json`.

- `authorization` sets controller status checking or explicit offline JWT mode.
- `questdb` configures the QuestDB HTTP endpoint and safety limits.
- `dataSources` limits which MQTT topic filters may be queried or cached.
- `catchAll` controls the public paths and OpenAPI labels.
- `lastValueCache` controls MQTT-backed current-value caching.

Controller topic discovery shares one active refresh, with a five-second transport
deadline. Timeout or discovery failure keeps the previous subscriptions; a late
response cannot replace them. A still-pending credential/transport operation holds
the gate rather than accumulating new requests on each timer tick. Normal refresh
resumes after it settles. Reordered discovery rows do not change subscriptions;
only added or removed topics are sent to MQTT. Diagnostics report state transitions without raw server
response bodies or credentials.

Trigger/Capture registry refreshes also release their request signals and unread
response bodies on every outcome, including authorization denial. Denied access
still clears executable definitions. An optional synthetic loopback diagnostic is
available after building: `node --expose-gc scripts/test-registry-retention-local.mjs`.
It reports retained heap after 2,000 requests; it is not a CI memory threshold or
a production stability guarantee.

Regenerate the schema after changing the configuration contract:

```bash
pnpm run generate-config-schema
```

Refresh canonical UNS metadata from a controller with:

```bash
pnpm run sync-uns-schema
pnpm run sync-uns-metadata
```

## API overview

- `GET /api/catchall/{topicPath}` queries one full UNS attribute path.
- `POST /api/catchall/batch/last` returns the latest values for multiple paths.
- `POST /api/catchall/batch/range` returns range data for multiple paths.
- `GET /api/catchall/triggers/runtime` reports trigger runtime state.
- `GET /api/catchall/captures/runtime` reports capture runtime state.

Raw mode returns tuple rows with column metadata. `summaryOnly=true` returns a
full-range summary. `bucketMs` or `maxPoints` returns an ascending sampled
series, with `aggregate=avg|min|max|last|sum|count`.

### Identity history consistency

Batch range requests can address an Asset with `entitySelectors` containing its
`stableEntityId` and exact relative `attributePath`. A saved identity view should
send `bindingConsistency: "current"`: the API then obtains current temporal
bindings from the controller, bypassing both fresh-cache and stale-on-error
fallback. It still checks caller access to every resolved path before reading.
The bounded response acknowledges `stats.bindingConsistency: "current"` and
`stats.bindingSource: "controller"`. A controller outage fails the request.

Omitted/`cached` consistency preserves existing cache behavior. A client requiring
current authority must reject an absent or different acknowledgement from an
older runtime. This concerns identity binding consistency; it does not guarantee
that upstream observations have already reached the archive.

## Development

```bash
pnpm test
pnpm run typecheck
pnpm run build
pnpm run verify
```

The optional controller-backed smoke test requires a running local DataHub
stack and source topics containing data:

```bash
CATCHALL_TEST_LOGIN_PASSWORD=change-me \
CATCHALL_TEST_TOPICS='enterprise/site/area/line/motor-1/equipment/main/current,enterprise/site/area/line/motor-1/equipment/main/voltage' \
pnpm run test:catchall:local
```

The identity-writer rollback smoke needs only a disposable local QuestDB. It
writes one identity-enriched row, then emulates the previous Archiver writer by
writing a second row without optional identity columns. The current dual reader
must return both rows through their half-open binding intervals. The temporary
table is removed whether the smoke passes or fails.

```bash
QUESTDB_ROLLBACK_TEST_URL=http://localhost:9000 \
pnpm run test:identity-writer-rollback:local
```

Set `QUESTDB_ROLLBACK_TEST_USERNAME` and `QUESTDB_ROLLBACK_TEST_PASSWORD` when
the disposable QuestDB requires Basic authentication. This smoke is intentionally
not part of `pnpm run verify`, because it performs short-lived database writes.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Releases

GitHub Releases are the deployment source of truth. A release tag such as
`4.1.0` or `v4.1.0` must match `package.json.version`. The tagged
`package.json` must also contain a compatible `unsDatahub` add-on manifest.
Tag pushes run an automated manifest/version check before normal verification.

## License

MIT © Aljoša Vister. See [LICENSE](LICENSE).

Data Catalog identity current-value cards also use `bindingConsistency: "current"`
on batch/last. It bypasses binding-plan cache and stale fallback and acknowledges
the same controller authority. Entity latest-value cache entries must be within
the original binding validity interval; the two-millisecond current-plan lookup
window is not the observation's validity window. A previous occupant's value
before a reused path's new binding is not reassigned to the new Asset. This does
not claim a fresh measurement: the response retains observation timestamp/age.


### Bounded cold-cache recovery (4.1.19)

Latest-value batch recovery rotates through cache misses within the existing
20-candidate per-request budget. Empty leading paths therefore do not repeatedly
exclude later archived values in a stable batch. Interleaved authorized request
lists have independent cursors, with a bounded 256-entry LRU of fingerprints;
no topic strings, caller identities, tokens or values are stored in that scheduler.
An evicted cursor restarts, so this is not a liveness guarantee under unbounded
request churn. Authorization, query throttling/coalescing, database concurrency,
row/range/response limits and raw tuple columns remain unchanged.

This also helps Controller 2.2.13 recover complete material operation declarations
from archive after startup. The API treats their scalar JSON as opaque data; it
does not approve relationships or infer missing outputs. Demo 6.1.23 requires the
Controller's manifest-aware reader even when the API is upgraded first. API
4.1.19 keeps its existing Controller compatibility range (>=2.1.145 <3).


### Bounded complete Raw exports

Since 4.1.20, the `exportWindow=half-open` option on GET `/api/catchall/<topic>`
uses `[from,to)` UTC point-time bounds. Supply explicit ISO `from`/`to`,
`dedupe=false` and a bounded `limit`. It cannot be combined with sampling,
summary or delta transformation. Fractional bounds retain their precision.
`stats.exportWindow=half-open` confirms this contract; `stats.truncated` uses
one-row SQL lookahead while returning at most the configured maxLimit. A
truncation reported by the upstream response also marks the window incomplete.
Existing access, range, scan, response size, timeout and query budgets apply.
Disconnecting the response cancels that export request's active read.

Clients can collect disjoint bounded windows and split incomplete windows,
retaining only complete pages. Preserve all equal-time observations; do not use
`last timestamp + 1ms` as a cursor. An unsplittable full timestamp group must
fail explicitly rather than download an incomplete result. These separate reads
are not a transactionally frozen database snapshot; keep historical data stable
during export. Existing non-export requests retain their inclusive time bounds.

Deploy this API capability before a Controller that requires its completeness
proof for Raw Excel export. An older Controller remains compatible.

Version 4.1.20 uses UNS Kit 3.0.25. Controller 2.2.15 Raw Excel export requires
this API version or newer; deploy the API before using that export. The existing
Controller compatibility range remains unchanged for other consumers.
