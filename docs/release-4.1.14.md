# API Global 4.1.14 upgrade notes

Upgrade every controller used for GraphQL/auth/routing to **2.1.145 or newer**
before starting this version. An older controller lacks the self-status and
launch-registration contract; this is not a standalone patch for an old controller.

## Operator changes

- Slow-query diagnostics join a verified caller label, server request ID and
  normalized SQL fingerprint/table/purpose/duration/outcome. Raw SQL, topics,
  parameters and credentials are excluded from diagnostic output. Inspect the
  administrator-only `/api/catchall/diagnostics/queries`; see
  [query diagnostics](questdb-query-diagnostics.md).
- Equivalent latest recovery is coalesced. Queries have bounded concurrency,
  waiting and dependency failure cooldown. HTTP timeout does not prove QuestDB
  has cancelled its SQL; use database-side monitoring and resource controls too.
- `authorization.mode: "controller"` is the default. Signature/expiry verification
  runs on every request, followed by the caller's current self-status. Default
  cache age is 5 seconds. Expired status is never reused on failure; missing or
  failed authority returns 503. Explicit `offline` mode has no immediate
  revocation guarantee. See README for all bounds and standalone HMAC behavior.
- Optional `questdb.queryDiagnostics.deploymentBudget` statically divides the
  total concurrency by declared maximum instances. Enforce that count, including
  handover overlap; this is not a distributed semaphore or process discovery.
- Controller-managed launches renew an owner-local route receipt. MQTT metadata
  cannot replace a current launch proof. Route credentials are not data tokens.
  A legacy launch does not acquire this contract without a reviewed restart.

Preserve current config, stable process/instance identity and old artifacts. Test
latest/raw/batch/history, denied access and public proxy routes after upgrade.
A downgrade in a cluster requires the controller's explicit bounded legacy cold
rollback procedure; a route-cache entry alone is insufficient. Stop the new API
before rolling controllers back below the required contract version.

Synthetic local acceptance supports these contracts and their bounds; it does
not establish production replica capacity, physical failure domains or TLS/ACL
canaries. This file describes the release candidate until its PR is merged and
its exact tagged artifact is verified. Production deployment is a separate step.
