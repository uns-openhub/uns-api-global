# P2b retained history, MQTT fallback and deployment query budget

Acceptance contract, 10 October 2026. Reuse one controller2.1.144, real
PostgreSQL/MQTT/QuestDB/Caddy, API4.1.13 and autonomous archiver5.2.20.
Preserve the archiver12830-row oracle, completed imports and stopped5.2.17.
No release, publication or production changes.

- Publish synthetic mapping revisions through the real retained MQTT contract;
  confirm active and retired history with authenticated controller GraphQL.
- Query two compatible physical sources and compare raw and interval/deduplicated
  results with an independent SQL oracle, including original timestamps and
  source provenance. Explicit table override remains available.
- Test latest across retained sources, equal-time contradiction, incompatible
  schemas and unsupported cross-source counter delta: report conflicts honestly.
- Delay a real QuestDB latest fallback, publish MQTT during it, verify the
  fresh MQTT value survives completion and the subsequent cache lookup avoids SQL.
- Establish an explicit conservative deployment budget across a declared maximum
  number of API processes. Per-process semaphores do not establish a distributed
  lease or enforce the number of deployed instances. Test allocations, invalid
  configurations and simultaneous independent budget holders.
- Restore direct QuestDB, ordinary dataSources/config, no relay, one API process;
  verify core health, existing rows/checkpoints and privacy of sanitized evidence.
- Add a controller/microservice GraphQL compatibility matrix and coordinated
  production upgrade/rollback plan. Validate actual available old/new operations
  against the candidate schema. Unknown production binaries remain inventory
  prerequisites, never inferred compatible from package version alone.

## Results — 10 October 2026

Local P2b acceptance passed through the authenticated administrator/Caddy path.
Five mapping topics have five active and five retired physical sources, published
through the real retained MQTT contract. Raw point history returns six observations
with original timestamps and source provenance, equal to independent SQL.
Existing dedupe selects one latest point per physical source (values20/30), not
one row per numeric interval counter. The initial test incorrectly expected
11/21/30; it was corrected against the documented policy and an independent
per-table latest SQL oracle. No dedupe implementation or source policy changed.

An actual gap was fixed: auto temporal resolution now accepts interval-only
schemas when no point time exists. Point time retains priority when present;
explicit timestamp mode still rejects interval-only tables. Runtime used a
separate copy of temporal logic; it now delegates to the tested helper. Four
interval rows preserve start/end times, and latest selects value44 by start then
end ordering. Raw union, per-source dedupe, latest30 and original time, explicit
old table3rows, cross-source delta409, equal-time latest conflict409 and
incompatible schema409 all passed against real QuestDB.

For the MQTT race, the initial fixture was absent from the UNS subscription
inventory and therefore could not exercise delivery. The corrected preparation
adds the Attribute after startup and waits for actual topic subscription refresh,
so startup SQL seeding cannot pre-warm the race. MQTT999 arriving during the
400ms delayed real SQL read wins over archive202; the response preserves original
MQTT time. One fallback data execution, zero follow-up cache SQL executions.
Diagnostic snapshots omit topic, token, email and raw SQL; recent events57,
active0/queued0 at inspection.

The optional deployment allocation sets total2/maxInstances2 to one slot per
process. Two independent OS processes sent12 requests to a synthetic HTTP sink:
observed peak2. This tests the compiled limiter across processes, not two fully
deployed APIs or a distributed coordinator. Unknown observed process count stays
null. Operators must enforce the declared process maximum, including overlapping
handover processes; independent database clients are outside this budget.

Verification:216 API tests, typecheck/build;5 controller audit-helper tests.
Generated config schema/app-config includes the optional budget. Restored original
API config/directQuestDB9000, stopped temporary relay. One controller and API;
archiver PID72864 unchanged, old5.2.17 stopped/desiredRunning=false, all9 imports
completed. Existing archiver oracle remains12830 rows/12830 distinct event IDs;
core API/archiver healthy. No commit, version, PR, release or production operation.

Evidence: [runtime](evidence/query-retained-runtime-2026-10-10.json),
[process budget](evidence/query-process-budget-2026-10-10.json),
[restoration](evidence/query-retained-restored-2026-10-10.json).
The controller production plan includes actual old/new GraphQL shape validation;
static compatibility is not live authorization/response acceptance.

Remaining: representative replica capacity, production filesystem/volume with
physical50M entries, full continuous-MQTT ownership boundary, staging old binary
compatibility and production cutover/rollback. These are separate rollout gates.
