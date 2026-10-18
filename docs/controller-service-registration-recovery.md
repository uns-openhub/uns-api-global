# Controller registration during startup interruption

Release candidate API Global 4.1.18, based on 4.1.17. Publication is gated on the reviewed PR and successful CI; this note does not claim production deployment.

A controller-managed API may start while its controller is temporarily unavailable. Previously the awaited service registration could throw before cache and automation initialization, leaving earlier HTTP/MQTT work running while later initialization never happened.

The existing registration call now runs through a small coalescing lifecycle helper. A failed attempt does not abort the remaining initialization. The existing 30-second dependency-health timer retries; the underlying controller client retains its bounded timeout. State transitions use constant log messages without response bodies or credentials. Managed instances still require controller configuration; authorization and route ownership remain enforced normally.

Local acceptance, 17–18 October 2026:

- Separate controller, broker, database and scoped synthetic namespace.
- Started the API and interrupted only its controller. Registration initially failed, then succeeded without another API restart.
- Trigger/Capture registries returned to healthy status. Previously disabled definitions remained unregistered after recovery.
- A previously closed Capture session retained seven audit rows and seven physical archive rows. The same session-scoped history request returned HTTP 200 and all seven rows after recovery; the normal UI reopened the same session.
- Recovery poll completed after 34.2 seconds. This includes waiting for existing timers and is not a performance SLA.
- `pnpm run verify`: 257 tests, 256 pass, one skip; typecheck and build pass.
- Temporary local workload credentials were revoked and owned test processes stopped. No production operation.

The Controller companion branch contains the UI acceptance, sanitized synthetic evidence and a separate local/prerelease telemetry-version alias fix. Numeric production tags were already supported; the alias fix must not be confused with the API startup initialization defect.
