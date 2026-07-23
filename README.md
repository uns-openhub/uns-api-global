# uns-api-global

`uns-api-global` exposes authenticated REST endpoints for current and historical
Unified Namespace (UNS) data. It runs as an UNS DataHub add-on, resolves topic
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
- An UNS DataHub controller and MQTT broker
- QuestDB containing archived UNS data

## Local setup

```bash
corepack enable
pnpm install
cp config-example.json config.json
pnpm run dev
```

`config.json` and `.env` are intentionally ignored. The example configuration
uses environment-backed secret placeholders; set the corresponding variables
locally:

```bash
UNS_PASSWORD=change-me
QUESTDB_PASSWORD=quest
```

For API authentication, configure `uns.jwksWellKnownUrl` (recommended). A local
standalone setup can alternatively provide `UNS_API_JWT_SECRET`.

## Configuration

Project-specific configuration is defined in
`src/config/project.config.extension.ts` and documented by
`config.schema.json`.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Releases

GitHub Releases are the deployment source of truth. A release tag such as
`4.1.0` or `v4.1.0` must match `package.json.version`. The tagged
`package.json` must also contain a compatible `unsDatahub` add-on manifest.
Tag pushes run an automated manifest/version check before normal verification.

## License

MIT © Aljoša Vister. See [LICENSE](LICENSE).
