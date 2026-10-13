# API Global 4.1.15 release candidate

Automatic history combines legacy and identity-enriched sources safely, retaining
all observations and source provenance. Missing known text identity metadata is
represented by typed NULL; no identity is invented. STRING/VARCHAR/SYMBOL storage
can be aligned without changing string values. Missing or incompatible measurement,
time, path, session and arbitrary table columns still fail explicitly. Numeric
values are not widened or cast, and cross-publisher counter differencing remains
prohibited. Existing authorized legacy path/binding rules and per-source
deduplication remain in effect.

Schema-conflict HTTP 409 diagnostics provide bounded table/column/type details.
A current-source recommendation requires known states and one active table;
ambiguous/unknown state never infers the current writer from version or ordering.
There is no silent fallback that excludes history.

Acceptance: 244 ordinary regressions pass plus the opt-in actual loopback QuestDB
functional test, typecheck and build. Local raw/sampled/entity SQL preserves
values and excludes a different bound entity. No production load testing.

Controller >=2.1.145 remains the declared compatibility; Controller 2.1.159 adds
the paired compact Explore controls and current-source action. No new GraphQL,
database migration or UNS Kit release is required. An older Explore can continue
using successful automatic reads and manual source selection.

GitHub source release only. This task does not deploy a runtime or change
production. Reviewed PR and merged main CI must pass; release tag v4.1.15 must
resolve to the verified merge commit. Existing release workflow creates the tag
and GitHub release after merge. No npm package publication is required because
this is a private-package RTT application distributed from GitHub.

[Detailed acceptance](explore-history-compatibility-acceptance-2026-10-13.md).
