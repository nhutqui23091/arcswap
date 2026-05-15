# Agent Backend Setup

One-time provisioning to switch the `/agent` page from local-only preview to
real persistent backend backed by Cloudflare KV + Circle Programmable Wallets.

Until both items below are configured, the page works in **localStorage-only**
mode — agents are stored client-side and execution is simulated.

---

## 1. Create the KV namespace

The agent API stores rules and executions in Cloudflare KV.

### Via dashboard

1. Cloudflare dashboard → **Workers & Pages** → **KV** → **Create a namespace**
2. Name: `arcswap-agents-prod` (or whatever)
3. Note the namespace ID

### Bind it to the Pages project

1. Cloudflare dashboard → **Pages** → your ArcSwap project → **Settings** →
   **Functions** → **KV namespace bindings** → **Add binding**
2. Variable name: `AGENT_KV` *(must be exactly this — it's hard-coded in the API)*
3. Namespace: select the one created above
4. Save and **redeploy** (env changes don't auto-apply to existing deployments)

### Verify

```bash
curl https://arcswap.xyz/api/agent/list?owner=0x0000000000000000000000000000000000000000
# Before binding: 503 agent_storage_unconfigured
# After binding:  200 []
```

---

## 2. Circle Programmable Wallet credentials

Required to actually move funds. Without these the API still stores rules and
returns simulated executions.

### Get the credentials

1. Sign up at https://console.circle.com (use **TESTNET** environment first)
2. Console → **API Keys** → **Create an API Key**
   - Scope: **Wallets** + **Transactions**
   - Save the key (you only see it once)
3. Console → **Configurator** → **Entity Secret**
   - Generate a 32-byte hex secret (must persist — losing it locks your wallets)
   - Encrypt it with Circle's public key to produce ciphertext (one-time per request)
   - For the dev console UI: paste the secret directly; the SDK will handle ciphertexting

### Set env vars

Cloudflare dashboard → **Pages** → ArcSwap project → **Settings** →
**Environment variables** → **Production** → **Add variable** (type: **Encrypt**)

| Variable name              | Value                                                          |
|----------------------------|----------------------------------------------------------------|
| `CIRCLE_API_KEY`           | `TEST_API_KEY:abcdef…` from Circle console                      |
| `CIRCLE_ENTITY_SECRET`     | 32-byte hex from Circle console (NEVER commit this)             |
| *(existing)* `KIT_KEY`     | Already set — used by `/api/circle-proxy` for App Kit swaps     |
| *(existing)* `POOL_AUTH_*` | Already set — used by `/pool` Basic Auth                        |

After saving, **trigger a redeploy** (Pages → Deployments → ⋯ → Retry).

---

## 3. Cron Trigger for autonomous execution

Without a cron, the agent only fires when a user clicks **Run now**. A
scheduler hitting `/api/agent/cron-tick` every minute makes it truly
autonomous.

### Set the shared secret

```
Cloudflare Pages → Settings → Environment variables → Production
  → Add variable:
    Name:  CRON_SECRET
    Value: <generate a random 32-char string — `openssl rand -hex 32`>
    Type:  🔒 Encrypted
```

Without this var, the endpoint returns `503 cron_not_configured` and the
cron is a no-op (safe default).

### How `/api/agent/cron-tick` works

- Auth: requires `Authorization: Bearer <CRON_SECRET>` header
- Scans all `agent:*` KV keys (filters to bare agent records, skips
  execution-log keys)
- For schedule mode: fires when `nextRun <= now`, then advances nextRun
  based on cadence (daily / weekly / monthly)
- For topup mode: fires at most once per hour (placeholder — real
  version polls each target balance via RPC and fires only those below
  the floor)
- Returns a summary JSON: `{ scanned, fired, skipped, errors, details }`

### Wire up the cron trigger — Cloudflare Worker

**Why a Worker?** External HTTP cron services (GitHub Actions,
cron-job.org, EasyCron, etc.) all hit `https://arcswap.net/api/agent/
cron-tick` from outside Cloudflare. On the **Free plan**, Cloudflare's
basic Bot Fight Mode intercepts non-browser User-Agents and serves a
JavaScript challenge — which means our cron sees HTTP 403 instead of
the function. WAF Custom Rules on Free can't skip the basic Bot Fight
Mode (only Super Bot Fight Mode on Pro+ is skippable). The Worker
approach sidesteps this entirely.

The Worker:
- Runs **inside** Cloudflare's network, never goes through the public
  edge for its own requests
- Uses a **service binding** to talk directly to the Pages project
- Fires every minute via Cloudflare's native cron trigger (more precise
  than GitHub Actions schedule)
- Free plan allowance: 100k req/day — a per-minute cron uses ~1.5k

Files live at `workers/agent-cron/` in this repo.

### Deploy steps (one-time)

Wrangler 4.x requires Node.js 22+. If you're on Node 18-20, use the
`@3` tag to pin to the last 3.x release (still actively supported, all
features we need).

```bash
# 1. Authenticate with Cloudflare (opens browser, OAuth)
npx wrangler@3 login

# 2. Deploy the Worker
cd workers/agent-cron
npx wrangler@3 deploy

# 3. Set the secret on the Worker (must match CRON_SECRET on the
#    Pages project — same 64-hex value)
npx wrangler@3 secret put CRON_SECRET
# (paste value when prompted, press Enter)

# 4. Optional — stream live invocation logs to verify
npx wrangler@3 tail
```

If you're on Node 22+, drop the `@3` and use `npx wrangler` directly,
or install globally with `npm install -g wrangler` and just run
`wrangler …`.

After step 3, Cloudflare Dashboard → Workers & Pages →
`arcswap-agent-cron` shows the new Worker. After step 4, the Worker
has everything it needs and starts firing on the schedule defined in
`wrangler.toml`.

### Verify

Check the Worker dashboard "Last invocation" timestamp — should update
every minute. Or run a smoke test manually via the HTTP handler:

```bash
curl "https://arcswap-agent-cron.<your-subdomain>.workers.dev/?secret=<CRON_SECRET>"
# → { "status": 200, "body": { "scanned": N, "fired": 0, ... } }
```

(Your subdomain is shown in Cloudflare Workers dashboard after the
first deploy.)

You can also call `/api/agent/cron-tick` directly from a browser
console (no bot challenge for browsers) to confirm the endpoint works
independent of the Worker:

```js
fetch('/api/agent/cron-tick', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer <CRON_SECRET>' },
}).then(r => r.json()).then(console.log)
```

## 4. EIP-2612 permit flow (Phase 2)

When a user deploys an agent, the frontend now ALSO signs EIP-2612
permit signatures — one per source chain. The backend submits each
`USDC.permit(...)` on-chain via the agent's SCA wallet (Paymaster
covers gas, free on testnet).

After permits are submitted, the agent pulls USDC directly from the
user's external wallet via `transferFrom()` whenever it fires. No
faucetting of the Circle wallet required.

If permit signing is skipped or fails, the agent falls back to Phase 1
behavior (user must fund the Circle SCA wallet manually). The agent
record's `permits[].state` indicates which chains are authorized.

---

## 4. Frontend wire-up

The frontend currently uses `localStorage`. To flip it to use the backend:

1. Open `agent.html`
2. Replace `localStorage.setItem` calls with `fetch('/api/agent/...')`
3. The fallback chain we want:
   - Try API first
   - On 503 `agent_storage_unconfigured` → fall back to localStorage
   - This way the page works whether or not the backend is provisioned
4. Add real EIP-712 signing via `signer.signTypedData(domain, types, value)`
   instead of the simulated "Sign & Deploy" modal

This will happen in a follow-up commit once the KV binding is verified live.

---

## Troubleshooting

**`/api/agent/list` returns 503**
→ KV binding missing. Re-check step 1; remember to redeploy.

**`/api/agent/create` returns 400 `signature_invalid`**
→ Frontend isn't sending a valid hex signature. Currently any `0x[hex]` passes
preview validation — real EIP-712 verification is TODO in `_circle.js`.

**Real Circle calls fail with 401**
→ `CIRCLE_API_KEY` is wrong/expired, or `CIRCLE_ENTITY_SECRET` ciphertext
generation is broken. Check Cloudflare function logs (`wrangler pages
deployment tail`).

**localStorage and KV are out of sync**
→ Expected. Once we flip the frontend to call the API, we'll migrate any
local-only agents on first load.
