import test from "node:test";
import assert from "node:assert/strict";
import { requireSafeRequestLogging } from "../src/query-diagnostics-prerequisites.js";

test("unsafe older HTTP logging blocks startup rather than leaking topics and unverified identity", () => {
  assert.throws(
    () => requireSafeRequestLogging({}),
    /@uns-kit\/api >=3\.0\.22/,
  );
  assert.throws(
    () => requireSafeRequestLogging({ SAFE_REQUEST_LOGGING_VERSION: 0 }),
    /safe request logging/,
  );
  assert.doesNotThrow(() =>
    requireSafeRequestLogging({ SAFE_REQUEST_LOGGING_VERSION: 1 }),
  );
});
