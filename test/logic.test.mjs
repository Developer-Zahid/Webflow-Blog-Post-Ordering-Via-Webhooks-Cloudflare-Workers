// Runs the real Worker against an in-memory fake of the Webflow API.
// No network, no Cloudflare account needed:  npm test
import assert from "node:assert/strict";
import worker, { computeSortDate, sameInstant, extractItems, TRIGGER_SECRETS } from "../src/index.js";

const CID = "blog-collection";
const env = {
  BLOG_COLLECTION_ID: CID,
  PUBLISHED_FIELD: "published-date",
  UPDATED_FIELD: "updated-date",
  SORT_FIELD: "sort-date",
  WEBFLOW_API_TOKEN: "test-token",
  WEBFLOW_WEBHOOK_SECRET_CREATED: "key_created",
  WEBFLOW_WEBHOOK_SECRET_CHANGED: "key_changed",
  WEBFLOW_WEBHOOK_SECRET_PUBLISHED: "key_published",
  ADMIN_TOKEN: "admin123",
};

/* ---------- fake Webflow store ---------- */
let staged, live, writes;
function reset(items) {
  staged = new Map();
  live = new Map();
  writes = [];
  for (const it of items) {
    staged.set(it.id, structuredClone(it));
    if (it.isLive !== false) live.set(it.id, structuredClone(it));
  }
}
const item = (id, published, updated = null, sort = null, extra = {}) => ({
  id,
  fieldData: { name: id, "published-date": published, "updated-date": updated, "sort-date": sort },
  ...extra,
});

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname.replace("/v2", "");
  const method = init.method ?? "GET";
  assert.equal(init.headers.authorization, "Bearer test-token");
  const m = path.match(/^\/collections\/([^/]+)\/items(?:\/([^/]+))?(\/live)?$/) ??
            path.match(/^\/collections\/([^/]+)\/items(\/live)$/);
  const [, cid] = m;
  if (cid !== CID) return new Response("{}", { status: 404 });

  // list endpoints
  if (path.endsWith("/items") || path.endsWith("/items/live")) {
    const store = path.endsWith("/live") ? live : staged;
    const items = [...store.values()];
    return Response.json({ items, pagination: { total: items.length } });
  }

  const id = m[2];
  const store = m[3] ? live : staged;
  const doc = store.get(id);
  if (!doc) return new Response("{}", { status: 404 });
  if (method === "GET") return Response.json(doc);
  if (method === "PATCH") {
    const body = JSON.parse(init.body);
    Object.assign(doc.fieldData, body.fieldData);
    writes.push(`${m[3] ? "live" : "staged"}:${id}=${body.fieldData["sort-date"]}`);
    return Response.json(doc);
  }
  throw new Error("unexpected " + method);
};

/* ---------- helpers ---------- */
async function sign(ts, body, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}:${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hook(payload, { trigger = "collection_item_changed", ts = Date.now(), secret, badSig = false } = {}) {
  const body = JSON.stringify({ triggerType: trigger, payload });
  const key = secret ?? env[TRIGGER_SECRETS[trigger]]; // default: the right key for this trigger
  const sig = badSig ? "0".repeat(64) : await sign(String(ts), body, key);
  const res = await worker.fetch(
    new Request("https://w.example/webhook", {
      method: "POST",
      headers: { "x-webflow-timestamp": String(ts), "x-webflow-signature": sig },
      body,
    }),
    env,
  );
  return { status: res.status, data: await res.json() };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("✓", name);
}

/* ---------- pure functions ---------- */
await test("later of the two dates, exact time kept", () => {
  assert.equal(
    computeSortDate({ "published-date": "2026-10-15T00:00:00.000Z", "updated-date": "2026-10-22T11:49:00.000Z" }, env),
    "2026-10-22T11:49:00.000Z",
  );
});
await test("no Updated Date falls back to Published Date", () => {
  assert.equal(computeSortDate({ "published-date": "2026-10-22T00:00:00.000Z", "updated-date": null }, env), "2026-10-22T00:00:00.000Z");
});
await test("Updated Date earlier than Published Date is ignored", () => {
  assert.equal(
    computeSortDate({ "published-date": "2026-10-20T00:00:00.000Z", "updated-date": "2026-10-01T00:00:00.000Z" }, env),
    "2026-10-20T00:00:00.000Z",
  );
});
await test("same instant in different string formats counts as equal", () => {
  assert.ok(sameInstant("2026-10-22T11:49:00Z", "2026-10-22T11:49:00.000Z"));
  assert.ok(sameInstant(null, undefined));
});
await test("payload parsing: single item and published batch", () => {
  assert.deepEqual(extractItems({ id: "a", collectionId: "c" }), [{ id: "a", collectionId: "c" }]);
  assert.deepEqual(extractItems({ items: [{ id: "a" }, { id: "b" }] }).map((i) => i.id), ["a", "b"]);
});

/* ---------- webhook scenarios ---------- */
await test("new Updated Date published -> staged + live fixed", async () => {
  reset([item("p1", "2026-10-15T00:00:00.000Z", "2026-10-23T09:00:00.000Z", "2026-10-15T00:00:00.000Z")]);
  const r = await hook({ items: [{ id: "p1", collectionId: CID }] }, { trigger: "collection_item_published" });
  assert.equal(r.status, 200);
  assert.deepEqual(writes, ["staged:p1=2026-10-23T09:00:00.000Z", "live:p1=2026-10-23T09:00:00.000Z"]);
});

await test("loop guard: the webhook fired by our own write changes nothing", async () => {
  writes = [];
  await hook({ id: "p1", collectionId: CID });
  assert.deepEqual(writes, []);
});

await test("unrelated edit (title/body) causes no write", async () => {
  reset([item("p2", "2026-10-20T00:00:00.000Z", null, "2026-10-20T00:00:00.000Z")]);
  staged.get("p2").fieldData.name = "New title";
  await hook({ id: "p2", collectionId: CID });
  assert.deepEqual(writes, []);
});

await test("Updated Date removed -> falls back to Published Date", async () => {
  reset([item("p3", "2026-10-10T00:00:00.000Z", null, "2026-10-21T11:50:00.000Z")]);
  await hook({ id: "p3", collectionId: CID });
  assert.deepEqual(writes, ["staged:p3=2026-10-10T00:00:00.000Z", "live:p3=2026-10-10T00:00:00.000Z"]);
});

await test("unpublished edit: staged fixed, live left alone", async () => {
  reset([item("p4", "2026-10-10T00:00:00.000Z", null, "2026-10-10T00:00:00.000Z")]);
  staged.get("p4").fieldData["updated-date"] = "2026-10-23T08:00:00.000Z"; // saved, not published
  await hook({ id: "p4", collectionId: CID });
  assert.deepEqual(writes, ["staged:p4=2026-10-23T08:00:00.000Z"]);
  assert.equal(live.get("p4").fieldData["sort-date"], "2026-10-10T00:00:00.000Z");
});

await test("draft never published: only staged touched", async () => {
  reset([item("p5", "2026-10-24T00:00:00.000Z", null, null, { isLive: false })]);
  const r = await hook({ id: "p5", collectionId: CID }, { trigger: "collection_item_created" });
  assert.deepEqual(writes, ["staged:p5=2026-10-24T00:00:00.000Z"]);
  assert.equal(r.data.results[0].live, "not live");
});

await test("other collections are ignored", async () => {
  reset([]);
  const r = await hook({ id: "x", collectionId: "authors" });
  assert.equal(r.data.results[0].skipped, "different collection");
  assert.deepEqual(writes, []);
});

/* ---------- security ---------- */
await test("bad signature rejected (401), nothing written", async () => {
  reset([item("p6", "2026-10-10T00:00:00.000Z", "2026-10-23T00:00:00.000Z", null)]);
  const r = await hook({ id: "p6", collectionId: CID }, { badSig: true });
  assert.equal(r.status, 401);
  assert.deepEqual(writes, []);
});
await test("wrong secret rejected", async () => {
  const r = await hook({ id: "p6", collectionId: CID }, { secret: "someone-else" });
  assert.equal(r.status, 401);
});
await test("replayed request older than 5 minutes rejected", async () => {
  const r = await hook({ id: "p6", collectionId: CID }, { ts: Date.now() - 10 * 60 * 1000 });
  assert.equal(r.status, 401);
});

await test("each trigger accepts only its own key", async () => {
  reset([item("p7", "2026-10-10T00:00:00.000Z", null, "2026-10-10T00:00:00.000Z")]);
  const triggers = ["collection_item_created", "collection_item_changed", "collection_item_published"];
  for (const trigger of triggers) {
    for (const other of triggers) {
      const r = await hook({ id: "p7", collectionId: CID }, { trigger, secret: env[TRIGGER_SECRETS[other]] });
      assert.equal(r.status, trigger === other ? 200 : 401, `${trigger} signed with ${other} key`);
    }
  }
});
await test("unknown trigger (e.g. item deleted) is rejected", async () => {
  const r = await hook({ id: "p7", collectionId: CID }, { trigger: "collection_item_deleted", secret: "key_changed" });
  assert.equal(r.status, 401);
});
await test("missing key for a trigger is rejected", async () => {
  const saved = env.WEBFLOW_WEBHOOK_SECRET_PUBLISHED;
  delete env.WEBFLOW_WEBHOOK_SECRET_PUBLISHED;
  const r = await hook({ items: [{ id: "p7" }] }, { trigger: "collection_item_published", secret: "anything" });
  assert.equal(r.status, 401);
  env.WEBFLOW_WEBHOOK_SECRET_PUBLISHED = saved;
});

/* ---------- admin reconcile ---------- */
await test("reconcile-all: needs admin token; dry run reports, real run fixes", async () => {
  reset([
    item("a", "2026-10-22T00:00:00.000Z", null, "2026-10-22T00:00:00.000Z"),
    item("b", "2026-10-15T00:00:00.000Z", "2026-10-22T11:49:00.000Z", "2026-10-22T00:00:00.000Z"),
  ]);
  const call = (q, token = "admin123") =>
    worker.fetch(new Request(`https://w.example/reconcile-all${q}`, { method: "POST", headers: { authorization: `Bearer ${token}` } }), env);

  assert.equal((await call("", "wrong")).status, 401);

  const dry = await (await call("?dryRun=1")).json();
  assert.equal(dry.mismatches, 2); // b staged + b live
  assert.deepEqual(writes, []);

  const real = await (await call("")).json();
  assert.equal(real.written, 2);
  assert.equal(staged.get("b").fieldData["sort-date"], "2026-10-22T11:49:00.000Z");
  assert.equal(live.get("b").fieldData["sort-date"], "2026-10-22T11:49:00.000Z");
});

console.log(`\nAll ${passed} tests passed.`);
