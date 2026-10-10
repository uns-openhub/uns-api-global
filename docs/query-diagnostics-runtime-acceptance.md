# Query diagnostics Runtime acceptance — P2a

## Contract and baseline

Exercise API Global 4.1.13 through the local Caddy/controller 2.1.144 proxy,
with normal controller-issued credentials and real QuestDB. Reuse the single
controller and infra from the archiver acceptance environment; preserve its
7,918-row oracle and all import checkpoints. The archiver remains connected
directly to QuestDB. API-only fault injection uses a local HTTP relay.

Operational evidence must contain verified caller labels, server-generated
request IDs, query/lookup IDs, SQL fingerprints and bounded workload counters.
It must omit credentials, raw SQL, topics and request parameters. Independent
SQL checks establish response correctness; logs alone do not establish it.

| Scenario | Expected result | Status |
| --- | --- | --- |
| Public proxy and normal admin login | Authenticated history, latest and diagnostics accessible | Pass |
| Named machine identity with one topic grant | Its history works; another topic and admin diagnostics fail | Pass |
| Spoofed caller/request headers | Verified identity and new server request ID prevail | Pass |
| History and latest oracle | Original designated time, values and tuple/column contract preserved | Pass |
| Identical concurrent slow history | Exact SQL shared, every request attributable, waiters bounded | Pass |
| Distinct concurrent slow history | Concurrency/queue bounds and safe overload responses | Pass |
| Database failure and recovery | Cooldown suppresses new database work, no retry storm, later recovery | Pass |
| Client disconnect | Observe actual lifetime and bounds; do not infer server-side SQL cancellation | Pass |
| Privacy | Sanitized logs/snapshots exclude topics, raw SQL, credentials and spoofed identities | Pass |

This is local backend/API acceptance, not a UI usability review, replica
capacity benchmark, physical 50-million-file test or production rollout.
No release, publication or production operation is authorized by these tests.


## Results — 10 October 2026

Source baseline: API commit `911bda4` / 4.1.13 with a local route-recognition
fix, published API/core Kit 3.0.22; controller `c694570` / 2.1.144 with the
previous Caddy fix and the new main-thread-only handover preload fix.
All current changes remain uncommitted candidates.

- Public administrator diagnostics initially returned 403 because the toolkit
  `/api` mount left `/catchall/diagnostics/queries`, which was treated as a topic.
  Exact route recognition now handles the mounted/rebased forms without treating
  arbitrary topic suffixes as diagnostics. The real public route returns 200.
- Normal named controller machine identity with `read:uns` and only the
  `motor-01` topic grant: history 200, another topic 403, diagnostics 403;
  invalid bearer 401. Caller-supplied identity/request headers do not become
  trusted diagnostic identity. The returned request ID links to the verified
  machine ID/name and the exact owner query/lookup IDs in the real logs.
- Independent SQL oracle: raw 20-row tuple results preserve numeric values and
  original designated `time`, with `stats.raw.columns`. Latest is value 2000 at
  `2026-10-09T08:33:20Z`. The separate fixture contains 48,000 rows/24 topics.
- Forty simultaneous latest callers (admin and the allowed machine) generated
  one data execution, 39 linked lookup followers and 40 distinct completed HTTP
  request IDs. The subsequent cache hit generated no SQL.
- Thirty identical deduplicated history requests generated one `LATEST ON`:
  nine succeeded, 21 received safe 503 overload responses. The deduplicated
  result matched the expected latest value. Eight SQL followers were observed.
- One hundred cold latest requests generated one data execution: 65 successful
  items and 35 explicit item-level 503 results in the preserved HTTP 200 batch
  envelope. A single shared lookup has one owner plus at most 64 followers.
- Twenty-four distinct requests under test limits **2 concurrent/8 waiting**:
  four succeeded, 20 returned 503; relay peak was two. Queue and active slots
  returned to zero. These counts depend on scheduling, not a promised split.
- Injected upstream 503: 20 subsequent requests generated no additional SQL
  during cooldown. A mixed batch retained its cached value and explicitly
  marked the unavailable item 503. Direct recovery succeeded after cooldown.
- A two-second configured statement timeout returned 503 after about 2013 ms,
  freed the API slot and activated cooldown. The relay still had one pending
  operation: freeing the HTTP slot does not prove server-side SQL cancellation.
  Recovery succeeded. After a browser-like disconnect, one operation continued
  briefly; all API slots and queues were later empty.
- 441 structured diagnostic events checked against token, email, raw topic,
  spoofed identity and upstream error canaries; no tested sensitive marker
  leaked. Snapshot remained bounded to 128 events. Eight slow queries were
  marked. Linked correlation evidence is retained separately; tokens and raw
  Runtime logs are excluded.
- Runtime discovery exposed a second defect: workers inherited the process
  preload and raced on its PID-named launch file. The controller guard now runs
  only in the main thread. A real-process regression runs 12 workers before and
  12 after fencing: workers execute and exit independently, cannot rewrite the
  launch receipt or publish the process exit, and the main process alone records
  its original exit. **46 focused tests and controller typecheck passed**.
- API **211 tests, typecheck and production build passed**. Final real Runtime
  restart has no worker-launch errors; direct and Caddy health both return 200.

[Sanitized results](evidence/query-diagnostics-runtime-2026-10-10.json),
[linked caller/request/query evidence](evidence/query-diagnostics-runtime-correlation-2026-10-10.json).

## Restoration and remaining work

Temporary fault relay stopped; machine identity revoked and deleted. API remains
installed and running on direct local QuestDB with published default limits
**4 concurrent/64 waiting**, normal 20-second statement timeout, no automatic
restart during acceptance. One controller and the existing archiver remain;
all 7,918 prior archiver rows are preserved. The synthetic API fixture remains
for the next slice. No production operation, commit, merge, version bump or
publication occurred.

This completes **P2a proxy/auth and bounded fault acceptance**, not all P2.
Still required: retained multi-source/interval SQL oracles, MQTT arriving during
fallback in the real Runtime, representative replica CPU/I/O/lag measurements,
and an explicit total query budget for the intended number of API processes.
Artificial relay delay is not a production-sized database capacity benchmark.
Client aborts do not cancel handler work immediately, and an API HTTP timeout
cannot establish QuestDB statement cancellation. Plan deployment concurrency
and database-side resource limits with that distinction.

Local harnesses and private credentials live only below the acceptance Runtime
root. Repeat from a cold API cache with a newly issued limited identity; do not
rerun against a production origin or reuse the revoked test token. The scenario
matrix specifies the observable HTTP/SQL/log contract for a future portable
staging harness. No browser usability review was performed in this slice.
