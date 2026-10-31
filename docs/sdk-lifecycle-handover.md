# SDK lifecycle handover

Release candidate 4.1.23 using the published `@uns-kit/*` 3.0.37 packages.
This application candidate has not been released or deployed.

## Application boundary

History API and automation. One process owner covers cache input, trigger output and capture output. Admitted HTTP, trigger/capture work and audit checkpoints finish before snapshot. Trigger edge/cooldown and active capture/session/aggregate/timeout state are preserved. Only automation cache operands move; unrelated read cache remains rebuildable. Target startup cache work settles before the source operands replace it.

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

The application declares readiness after all handlers/routes/proxies are wired.
Configuration alone does not enable an old binary. Normal drain and standalone
SIGINT/SIGTERM use the same shared SDK lifecycle. Return ownership with a reviewed
reverse operation, preserving the existing restart guards and journals.

## Verification and boundaries

`pnpm run typecheck` and `pnpm run build` passed in a separate clean directory
using a frozen registry lockfile and the actual npm SDK 3.0.37 packages. Runtime
exports and the final activation-failure guard were checked. Relevant application
regressions passed sequentially; the normal verify script includes these tests.
A separate npm-installed synthetic application verified both hot directions,
unread response/same-operation recovery and exact values on two issued
Controllers 2.2.54. This is not an end-to-end test of this application's external
production databases or side-effect destinations.

Snapshots are bounded and incompatible/oversized state is refused. Disk queues
need their separate supported drain/transfer contract. Unknown external effects
remain uncertain; a broker without replay/durability cannot promise recovery of
all source events after a crash. A short retryable HTTP/routing gap is possible.

SDK 3.0.37 is published and this application's registry lockfile is refreshed.
The review retained all non-SDK direct dependencies and resolved only the SDK
package replacements. No workspace/file links are in the standalone lockfile.
Next, prepare a unique application release and validate the issued artifact
before production rollout. Existing verified SDK consumers may retain their
previous versions until they need these new lifecycle facilities.
