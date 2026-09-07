import assert from "node:assert/strict";
import test from "node:test";
import { ControllerEntityBindingClient } from "../src/entity-binding-client.js";

const resolved = (topic: string, revision = "7") => ({
  topic,
  asOf: null,
  status: "resolved",
  stableEntityId: "11111111-1111-4111-8111-111111111111",
  entityTypeKey: "openhub.asset",
  bindingKind: "attribute-topic",
  matchedPath: topic,
  timeBasis: "source-event-time",
  sourceCount: 1,
  revision,
  digest: `sha256:${"1".repeat(64)}`,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("batches concrete topics, authenticates, and caches revisioned resolutions", async () => {
  let now = 1_000;
  const calls: Array<{ headers: HeadersInit | undefined; body: string }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push({ headers: init?.headers, body: String(init?.body) });
    const variables = JSON.parse(String(init?.body)).variables as { topics: string[] };
    return jsonResponse({
      data: { ResolveEntityObservationBindings: variables.topics.map((topic) => resolved(topic)) },
    });
  };
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
    now: () => now,
    cacheTtlMs: 1_000,
  });

  const first = await client.resolveTopics(["site/press-14/status", "/site/press-14/status/"]);
  assert.equal(first.source, "controller");
  assert.equal(first.resolutions.length, 1);
  assert.equal(first.resolutions[0]?.revision, "7");
  assert.match(JSON.stringify(calls[0]?.headers), /Bearer service-token/);

  now += 500;
  const second = await client.resolveTopics(["site/press-14/status"]);
  assert.equal(second.source, "cache");
  assert.equal(calls.length, 1);
});

test("uses bounded stale cache during a temporary controller failure", async () => {
  let now = 1_000;
  let fail = false;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (fail) throw new Error("controller unavailable");
    const variables = JSON.parse(String(init?.body)).variables as { topics: string[] };
    return jsonResponse({ data: { ResolveEntityObservationBindings: variables.topics.map((topic) => resolved(topic)) } });
  };
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
    now: () => now,
    cacheTtlMs: 100,
    staleIfErrorMs: 1_000,
  });
  await client.resolveTopics(["site/press-14/status"]);

  fail = true;
  now += 200;
  const fallback = await client.resolveTopics(["site/press-14/status"]);
  assert.equal(fallback.source, "stale-cache");

  now += 1_000;
  await assert.rejects(() => client.resolveTopics(["site/press-14/status"]), /controller unavailable/);
});

test("omits controller-filtered paths and rejects unsafe or oversized requests", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ data: { ResolveEntityObservationBindings: [] } });
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
  });
  const filtered = await client.resolveTopics(["restricted/site/asset/value"]);
  assert.deepEqual(filtered.resolutions, []);
  await assert.rejects(() => client.resolveTopics(["site/+/value"]), /concrete/);
  await assert.rejects(
    () => client.resolveTopics(Array.from({ length: 201 }, (_, index) => `site/asset-${index}/value`)),
    /At most 200/,
  );
});

test("keeps historical as-of cache entries isolated from current bindings", async () => {
  const requestBodies: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBodies.push(String(init?.body));
    const variables = JSON.parse(String(init?.body)).variables as { topics: string[]; asOf: string | null };
    return jsonResponse({
      data: {
        ResolveEntityObservationBindings: variables.topics.map((topic) => ({
          ...resolved(topic, variables.asOf ? "3" : "9"),
          asOf: variables.asOf,
        })),
      },
    });
  };
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
  });
  const historical = await client.resolveTopics(["site/press-14/status"], "2026-09-01T10:00:00Z");
  const current = await client.resolveTopics(["site/press-14/status"]);
  assert.equal(historical.resolutions[0]?.revision, "3");
  assert.equal(current.resolutions[0]?.revision, "9");
  assert.equal(requestBodies.length, 2);
});

test("resolves a bounded batch of topic and event-time pairs for reconciliation", async () => {
  let sentLookups: Array<{ topic: string; asOf: string }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    sentLookups = (JSON.parse(String(init?.body)).variables as {
      lookups: Array<{ topic: string; asOf: string }>;
    }).lookups;
    return jsonResponse({
      data: {
        ResolveEntityObservationBindingLookups: sentLookups.map((lookup) => ({
          ...resolved(lookup.topic),
          asOf: lookup.asOf,
        })),
      },
    });
  };
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
  });
  const result = await client.resolveLookups([
    { topic: "/site/line-a/press-14/status/", asOf: "2026-09-01T09:59:59Z" },
    { topic: "site/line-b/press-14/status", asOf: new Date("2026-09-01T10:00:01Z") },
  ]);

  assert.deepEqual(sentLookups, [
    { topic: "site/line-a/press-14/status", asOf: "2026-09-01T09:59:59.000Z" },
    { topic: "site/line-b/press-14/status", asOf: "2026-09-01T10:00:01.000Z" },
  ]);
  assert.deepEqual(result.map((entry) => [entry.topic, entry.asOf]), sentLookups.map((entry) => [entry.topic, entry.asOf]));
  await assert.rejects(
    () => client.resolveLookups(Array.from({ length: 201 }, (_, index) => ({
      topic: `site/asset-${index}/value`, asOf: "2026-09-01T10:00:00Z",
    }))),
    /At most 200/,
  );
});

test("lists and caches exact entity binding intervals for a bounded history window", async () => {
  let now = 1_000;
  const requestBodies: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBodies.push(String(init?.body));
    return jsonResponse({
      data: {
        ListEntityObservationBindingIntervals: [{
          topic: "site/line-a/press-14/equipment/main/temperature",
          stableEntityId: "11111111-1111-4111-8111-111111111111",
          entityTypeKey: "openhub.asset",
          bindingKind: "attribute-topic",
          validFrom: "2026-09-01T09:00:00Z",
          validTo: "2026-09-01T10:00:00Z",
          timeBasis: "source-event-time",
          sourceCount: 2,
          revision: "8",
          digest: `sha256:${"2".repeat(64)}`,
        }],
      },
    });
  };
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
    now: () => now,
    cacheTtlMs: 1_000,
  });
  const first = await client.listIntervals(
    "11111111-1111-4111-8111-111111111111",
    "2026-09-01T09:30:00Z",
    "2026-09-01T10:30:00Z",
  );
  assert.equal(first.source, "controller");
  assert.equal(first.intervals[0]?.revision, "8");
  assert.equal(first.intervals[0]?.validFrom, "2026-09-01T09:00:00.000Z");
  const variables = JSON.parse(requestBodies[0]!).variables as Record<string, unknown>;
  assert.equal(variables["limit"], 200);

  now += 500;
  const second = await client.listIntervals(
    "11111111-1111-4111-8111-111111111111",
    "2026-09-01T09:30:00Z",
    "2026-09-01T10:30:00Z",
  );
  assert.equal(second.source, "cache");
  assert.equal(requestBodies.length, 1);
});

test("validates entity interval selectors before calling the controller", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("must not fetch");
  };
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
  });
  await assert.rejects(
    () => client.listIntervals("invalid", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z"),
    /valid UUID/,
  );
  await assert.rejects(
    () => client.listIntervals(
      "11111111-1111-4111-8111-111111111111",
      "2026-09-01T10:00:00Z",
      "2026-09-01T09:00:00Z",
    ),
    /earlier/,
  );
});

test("uses only bounded stale interval evidence while the controller is unavailable", async () => {
  let now = 1_000;
  let fail = false;
  const fetchImpl: typeof fetch = async () => {
    if (fail) throw new Error("controller unavailable");
    return jsonResponse({
      data: {
        ListEntityObservationBindingIntervals: [{
          topic: "site/line-a/press-14/equipment/main/temperature",
          stableEntityId: "11111111-1111-4111-8111-111111111111",
          entityTypeKey: "openhub.asset",
          bindingKind: "attribute-topic",
          validFrom: "2026-09-01T09:00:00Z",
          validTo: null,
          timeBasis: "source-event-time",
          sourceCount: 1,
          revision: "8",
          digest: `sha256:${"2".repeat(64)}`,
        }],
      },
    });
  };
  const client = new ControllerEntityBindingClient({
    graphqlUrl: "http://controller/graphql",
    tokenProvider: { getAccessToken: async () => "service-token" },
    fetchImpl,
    now: () => now,
    cacheTtlMs: 100,
    staleIfErrorMs: 1_000,
  });
  const args = [
    "11111111-1111-4111-8111-111111111111",
    "2026-09-01T09:00:00Z",
    "2026-09-01T11:00:00Z",
  ] as const;
  await client.listIntervals(...args);
  fail = true;
  now += 200;
  assert.equal((await client.listIntervals(...args)).source, "stale-cache");
  now += 1_000;
  await assert.rejects(() => client.listIntervals(...args), /controller unavailable/);
});
