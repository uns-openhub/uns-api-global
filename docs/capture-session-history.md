# Capture session history contract

Candidate addition, not a published release. Optional `sessionId` on a topic
GET or `POST /api/catchall/batch/range` (JSON body) restricts history to that
exact Capture session. The predicate is combined with the normally authorized
UNS topic and selected time range before limits, aggregates, sampling or delta.
Existing response, range and scan limits still apply; no rights are granted.

Identifiers must be 1–128 characters: letters/digits followed by letters/digits,
period, underscore, colon or hyphen. Invalid identifiers return 400. A selected
source without a `sessionId` column fails explicitly instead of ignoring the
restriction. A valid unmatched id returns an empty successful history result.
Batch range requires explicit topics; session filtering with entity selectors
is rejected. Latest-value batch mode rejects the field, because its MQTT cache
has no session-specific history contract.

Consumers should keep the full id with fixed start/end bounds in saved recipes,
SQL displays and exports, and avoid live/latest-value fallbacks on an empty
filtered history response. Audit emission counts are not archive acknowledgements.

Local U3-04g acceptance: three HEATING/IDLE sessions, 20 rows each, 60 physical
and 60 audited rows. Broad-window single reads returned only the selected 20;
invalid/missing-column reads returned 400 and anonymous access returned 401.
All 192 API tests, typecheck and production build passed. No publication.
