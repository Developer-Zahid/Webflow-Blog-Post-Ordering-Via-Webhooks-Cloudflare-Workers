# webflow-sort-date

Cloudflare Worker that keeps the Blog Posts **Sort Date** field equal to the
later of **Published Date** and **Updated Date** (exact timestamp, UTC).

## How it decides

```
webhook (item id) ──► GET staged item ──► target = max(published, updated)
                                          stored == target ? stop : PATCH staged
                  ──► GET live item   ──► same check using the LIVE dates
                                          stored == target ? stop : PATCH live
```

- The payload only says *which* item. Everything else is re-read from the API.
- Writing Sort Date fires another webhook; on that run nothing differs, so it stops (loop guard).
- Manual edits to Sort Date are overwritten on the next event.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put WEBFLOW_API_TOKEN   # Site token, CMS: read + write
npx wrangler secret put ADMIN_TOKEN         # any long random string
npm run deploy                              # prints https://webflow-sort-date.<you>.workers.dev
```

Each dashboard webhook has its own signing key, stored as its own secret:

| Webhook trigger | Secret |
|---|---|
| Collection item created | `WEBFLOW_WEBHOOK_SECRET_CREATED` |
| Collection item changed | `WEBFLOW_WEBHOOK_SECRET_CHANGED` |
| Collection item published | `WEBFLOW_WEBHOOK_SECRET_PUBLISHED` |

A request is checked only against the key of its own trigger. If that key is
missing, the request is rejected with 401. To rotate one key, delete and
re-add that webhook in Webflow, then update only its secret.

## Verify after deploy

```bash
curl https://<worker-url>/health
curl -X POST "https://<worker-url>/reconcile-all?dryRun=1" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

The dry run reads every staged and live post through the real API and lists
mismatches without writing. With today's data it should report `"mismatches": 0`.
Drop `?dryRun=1` to fix whatever it lists.

## Other commands

| Command | What it does |
|---|---|
| `npm test` | Runs the logic tests against a fake Webflow API (no network) |
| `npm run logs` | Streams live Worker logs (`wrangler tail`) |
| `npm run dev` | Local server; copy `.dev.vars.example` to `.dev.vars` first |

## Settings (`wrangler.toml`)

| Var | Value |
|---|---|
| `BLOG_COLLECTION_ID` | `690aa883515819f871134491` |
| `PUBLISHED_FIELD` / `UPDATED_FIELD` / `SORT_FIELD` | `published-date` / `updated-date` / `sort-date` |

For a client site, change these four values and redeploy.