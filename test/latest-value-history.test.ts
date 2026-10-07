import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLatestHistorySql,
  selectArchivedLatest,
  preserveConcurrentCacheValue,
  LatestLookupCoordinator,
  LatestLookupError,
} from "../src/latest-value-history.js";
import {
  combineHistorySchemas,
  HistorySourceError,
  HISTORY_SOURCE_COLUMN,
} from "../src/history-table-source.js";
import {
  resolveTemporalStrategy,
  type TableSchema,
} from "../src/catchall-helpers.js";
const topic = "enterprise/site/area/line/motor/equipment/main/temperature";
const names = [
  "time",
  "topic",
  "asset",
  "objectType",
  "objectId",
  "attribute",
  "valueType",
  "numberValue",
  "stringValue",
  "value",
  "uom",
];
const schema = (time = "time"): TableSchema => {
  const columns = names.map((n) => (n === "time" ? time : n));
  return {
    columns: new Set(columns),
    orderedColumns: columns,
    columnTypes: new Map(
      columns.map((n) => [
        n,
        n === time ? "TIMESTAMP" : n === "numberValue" ? "DOUBLE" : "STRING",
      ]),
    ),
  };
};
const temporal = resolveTemporalStrategy(schema(), "auto");
const columns = [
  "time",
  "numberValue",
  "stringValue",
  "value",
  "uom",
  HISTORY_SOURCE_COLUMN,
];
const row = (
  time: string,
  n: unknown,
  string: unknown = null,
  value: unknown = null,
  table = "old_data",
  uom: unknown = "C",
) => [time, n, string, value, uom, table];

test("latest union uses canonical time, both sources, path scope and one bounded global ordering", () => {
  const combined = combineHistorySchemas(
    ["old_data", "new_data"],
    [schema(), schema()],
  );
  const sql = buildLatestHistorySql(
    combined.source,
    topic,
    combined.schema,
    temporal,
  );
  assert.match(sql, /UNION ALL/);
  assert.match(sql, /"time" DESC, "__historySourceTable" ASC LIMIT 65/);
  assert.match(sql, /"objectId" = 'main'/);
  assert.match(sql, /"attribute" = 'temperature'/);
  assert.doesNotMatch(sql, /LATEST ON|"time" >=|"time" <=/);
  assert.equal(sql.match(/LIMIT/g)?.length, 1);
});
test("legacy timestamp and interval mode retain their ordering contract", () => {
  const legacy = schema("timestamp");
  assert.match(
    buildLatestHistorySql(
      "old_data",
      topic,
      legacy,
      resolveTemporalStrategy(legacy, "auto"),
    ),
    /"timestamp" DESC/,
  );
  const interval: TableSchema = {
    columns: new Set(["topic", "intervalStart", "intervalEnd", "numberValue"]),
    orderedColumns: ["topic", "intervalStart", "intervalEnd", "numberValue"],
    columnTypes: new Map([
      ["topic", "STRING"],
      ["intervalStart", "TIMESTAMP"],
      ["intervalEnd", "TIMESTAMP"],
      ["numberValue", "DOUBLE"],
    ]),
  };
  const strategy = resolveTemporalStrategy(interval, "interval");
  assert.match(
    buildLatestHistorySql("old_data", topic, interval, strategy),
    /"intervalStart" DESC, "intervalEnd" DESC/,
  );
  const hit = selectArchivedLatest(
    ["intervalStart", "intervalEnd", "numberValue"],
    [
      ["2026-01-01T00:00:00Z", "2026-01-01T00:00:03Z", 3],
      ["2026-01-01T00:00:00Z", "2026-01-01T00:00:04Z", 4],
    ],
    strategy,
  );
  assert.equal(hit?.values.value, 4);
});
test("newest archived value is independent of source/registry result order", () => {
  const rows = [
    row("2026-01-01T00:00:00Z", 44.5),
    row("2026-01-02T00:00:00Z", 2050.25, null, null, "new_data"),
  ];
  for (const rs of [rows, [...rows].reverse()]) {
    const v = selectArchivedLatest(columns, rs, temporal);
    assert.equal(v?.values.value, 2050.25);
    assert.deepEqual(v?.selectedTables, ["new_data"]);
    assert.equal(v?.receivedAt, Date.parse("2026-01-02T00:00:00Z"));
  }
});
test("microsecond differences do not become an artificial conflict", () => {
  const hit = selectArchivedLatest(
    columns,
    [
      row("2026-01-01T00:00:00.000001Z", 1),
      row("2026-01-01T00:00:00.000002Z", 2),
    ],
    temporal,
  );
  assert.equal(hit?.values.value, 2);
});
test("timezone offsets describe the same instant", () => {
  assert.throws(
    () =>
      selectArchivedLatest(
        columns,
        [
          row("2026-01-01T01:00:00.123456+01:00", 1),
          row("2026-01-01T00:00:00.123456Z", 2),
        ],
        temporal,
      ),
    /different values/,
  );
});
test("numeric zero, empty string and boolean false are real latest values", () => {
  for (const [n, str, value, want] of [
    [0, null, null, 0],
    [null, "", null, ""],
    [null, null, false, false],
    [null, null, "text", "text"],
  ] as const)
    assert.equal(
      selectArchivedLatest(
        columns,
        [row("2026-01-01T00:00:00Z", n, str, value)],
        temporal,
      )?.values.value,
      want,
    );
});
test("typed string does not become a numeric default from another column", () => {
  assert.equal(
    selectArchivedLatest(
      ["time", "valueType", "numberValue", "stringValue"],
      [["2026-01-01T00:00:00Z", "string", 0, "Ready"]],
      temporal,
    )?.values.value,
    "Ready",
  );
});
test("table payload excludes history and identity provenance", () => {
  const hit = selectArchivedLatest(
    [
      "time",
      "batchId",
      "state",
      "stableEntityId",
      "identityResolution",
      HISTORY_SOURCE_COLUMN,
    ],
    [["2026-01-01T00:00:00Z", "b1", "Ready", "id", "resolved", "new_table"]],
    temporal,
  );
  assert.deepEqual(hit?.values, { batchId: "b1", state: "Ready" });
  assert.deepEqual(hit?.selectedTables, ["new_table"]);
});
test("same-time identical payloads keep both source names", () => {
  const hit = selectArchivedLatest(
    columns,
    [
      row("2026-01-01T00:00:00Z", 1),
      row("2026-01-01T00:00:00Z", 1, null, null, "new_data"),
    ],
    temporal,
  );
  assert.deepEqual(hit?.selectedTables, ["new_data", "old_data"]);
});
test("same-time value or unit disagreement fails explicitly", () => {
  for (const changed of [
    row("2026-01-01T00:00:00Z", 2),
    row("2026-01-01T00:00:00Z", 1, null, null, "new_data", "F"),
  ])
    assert.throws(
      () =>
        selectArchivedLatest(
          columns,
          [row("2026-01-01T00:00:00Z", 1), changed],
          temporal,
        ),
      HistorySourceError,
    );
});
test("bounded ties do not hide an uninspected conflict", () => {
  assert.throws(
    () =>
      selectArchivedLatest(
        columns,
        Array.from({ length: 65 }, () => row("2026-01-01T00:00:00Z", 1)),
        temporal,
      ),
    /too many/,
  );
  const rs = [
    ...Array.from({ length: 64 }, () => row("2026-01-01T00:00:00Z", 1)),
    row("2025-12-31T00:00:00Z", 2),
  ];
  assert.equal(selectArchivedLatest(columns, rs, temporal)?.values.value, 1);
});
test("empty result is a miss; invalid archived timestamp is an error", () => {
  assert.equal(selectArchivedLatest(columns, [], temporal), null);
  assert.throws(
    () => selectArchivedLatest(columns, [row("bad", 1)], temporal),
    LatestLookupError,
  );
  assert.throws(
    () => selectArchivedLatest(["numberValue"], [[1]], temporal),
    LatestLookupError,
  );
});
test("concurrent MQTT or another successful fill survives late database completion", () => {
  const live = { value: 3 };
  const archive = { value: 2 };
  assert.deepEqual(preserveConcurrentCacheValue(live, archive), {
    entry: live,
    inserted: false,
  });
  assert.deepEqual(preserveConcurrentCacheValue(undefined, archive), {
    entry: archive,
    inserted: true,
  });
});
test("seed and lazy recovery share one in-flight lookup", async () => {
  let calls = 0;
  let release!: (v: number) => void;
  const coordinator = new LatestLookupCoordinator<number>();
  const load = () => {
    calls++;
    return new Promise<number>((r) => {
      release = r;
    });
  };
  const a = coordinator.run("topic", load);
  const b = coordinator.run("topic", load);
  await Promise.resolve();
  release(7);
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
  assert.equal(calls, 1);
});
test("negative cache and explicit errors are throttled then recover", async () => {
  let now = 0,
    calls = 0;
  const c = new LatestLookupCoordinator<number>({ now: () => now });
  const miss = async () => {
    calls++;
    return null;
  };
  await c.run("missing", miss);
  await c.run("missing", miss);
  assert.equal(calls, 1);
  now = 5001;
  await c.run("missing", miss);
  assert.equal(calls, 2);
  const conflict = async () => {
    calls++;
    throw new HistorySourceError("conflict");
  };
  await assert.rejects(c.run("conflict", conflict), HistorySourceError);
  await assert.rejects(c.run("conflict", conflict), HistorySourceError);
  assert.equal(calls, 3);
  now = 10002;
  assert.equal(await c.run("conflict", async () => 9), 9);
});
test("lookup error cache is bounded and does not expose raw dependency errors", async () => {
  const c = new LatestLookupCoordinator<number>({ maxFailures: 2 });
  for (const topic of ["a", "b", "c"]) await c.run(topic, async () => null);
  assert.equal(c.failureCount, 2);
  await assert.rejects(
    c.run("secret", async () => {
      throw new Error("credential=private");
    }),
    (error) =>
      error instanceof LatestLookupError && !error.message.includes("private"),
  );
});
test("hanging lookup is aborted and returns bounded recoverable failure", async () => {
  let signal!: AbortSignal;
  const c = new LatestLookupCoordinator<number>({ timeoutMs: 10 });
  await assert.rejects(
    c.run("hang", async (s) => {
      signal = s;
      return new Promise<number>(() => {});
    }),
    /timed out/,
  );
  assert.ok(signal.aborted);
});
test("pending concurrency cap rejects extra work but coalesces existing work", async () => {
  const c = new LatestLookupCoordinator<number>({ maxPending: 1 });
  let release!: (v: number) => void;
  const a = c.run(
    "a",
    () =>
      new Promise<number>((r) => {
        release = r;
      }),
  );
  await Promise.resolve();
  const same = c.run("a", async () => 99);
  await assert.rejects(
    c.run("b", async () => 2),
    /busy/,
  );
  release(1);
  assert.deepEqual(await Promise.all([a, same]), [1, 1]);
});

test("mapped table columns named value/numberValue/uom stay values; archiver metadata stays separate", () => {
  const columns = [
    "time",
    "value",
    "numberValue",
    "uom",
    "batchId",
    "eventId",
    "deletedAt",
    "createdAt",
    "expiresAt",
    "foreignEventKey",
    HISTORY_SOURCE_COLUMN,
  ];
  const hit = selectArchivedLatest(
    columns,
    [
      [
        "2026-01-01T00:00:00Z",
        0,
        12,
        "kg",
        "b1",
        "event",
        "time",
        "time",
        "time",
        "foreign",
        "new_table",
      ],
    ],
    temporal,
    "table",
  );
  assert.deepEqual(hit?.values, {
    value: 0,
    numberValue: 12,
    uom: "kg",
    batchId: "b1",
  });
  assert.equal(hit?.packetShape, "table");
  assert.equal(hit?.uom, null);
});
