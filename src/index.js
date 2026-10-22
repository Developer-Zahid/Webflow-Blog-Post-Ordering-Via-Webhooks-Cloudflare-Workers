/**
 * Webflow Sort Date Worker
 *
 * Keeps the Blog Posts "Sort Date" field equal to the LATER of
 * "Published Date" and "Updated Date" (exact timestamp, UTC).
 *
 * Routes
 *   POST /webhook        Webflow webhook receiver (created / changed / published)
 *   POST /reconcile-all  Admin: check every post and fix mismatches (Bearer ADMIN_TOKEN)
 *   GET  /health         Liveness check
 *
 * Design rules
 *   1. Never trust webhook content. The payload only tells us WHICH item to look at;
 *      the Worker re-reads the item from the Webflow API before deciding anything.
 *   2. Loop guard. Only write when the stored Sort Date differs from the computed one.
 *      Our own write fires another webhook; on that run the values match, so we stop.
 *   3. Staged and live are reconciled separately, each from its OWN dates.
 */

const API = "https://api.webflow.com/v2";
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/webhook") {
        return await handleWebhook(request, env);
      }
      if (request.method === "POST" && url.pathname === "/reconcile-all") {
        return await handleReconcileAll(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }
      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      // A non-2xx response makes Webflow retry the webhook later.
      console.error("Unhandled error:", err);
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

async function handleWebhook(request, env) {
  const raw = await request.text();

  // Parse first only to learn which trigger (and so which key) to check.
  // Nothing in the body is acted on until the signature is verified.
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Body is not JSON" }, 400);
  }
  const trigger = body?.triggerType ?? "unknown";

  if (!(await verifySignature(request, raw, env, trigger))) {
    console.warn(`Rejected webhook (${trigger}): bad or missing signature`);
    return json({ ok: false, error: "Invalid signature" }, 401);
  }

  const items = extractItems(body?.payload);
  const results = [];

  for (const { id, collectionId } of items) {
    if (collectionId && collectionId !== env.BLOG_COLLECTION_ID) {
      results.push({ id, skipped: "different collection" });
      continue;
    }
    results.push(await reconcileItem(env, id));
  }

  console.log(JSON.stringify({ trigger, results }));
  return json({ ok: true, trigger, results });
}

/**
 * Payload shapes differ by trigger: changed/created send one item,
 * published sends { items: [...] }. Accept both.
 */
export function extractItems(payload) {
  if (!payload || typeof payload !== "object") return [];
  const list = Array.isArray(payload.items) ? payload.items : [payload];
  return list
    .map((item) => ({
      id: item?.id ?? item?._id ?? item?.itemId,
      collectionId: item?.collectionId ?? payload.collectionId,
    }))
    .filter((item) => typeof item.id === "string" && item.id.length > 0);
}

/* ------------------------------------------------------------------ */
/* Core logic                                                          */
/* ------------------------------------------------------------------ */

/** Later of Published Date and Updated Date as an ISO string, or null. */
export function computeSortDate(fieldData, env) {
  const published = toMs(fieldData?.[env.PUBLISHED_FIELD]);
  const updated = toMs(fieldData?.[env.UPDATED_FIELD]);
  if (published === null && updated === null) return null;
  return new Date(Math.max(published ?? -Infinity, updated ?? -Infinity)).toISOString();
}

/** Compare as instants, so "…T11:49:00Z" equals "…T11:49:00.000Z". */
export function sameInstant(a, b) {
  return toMs(a) === toMs(b);
}

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function reconcileItem(env, itemId) {
  const cid = env.BLOG_COLLECTION_ID;
  const field = env.SORT_FIELD;
  const result = { id: itemId, staged: "ok", live: "not live" };

  // --- Staged (the copy editors see in the CMS) ---
  const staged = await webflow(env, "GET", `/collections/${cid}/items/${itemId}`);
  if (staged.status === 404) return { id: itemId, skipped: "not in blog collection" };

  const stagedTarget = computeSortDate(staged.data.fieldData, env);
  if (!sameInstant(staged.data.fieldData?.[field], stagedTarget)) {
    await webflow(env, "PATCH", `/collections/${cid}/items/${itemId}`, {
      fieldData: { [field]: stagedTarget },
    });
    result.staged = `updated -> ${stagedTarget}`;
  }

  // --- Live (the copy visitors see) ---
  // Computed from the LIVE dates, which can differ from staged ones
  // when an editor has unpublished edits.
  const live = await webflow(env, "GET", `/collections/${cid}/items/${itemId}/live`);
  if (live.status !== 404) {
    const liveTarget = computeSortDate(live.data.fieldData, env);
    if (sameInstant(live.data.fieldData?.[field], liveTarget)) {
      result.live = "ok";
    } else {
      await webflow(env, "PATCH", `/collections/${cid}/items/${itemId}/live`, {
        fieldData: { [field]: liveTarget },
      });
      result.live = `updated -> ${liveTarget}`;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Admin: reconcile every post                                         */
/* ------------------------------------------------------------------ */

async function handleReconcileAll(request, env, url) {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || !constantTimeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const dryRun = url.searchParams.get("dryRun") === "1";
  const maxWrites = Number(url.searchParams.get("maxWrites") ?? 40);
  const cid = env.BLOG_COLLECTION_ID;
  const field = env.SORT_FIELD;

  const stagedItems = await listAll(env, `/collections/${cid}/items`);
  const liveItems = await listAll(env, `/collections/${cid}/items/live`);

  const fixes = [];
  for (const item of stagedItems) {
    const target = computeSortDate(item.fieldData, env);
    if (!sameInstant(item.fieldData?.[field], target)) {
      fixes.push({ id: item.id, name: item.fieldData?.name, copy: "staged", from: item.fieldData?.[field] ?? null, to: target });
    }
  }
  for (const item of liveItems) {
    const target = computeSortDate(item.fieldData, env);
    if (!sameInstant(item.fieldData?.[field], target)) {
      fixes.push({ id: item.id, name: item.fieldData?.name, copy: "live", from: item.fieldData?.[field] ?? null, to: target });
    }
  }

  let written = 0;
  if (!dryRun) {
    for (const fix of fixes) {
      if (written >= maxWrites) break;
      const path = `/collections/${cid}/items/${fix.id}${fix.copy === "live" ? "/live" : ""}`;
      await webflow(env, "PATCH", path, { fieldData: { [field]: fix.to } });
      fix.done = true;
      written++;
    }
  }

  return json({
    ok: true,
    dryRun,
    checked: { staged: stagedItems.length, live: liveItems.length },
    mismatches: fixes.length,
    written,
    remaining: dryRun ? fixes.length : fixes.length - written,
    fixes,
  });
}

async function listAll(env, path) {
  const all = [];
  let offset = 0;
  for (;;) {
    const res = await webflow(env, "GET", `${path}?limit=100&offset=${offset}`);
    if (res.status === 404) return all;
    const items = res.data?.items ?? [];
    all.push(...items);
    const total = res.data?.pagination?.total ?? all.length;
    offset += items.length;
    if (items.length === 0 || offset >= total) return all;
  }
}

/* ------------------------------------------------------------------ */
/* Webflow API helper                                                  */
/* ------------------------------------------------------------------ */

async function webflow(env, method, path, body, attempt = 0) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.WEBFLOW_API_TOKEN}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Rate limited: wait as instructed (capped) and retry twice at most.
  if (res.status === 429 && attempt < 2) {
    const seconds = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return webflow(env, method, path, body, attempt + 1);
  }

  if (res.status === 404) return { status: 404, data: null };

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Webflow ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/* ------------------------------------------------------------------ */
/* Signature verification                                              */
/* ------------------------------------------------------------------ */

/**
 * Webflow signs webhooks with HMAC-SHA256 over "<timestamp>:<raw body>"
 * and sends x-webflow-timestamp + x-webflow-signature (hex).
 *
 * Webhooks created in the dashboard each get their OWN key, stored as
 * one secret per trigger. A request is checked only against the key of
 * the trigger it claims to be, so e.g. the CREATED key cannot sign a
 * "changed" event.
 */
export const TRIGGER_SECRETS = {
  collection_item_created: "WEBFLOW_WEBHOOK_SECRET_CREATED",
  collection_item_changed: "WEBFLOW_WEBHOOK_SECRET_CHANGED",
  collection_item_published: "WEBFLOW_WEBHOOK_SECRET_PUBLISHED",
};

export async function verifySignature(request, raw, env, trigger) {
  const name = TRIGGER_SECRETS[trigger];
  const secrets = name && env[name] ? [String(env[name]).trim()] : [];
  if (secrets.length === 0) {
    // Unknown trigger, or its key is not set: reject.
    // ALLOW_UNSIGNED is only for local experiments. Never set it on Cloudflare.
    return env.ALLOW_UNSIGNED === "true";
  }

  const timestamp = request.headers.get("x-webflow-timestamp");
  const signature = request.headers.get("x-webflow-signature");
  if (!timestamp || !signature) return false;

  let tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) return false;
  if (tsMs < 1e12) tsMs *= 1000; // accept seconds as well as milliseconds
  if (Math.abs(Date.now() - tsMs) > SIGNATURE_MAX_AGE_MS) return false; // replay protection

  const enc = new TextEncoder();
  const message = enc.encode(`${timestamp}:${raw}`);
  const received = signature.trim().toLowerCase();

  let matched = false;
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, message);
    const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (constantTimeEqual(expected, received)) matched = true;
  }
  return matched;
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}