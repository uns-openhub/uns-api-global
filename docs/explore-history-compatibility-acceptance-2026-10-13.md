# Explore history compatibility acceptance

Scope: safe automatic history across legacy and identity-enriched tables, clear
manual recovery for incompatible sources, and compact Explore source controls.
Baseline: Controller 2.1.158 and API Global 4.1.14 in isolated worktrees.
Production is inspected only for bounded schema/registry metadata. Tests use
synthetic topics/tables and loopback services. No production history mutations.

## Scenarios

- Same schema/different order: automatic union preserves both observations.
- Legacy versus enriched identity schema: typed missing metadata, preserved values,
  time and source provenance; raw and sampled reads execute on local QuestDB.
- Missing/type-conflicting value, time, path, session or arbitrary Table columns:
  fail explicitly without dropping a source or changing values.
- Identity reads keep existing legacy path/binding restriction and reject partial
  identity schemas; counter delta across publishers remains prohibited.
- One known active source on conflict: explicit current-source action; ambiguous
  active sources: choose a source, never infer newest/current from version.
- Diagnostic payload carries only bounded table/column/type metadata, no SQL,
  topic parameters, endpoints or credentials. Authorization remains before discovery.
- Compact healthy source strip, expandable details, visible conflict recovery,
  independent overlay selection/retry, cancellation and saved explicit selections.
- Actual Angular browser: hidden table gives chart space, show table restores it,
  keyboard chart sizing, narrow/short layout, error then successful explicit source.

Results and limitations will be appended after execution.

## Results

- API: 244 regression tests pass; one optional real-QuestDB test skips in the
  ordinary suite and passes separately against a disposable loopback QuestDB.
- Real QuestDB: legacy/enriched raw reads preserve both values and provenance;
  sampled sum is correct; identity reads preserve authorized legacy path fallback
  and exclude a different bound entity. Synthetic tables are removed afterward.
- Explore: 41 tests pass (source evidence/recovery, layout, SQL export), including
  bounded diagnostic parsing, no source discovery after 403, independent streams,
  source cancellation and saved selections. API typecheck/build pass.
- Actual Angular browser with synthetic HTTP: visible unique-current recovery,
  ambiguous-source selector, per-column conflict details, successful explicit read,
  hide/show table, keyboard sizing, narrow/short viewport and no console errors.
- Full production Angular build passes with the existing 1.46 MB initial bundle
  warning (1.41 MB warning threshold); no new build error.

## Compatibility policy

All shared measurement/payload, time, UNS path and session columns must remain
present. Numeric differences are rejected rather than widened with possible
precision loss. STRING/VARCHAR/SYMBOL storage is normalized losslessly to STRING.
Only known text identity enrichment (fullTopic, stableEntityId, entityTypeKey,
identityResolution, identityTimeBasis, identityBindingRevision, identityBindingDigest)
may be absent in legacy sources, represented by typed NULL. Partial identity
schemas and unknown types are rejected; no identity is fabricated. Filtering
occurs after projection so legacy identity predicates work without missing-column
errors. Existing authorized path/binding restrictions and per-source deduplication
remain; overlaps are preserved. Cross-publisher counter differencing still fails.
No mapping or stored data migration is performed.

409 diagnostics include bounded candidate table/column/type metadata and an
explicit current-table recommendation only when all source states are known and
exactly one table is active. Unknown or multiple active states never use version,
registration order or name to infer the current writer. Explicit selection is
visible and reads only that table; it is not a silent partial-history fallback.

## Release boundary

Release candidate API 4.1.15, based on API 4.1.14; paired UI candidate is
Controller 2.1.159 over 2.1.158. Publication is authorized after successful CI.
Production deployment remains excluded from this release task.
API and controller require separate reviewed releases; no new GraphQL/DB contract
or UNS Kit release is required. Browser uses actual Angular with synthetic HTTP,
not a full controller/PG/MQTT stack; actual SQL is verified separately on local
QuestDB. No production business queries or load tests were executed.
