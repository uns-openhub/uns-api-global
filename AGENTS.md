# Agent onboarding

## Start here

- Read `package.json` for supported scripts and runtime requirements.
- Read `config.schema.json` and
  `src/config/project.config.extension.ts` for configuration.
- Read `src/catchall-helpers.ts` before changing query parsing or SQL generation.
- Read `test/catchall-helpers.test.ts` for the expected catch-all contract.
- Read `scripts/test-catchall-local.mjs` before running the integration smoke
  test.

## Verification

Run `pnpm run verify` for the unit tests, typecheck, and production build.
Run `pnpm run test:catchall:local` only when the documented local DataHub,
QuestDB, MQTT, and archived data prerequisites are available.

## Repository rules

- Do not commit `config.json`, `.env`, credentials, tokens, customer topic
  hierarchies, or production endpoints.
- Keep examples under the neutral `enterprise/site/area/line` namespace.
- Preserve the raw tuple response and `stats.raw.columns` compatibility
  contract.
- Keep query range, row, response-size, and access-rule safety limits intact.
- Keep absolute counters as the source of truth; delta responses must remain
  derivable.
- Release tags must match `package.json.version` and contain the `unsDatahub`
  add-on manifest.
