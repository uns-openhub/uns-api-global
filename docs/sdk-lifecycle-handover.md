# SDK lifecycle handover

Published 4.1.23 uses `@uns-kit/*` 3.0.37. Release candidate 4.1.24 pins the
published core/API 3.0.39 packages, including the shared read-only HTTP helper.
Its registry lockfile contains no local SDK overlays. This application candidate
has not yet been released or deployed.

## Application boundary

History API and automation. One process owner covers cache input, trigger output and capture output. Admitted HTTP, trigger/capture work and audit checkpoints finish before snapshot. Trigger edge/cooldown and active capture/session/aggregate/timeout state are preserved. Only automation cache operands move; unrelated read cache remains rebuildable. Target startup cache work settles before the source operands replace it.

Reviewed GET/HEAD and POST batch readers use `runReadOnlyRequest(res, work)`
before starting asynchronous work. Its callback awaits all admitted reads and
cancellation settlement. A disconnected reader cannot poison later drains, and
an early response cannot release ownership while read work is still running.
No write or publication may be declared read-only. The SDK continues to block
undeclared unknown outcomes; the HTTP method alone is never proof of safety.

UNS Kit owns the common owner/readiness, correlation, accepted-work barrier,
HTTP/cron participants and bounded state transport. Controller orchestrates one
durable reviewed operation. Application business logic stays in this repository;
no Controller branch based on this application's name is needed.

## Configuration

The startup configuration examples include the following lifecycle settings.
Merge these fields into the existing `uns` object; retain its process identity,
controller/auth settings and all business configuration:

```json
{
  "uns": {
    "instanceMode": "handover",
    "handover": true,
    "handoverProtocol": "correlated-v2"
  }
}
```

Use the same reviewed process identity on both peers and distinct instance IDs.
Install the integrated application release on the current host first; upgrading
an old non-integrated process may have a brief initial gap. After verifying new
measurements/API responses and archived values, prepare a stopped target with
compatible settings and use Controller's reviewed migration. Never start a
second active copy to bypass a blocked handover.

The SDK 3.0.37 to 3.0.39 upgrade crosses the MQTT format3 boundary introduced in
3.0.38. Review the initial stop-before-start upgrade and any active automation
state separately; the same-version hot check is not a proof of a mixed-format
live upgrade. Keep the old source active if compatibility is refused. Do not
relabel contracts, remove fences or start a second owner to force acceptance.

The application declares readiness after all handlers/routes/proxies are wired.
Configuration alone does not enable an old binary. Normal drain and standalone
SIGINT/SIGTERM use the same shared SDK lifecycle. Return ownership with a reviewed
reverse operation, preserving the existing restart guards and journals.

## Verification and boundaries

The 4.1.24 candidate was verified with the actual published core/API 3.0.39
packages and a frozen registry lockfile. All other package resolutions remain
unchanged, and no workspace/file links or SDK overrides are present. Typecheck,
build and 293 application tests pass; the optional real QuestDB engine test is
not part of that result. The built API HTTP smoke covers grouped and individual
tuple/column equality, authorization before SQL, configured limits, empty periods,
dependency/queue503 errors, cancellation settlement and recovery. Cold multi-table
schemas also work with no waiting slots.

The actual application was installed with production-only dependencies on two
issued Controller 2.2.54 members in one local Linux VM. Both reviewed hot
directions completed using registry SDK packages. An open source read finished
before ownership transfer; aborted batch reads settled SQL; passive targets
returned503. Both deliberately unread migration replies were reconciled under
the same durable operation without changing the target PID. Grouped and
individual history tuples, including times and units, matched before and after
both moves and through the ordinary local public proxy, using normal JWT/JWKS
and authorization-status checks. Earlier configurations and restart protections
were retained and rechecked.

The SQL server returned bounded synthetic responses. This does not prove real
QuestDB commits, active automation sessions, production history or independent
physical-host HA. Same-version hot acceptance does not establish compatibility
for an upgrade across the SDK format boundary described above.

Snapshots are bounded and incompatible/oversized state is refused. Disk queues
need their separate supported drain/transfer contract. Unknown external effects
remain uncertain; a broker without replay/durability cannot promise recovery of
all source events after a crash. A short retryable HTTP/routing gap is possible.

The production-dependency-only install requires `graphql-request` and its
`graphql` peer in runtime dependencies; their existing locked versions are
retained. Existing verified SDK consumers may retain previous versions until
they need the new optional HTTP reader facility.
