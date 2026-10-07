import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CaptureRegistry } from "../src/captures/registry.js";
import { TriggerRegistry } from "../src/triggers/registry.js";
import { CaptureService } from "../src/captures/service.js";
import { CapturePublisher } from "../src/captures/publisher.js";
import {
  CaptureAuditOutbox,
  type AuditEvent,
} from "../src/captures/audit-outbox.js";
import { sendCaptureAudit } from "../src/captures/audit-transport.js";

const capture = {
  id: "u314-capture",
  name: "Recovery",
  enabled: true,
  startCondition: { source: "always" },
  stopCondition: { source: "never" },
  inputMappings: [
    {
      topic: "u314/input",
      columnName: "temperature",
      sourceType: "data",
      uomMode: "inherit",
      required: false,
    },
  ],
  outputTopic: "u314/output",
  captureConfig: {
    windowMode: "alwaysOn",
    modes: [
      { type: "onChange", driverTopics: ["u314/input"] },
      { type: "summary" },
    ],
    missingValuePolicy: "null",
    maxSessionMs: null,
    includeTechnicalColumns: true,
  },
  createdAt: "2026-10-07T00:00:00Z",
  updatedAt: "2026-10-07T00:00:00Z",
};
const trigger = {
  id: "u314-trigger",
  name: "Recovery",
  kind: "high",
  enabled: true,
  sourceTopic: "u314/input",
  outputTopic: "u314/trigger",
  config: { threshold: 10 },
  createdAt: capture.createdAt,
  updatedAt: capture.updatedAt,
};
const event: AuditEvent = {
  eventType: "started",
  captureId: capture.id,
  captureName: capture.name,
  sessionId: "u314-session",
  outputTopic: capture.outputTopic,
  startedAt: capture.createdAt,
  rowCount: 0,
};
const jwt = (expiry: number) =>
  "test." +
  Buffer.from(JSON.stringify({ exp: expiry })).toString("base64url") +
  ".test";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

for (const [label, Registry, key, row] of [
  ["captures", CaptureRegistry, "captures", capture],
  ["triggers", TriggerRegistry, "triggers", trigger],
] as const) {
  function setup() {
    let now = 1_000_000,
      token: string | null = jwt(2000),
      status = 200,
      rows = [row],
      calls = 0;
    let implementation = async () => {
      calls++;
      return new Response(JSON.stringify({ [key]: rows }), { status });
    };
    const registry = new Registry({
      controllerRestUrl: "http://controller/api",
      getAccessToken: async () => token,
      now: () => now,
      maxStaleMs: 120_000,
      requestTimeoutMs: 20,
      refreshIntervalMs: 60_000,
      fetchImpl: (() => implementation()) as typeof fetch,
    });
    return {
      registry,
      now: (value: number) => (now = value),
      token: (value: string | null) => (token = value),
      status: (value: number) => (status = value),
      rows: (value: typeof rows) => (rows = value),
      calls: () => calls,
      fetch: (fn: typeof implementation) => (implementation = fn),
    };
  }
  for (const failure of ["missing", "expired", 401, 403] as const)
    test(`${label}: ${failure} invalidates cached enabled definitions and current recovery never restores disabled rules`, async () => {
      const s = setup();
      await s.registry.refresh();
      assert.equal(s.registry.size(), 1);
      if (failure === "missing") s.token(null);
      else if (failure === "expired") s.token(jwt(900));
      else s.status(failure);
      await s.registry.refresh();
      assert.equal(s.registry.size(), 0);
      assert.equal(s.registry.getHealth().healthy, false);
      s.token(jwt(2000));
      s.status(200);
      s.rows([]);
      await s.registry.refresh();
      assert.equal(s.registry.size(), 0);
      assert.equal(s.registry.getHealth().healthy, true);
      s.registry.stop();
    });
  test(`${label}: 5xx cache grace is bounded by successful token expiry and clock rollback`, async () => {
    const s = setup();
    s.token(jwt(1050));
    await s.registry.refresh();
    s.token(jwt(2000));
    s.status(503);
    await s.registry.refresh();
    assert.equal(s.registry.size(), 1);
    assert.equal(s.registry.getHealth().healthy, false);
    s.now(1_050_000);
    assert.equal(s.registry.size(), 0);
    s.status(200);
    await s.registry.refresh();
    s.now(1_170_000);
    assert.equal(s.registry.size(), 0);
    await s.registry.refresh();
    s.now(1_160_000);
    assert.equal(s.registry.size(), 0);
    s.registry.stop();
  });
  test(`${label}: malformed envelopes and hanging transport are bounded and degraded`, async () => {
    const s = setup();
    await s.registry.refresh();
    s.fetch(async () => new Response("{}"));
    await s.registry.refresh();
    assert.equal(s.registry.size(), 1);
    assert.equal(s.registry.getHealth().healthy, false);
    s.fetch(() => new Promise(() => {}));
    await s.registry.refresh();
    assert.equal(s.registry.size(), 1);
    s.now(1_120_000);
    assert.equal(s.registry.size(), 0);
    s.registry.stop();
  });
  test(`${label}: refreshes coalesce and a late stopped generation cannot overwrite recovery`, async () => {
    const s = setup(),
      old = deferred<Response>();
    s.fetch(() => old.promise);
    const pending = s.registry.refresh();
    assert.equal(s.registry.refresh(), pending);
    s.registry.stop();
    s.rows([]);
    s.fetch(async () => new Response(JSON.stringify({ [key]: [] })));
    await s.registry.refresh();
    old.resolve(new Response(JSON.stringify({ [key]: [row] })));
    await pending;
    assert.equal(s.registry.size(), 0);
    assert.equal(s.registry.getHealth().healthy, true);
    s.registry.stop();
  });
}

async function outbox(
  t: test.TestContext,
  send: (event: AuditEvent) => Promise<void>,
  extra: Partial<ConstructorParameters<typeof CaptureAuditOutbox>[0]> = {},
) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "u314-audit-"));
  const box = new CaptureAuditOutbox({
    directory,
    send,
    retryMinMs: 60_000,
    ...extra,
  });
  t.after(async () => {
    await box.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await box.start();
  return { box, directory };
}
test("outbox: acknowledged open checkpoint survives restart, closes same identity and removes only acknowledged close", async (t) => {
  const sent: AuditEvent[] = [];
  const { box, directory } = await outbox(t, async (e) => {
    sent.push(e);
  });
  await box.enqueue({ ...event, rowCount: 3 });
  await box.flush();
  assert.equal(box.pendingCount(), 0);
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  assert.equal(
    (await fs.stat(path.join(directory, files[0]!))).mode & 0o777,
    0o600,
  );
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  await box.stop();
  const recovered = new CaptureAuditOutbox({
    directory,
    send: async (e) => {
      sent.push(e);
    },
    retryMinMs: 60_000,
  });
  t.after(() => recovered.stop());
  await recovered.start();
  await recovered.flush();
  assert.equal((await fs.readdir(directory)).length, 0);
  assert.equal(sent.at(-1)!.closeReason, "runtimeRestart");
  assert.equal(sent.at(-1)!.rowCount, 3);
  assert.equal(sent.at(-1)!.sessionId, event.sessionId);
});
test("outbox: failed delivery retains durable progress/close and replay uses latest monotonic snapshot", async (t) => {
  let unavailable = true;
  const sent: AuditEvent[] = [];
  const { box, directory } = await outbox(t, async (e) => {
    if (unavailable) throw Error("401");
    sent.push(e);
  });
  await box.enqueue({ ...event, rowCount: 5 });
  await box.flush();
  assert.equal(box.health().healthy, false);
  assert.equal(box.canRecord(), true);
  assert.equal(box.pendingCount(), 1);
  await box.enqueue({
    ...event,
    eventType: "closed",
    endedAt: capture.updatedAt,
    rowCount: 4,
    closeReason: "authorizationUnavailable",
  });
  await box.enqueue({ ...event, rowCount: 99 });
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(directory, (await fs.readdir(directory))[0]!),
        "utf8",
      ),
    ).event.rowCount,
    5,
  );
  unavailable = false;
  await box.flush();
  assert.equal(box.pendingCount(), 0);
  assert.equal(box.health().healthy, true);
  assert.equal(sent[0]!.eventType, "closed");
  assert.equal(sent[0]!.rowCount, 5);
});
test("outbox: old acknowledgement cannot delete a newer close checkpoint", async (t) => {
  const ack = deferred<void>();
  const sent: AuditEvent[] = [];
  const { box, directory } = await outbox(t, async (e) => {
    sent.push(e);
    if (sent.length === 1) await ack.promise;
  });
  await box.enqueue(event);
  const flushing = box.flush();
  while (!sent.length) await new Promise((r) => setImmediate(r));
  await box.enqueue({
    ...event,
    eventType: "closed",
    endedAt: capture.updatedAt,
    rowCount: 2,
  });
  ack.resolve();
  await flushing;
  assert.equal((await fs.readdir(directory)).length, 1);
  await box.flush();
  assert.equal(sent.at(-1)!.rowCount, 2);
  assert.equal(box.pendingCount(), 0);
});
test("outbox: capacity preserves evidence and storage failure pauses recording until recovery", async (t) => {
  const { box, directory } = await outbox(
    t,
    async () => {
      throw Error("503");
    },
    { maxSessions: 1 },
  );
  await box.enqueue(event);
  await assert.rejects(box.enqueue({ ...event, sessionId: "other" }));
  assert.equal(box.canRecord(), false);
  assert.equal((await fs.readdir(directory)).length, 1);
  const checkpoint = (await fs.readdir(directory))[0]!;
  await fs.rename(directory, directory + "-saved");
  await assert.rejects(box.enqueue({ ...event, rowCount: 1 }));
  assert.equal(box.canRecord(), false);
  await fs.rename(directory + "-saved", directory);
  await box.flush();
  assert.equal(
    JSON.parse(await fs.readFile(path.join(directory, checkpoint), "utf8"))
      .event.rowCount,
    1,
  );
});
test("outbox: corrupt checkpoints fail closed without erasing the file", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "u314-corrupt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "a".repeat(64) + ".json"), "corrupt");
  const box = new CaptureAuditOutbox({ directory, send: async () => {} });
  await assert.rejects(box.start());
  assert.equal(box.canRecord(), false);
  assert.equal((await fs.readdir(directory)).length, 1);
});
test("audit transport: each retry rereads current credential, rejects false acknowledgements and bounds hung token lookup", async () => {
  let token = "old",
    status = 401;
  const seen: string[] = [];
  const opts = {
    controllerRestUrl: "http://controller/api",
    event,
    getAccessToken: async () => token,
    timeoutMs: 20,
    fetchImpl: (async (_url, init) => {
      seen.push((init!.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ ok: true, id: "audit-id" }), {
        status,
      });
    }) as typeof fetch,
  };
  await assert.rejects(sendCaptureAudit(opts));
  token = "new";
  status = 202;
  await sendCaptureAudit(opts);
  assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
  await assert.rejects(
    sendCaptureAudit({
      ...opts,
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    }),
  );
  await assert.rejects(
    sendCaptureAudit({ ...opts, getAccessToken: () => new Promise(() => {}) }),
  );
});
test("capture: auth loss drains accepted row, skips queued rows and unauthorized summary, closes exact audit count", async () => {
  let status = 200;
  const sent: string[] = [];
  const audit: AuditEvent[] = [];
  const accepted = deferred<void>();
  const registry = new CaptureRegistry({
    controllerRestUrl: "http://controller/api",
    getAccessToken: async () => "opaque",
    refreshIntervalMs: 60_000,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ captures: [capture] }), {
        status,
      })) as typeof fetch,
  });
  const service = new CaptureService({
    registry,
    publisher: new CapturePublisher({
      publish: async ({ payload }) => {
        sent.push(payload);
        await accepted.promise;
      },
    }),
    getLastValue: () => ({
      value: 10,
      values: { value: 10 },
      uom: "°C",
      time: capture.createdAt,
      receivedAt: 0,
    }),
    auditSession: (e) => {
      audit.push(e);
    },
  });
  await service.start();
  const first = service.onMessage({ topic: "u314/input" }),
    second = service.onMessage({ topic: "u314/input" });
  while (!sent.length) await new Promise((r) => setImmediate(r));
  status = 401;
  const refresh = registry.refresh();
  while (registry.size()) await new Promise((r) => setImmediate(r));
  accepted.resolve();
  await Promise.all([first, second, refresh]);
  assert.equal(sent.length, 1);
  assert.equal(audit.at(-1)!.eventType, "closed");
  assert.equal(audit.at(-1)!.rowCount, 1);
  assert.equal(audit.at(-1)!.closeReason, "authorizationUnavailable");
  service.stop();
});
test("capture: concurrent opening checkpoints cannot duplicate sessions or reopen after auth loss", async () => {
  let status = 200;
  const persisted = deferred<void>();
  const audit: AuditEvent[] = [];
  const registry = new CaptureRegistry({
    controllerRestUrl: "http://controller/api",
    getAccessToken: async () => "opaque",
    refreshIntervalMs: 60_000,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ captures: [capture] }), {
        status,
      })) as typeof fetch,
  });
  const service = new CaptureService({
    registry,
    publisher: new CapturePublisher({ publish: () => {} }),
    getLastValue: () => null,
    auditSession: async (e) => {
      audit.push(e);
      if (e.eventType === "started") await persisted.promise;
    },
  });
  const starting = service.start();
  while (!audit.length) await new Promise((r) => setImmediate(r));
  const opening = service.onMessage({ topic: "u314/input" });
  status = 403;
  registry.stop();
  persisted.resolve();
  await Promise.all([starting, opening]);
  assert.equal(audit.filter((e) => e.eventType === "started").length, 1);
  assert.equal(audit.at(-1)!.eventType, "closed");
  assert.equal(service.getRuntimeStates().filter((s) => s.active).length, 0);
  service.stop();
});
