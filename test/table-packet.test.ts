import assert from "node:assert/strict";
import test from "node:test";
import { tableColumnsToLastValues } from "../src/table-packet.js";

test("projects canonical table values and trimmed UoMs", () => {
  assert.deepEqual(
    tableColumnsToLastValues({
      power: { type: "double", value: 42.1, uom: " kW " },
      state: { type: "symbol", value: "RUNNING" },
      missing: { type: "double", value: null },
    }),
    {
      power: 42.1,
      power_uom: "kW",
      state: "RUNNING",
      missing: null,
    },
  );
});

test("does not reinterpret legacy arrays at the application boundary", () => {
  assert.deepEqual(
    tableColumnsToLastValues([
      { name: "power", type: "double", value: 42.1, uom: "kW" },
    ]),
    {},
  );
});
