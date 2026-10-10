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
