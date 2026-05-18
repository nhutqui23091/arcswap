# Deploying `status.arcswap.net`

This runbook walks through creating the **separate Cloudflare Pages project**
that serves the ArcSwap status dashboard at `status.arcswap.net`.

Why a separate project? Two reasons:

1. **Cache isolation** — deploying a tweak to the status page does not bust
   cache for the main `arcswap.net` site, and vice versa.
2. **Scoping** — when the main site has an incident (build error, function
   crash, CSP rollback), the status page keeps serving so users can see what's
   going on. The status page's CSP is tighter and it has no access to main-site
   secrets (no `KIT_KEY`, no `CIRCLE_API_KEY`, no KV).

The code already lives in this repo at [`status/`](../status/) — just the HTML,
favicon, and `_headers`. No Functions. The status page **cross-origin probes**
the main site's Pages Functions for health (the main project's
`_circle.js`/`gateway-proxy`/`agent` routes have `status.arcswap.net` on their
origin allowlist and expose a lightweight `/health` endpoint).

---

## Step 1 — Create the new Cloudflare Pages project

In Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**.

| Setting | Value |
|---|---|
| **Project name** | `arcswap-status` |
| **Production branch** | `main` |
| **Framework preset** | None (static) |
| **Build command** | _(leave empty)_ |
| **Build output directory** | `status` |
| **Root directory** | `/` _(default — keep at repo root)_ |

> **Important:** set **Build output directory** to `status` so Cloudflare only
> deploys files in the `status/` folder. The rest of the repo (root
> `index.html`, `trade.html`, `functions/`, etc.) is **not** uploaded into this
> project — that's the whole point of project separation.

Hit **Save and Deploy**. First deploy takes ~30 seconds. You should see
`arcswap-status.pages.dev` come live with the status dashboard.

---

## Step 2 — Add custom domain `status.arcswap.net`

Still in the Cloudflare Dashboard, open the new `arcswap-status` project:

1. Go to **Custom domains → Set up a custom domain**
2. Enter `status.arcswap.net`
3. Cloudflare auto-detects that `arcswap.net` is on your account and offers to
   create the CNAME for you — accept it.
4. SSL provisioning takes 30–60 seconds. When the status shows **Active**, the
   subdomain is live.

DNS record created (verify under **DNS → Records**):

```
status   CNAME   arcswap-status.pages.dev   Proxied (orange cloud)
```

---

## Step 3 — Verify

After the custom domain shows **Active**, run:

```bash
# Page serves
curl -sI https://status.arcswap.net | grep -iE 'HTTP|content-security|strict-transport|x-frame'

# Should see:
# HTTP/2 200
# content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...
# strict-transport-security: max-age=31536000; includeSubDomains
# x-frame-options: DENY

# Cross-origin probes work — main site allowlist includes status.arcswap.net
curl -sI -H "Origin: https://status.arcswap.net" https://arcswap.net/api/gateway-proxy/health
# Should see:
# HTTP/2 204
# access-control-allow-origin: https://status.arcswap.net

# Legacy /status on main site forwards
curl -sI https://arcswap.net/status | grep -i location
# Should see:
# location: https://status.arcswap.net/
```

Open `https://status.arcswap.net` in a browser. All 8 service cards should
show **Operational** with real latency numbers; chain cards should show real
block numbers from public testnet RPCs.

---

## Step 4 — (Optional) Monitor the status page itself

The status page should be monitored externally — if `status.arcswap.net` is
itself down, no one can see your incident page. Recommended:

- **Better Stack** (free tier) — 30-second HTTP check against
  `https://status.arcswap.net`. Alerts via Slack/email/SMS.
- **UptimeRobot** (free tier) — 5-minute HTTP check, similar.

This is the only piece of infrastructure that must NOT live on Cloudflare
itself — otherwise a Cloudflare outage takes down both your site and your
monitoring.

---

## Updating the status page

Any push to `main` that touches `status/**` triggers an automatic redeploy of
the `arcswap-status` project — Cloudflare's Build output directory filter
ignores changes outside `status/`, so unrelated commits don't redeploy.

To preview a change locally:

```bash
# From repo root
python -m http.server 8766 --directory status
# Open http://localhost:8766
```

The `API_BASE` detection in `status/index.html` resolves to `''` (same-origin)
when hostname doesn't match `status.*`, so localhost previews probe
`http://localhost:8766/api/*` — those 404 in local-only mode, but the page
still renders and all UI is testable.

---

## Rolling back

Each deploy is immutable in Cloudflare Pages. To roll back:

1. Dashboard → `arcswap-status` → **Deployments**
2. Find the last good deploy → **... → Rollback to this deployment**

Rollback is instant (atomic switch of the alias). The main `arcswap` project
is **unaffected** — that's the whole point of separation.

---

## Migrating back to a single project (if needed)

If you later decide to consolidate (unlikely but possible), the migration is
trivial because there is no state in the status project:

1. Move `status/index.html` back to `/status.html` (or a `/status/` subdir)
2. Update nav links from `https://status.arcswap.net` back to `/status`
3. Delete the `_redirects` entries forwarding to the subdomain
4. Remove `status.arcswap.net` from origin allowlists in the 3 Functions
5. Delete the `arcswap-status` Pages project + remove the DNS CNAME

---

_Last updated: 2026-05-18._
