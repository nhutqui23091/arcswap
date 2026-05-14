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

## 3. (Optional) Cron Trigger for autonomous execution

Without a cron, the agent only fires when a user clicks **Run now** on the UI.
A cron lets it run truly in the background:

- For threshold mode: poll each target wallet's balance every minute
- For schedule mode: fire when `nextRun <= now`

### Add the cron

Cloudflare doesn't yet support cron triggers in Pages Functions directly. Two
options:

**Option A — Convert to Worker** (recommended once cron is needed):

1. Move agent execution logic from `functions/api/agent/[[path]].js` into a
   dedicated Worker (`workers/agent-cron/`)
2. Schedule with `wrangler.toml` → `[triggers] crons = ["* * * * *"]`
3. Have the cron handler enumerate all `agent:*` keys, check trigger conditions

**Option B — External trigger** (cheap and fast):

1. Use any cron service (GitHub Actions, EasyCron, Cloudflare Workflows) to
   hit `POST /api/agent/cron-tick` every minute
2. Add a handler that loops over active agents and decides what to fire
3. Protect the endpoint with a shared secret (`CRON_SECRET` env var)

Both ship later — for now manual **Run now** is enough for demos.

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
