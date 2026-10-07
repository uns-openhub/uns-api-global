# Automation registry and Capture audit recovery

Local implementation on 4.1.11; not yet published. Controller API/grants and
Capture definition JSON contracts remain unchanged.

## Checked definitions

Capture and Trigger registries coalesce refreshes. Token lookup, HTTP request
and response body share a five-second request deadline; generations discard
late responses after stop. Missing/expired credentials and HTTP 401/403 empty
the enabled registry and report degraded dependency health. Queued capture rows
recheck eligibility before publication; an already accepted publication drains,
and the session closes without a new summary after authorization loss.

Transport/5xx/invalid-envelope failures allow the last authenticated snapshot
for at most 120 seconds and never beyond the credential expiry accepted with
that snapshot. A backward clock change also invalidates it. A failed request
with a rotated token does not extend the old credential's accepted expiry.
Authenticated recovery restores only definitions returned by the controller.

## Local audit checkpoints

Capture audit is stored below the directory containing `UNS_CONFIG_PATH`, in
`capture-audit/`. With no explicit path, this is relative to the service working
directory. Controller-managed RTT uses its local instance config directory.

The directory is 0700; files are 0600. Each capture/session has one SHA256-named
JSON checkpoint with stable identity, timestamps and emitted-row counters.
Measurement values and credentials are not stored. Checkpoint writes use a
private temporary file, fsync, rename and directory fsync. The opening checkpoint
precedes activation; each published row updates progress. Open checkpoints remain
on disk even after successful audit delivery so restart can close them truthfully.
Only acknowledgement of the latest final close removes its file. A late response
for an older version cannot delete newer evidence.

Startup converts prior open checkpoints to closed `runtimeRestart` snapshots
without emitting a new data row. Pending closes replay unchanged. The controller's
existing `(captureId,sessionId)` upsert prevents duplicate sessions, preserves
closed status, and takes the greatest row count. POST must return `{ok:true,id}`;
an empty or malformed successful HTTP envelope is not an acknowledgement.

Delivery rereads the current managed service credential and uses a five-second
request deadline. Retry grows from one to at most 30 seconds. Defaults bound
tracked sessions to 1,000, aggregate checkpoint payload to 4 MiB, and each file
to 16 KiB. Evidence is not deleted on capacity, age or delivery failure. Storage
failure pauses new recording and reports degradation. Recovery may require
repairing storage and restarting if startup encountered a corrupt checkpoint.
Retain the original files for reviewed recovery.

Health dependencies `triggers-registry`, `captures-registry` and `capture-audit`
use existing retained service metadata, so the controller's service-health views
show authorization, stale definitions or pending delivery without new credentials
or UI-specific probes.

## Limits

These checkpoints are local to the instance/version directory. Migration,
version upgrade, deletion and cluster failover need a separate reviewed transfer
and retention contract; this change does not replicate audit state across nodes.
MQTT publish and a filesystem write are not one atomic distributed transaction: a
crash in between can leave the checkpoint behind the published data. Counters
describe emitted rows, not an archiver transaction acknowledgement. Previous
missing audit is not reconstructed and exactly-once delivery is not claimed.

Verification: `pnpm run verify` (191 tests, typecheck and build). Local controller
acceptance U3-04f independently reconciled 538 physical rows with two closed audit
sessions (478 + 60), including pending close recovery after runtime restart.
