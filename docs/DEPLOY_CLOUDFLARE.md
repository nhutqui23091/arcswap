# Deploy to Cloudflare Pages — `oneliq.xyz`

This is the **primary deployment path** for Oneliq. You bought `oneliq.xyz` on Cloudflare,
which means DNS, CDN, SSL, and hosting all live under one account — zero glue code.

> Looking for the decentralized path (IPFS + ENS)? See `DEPLOYMENT.md`. That's an optional
> backup we'll add later.

---

## What you'll get

- `https://oneliq.xyz` serving the static site (HTTPS by default, free)
- Auto-deploy on every push to `main` (or any branch you choose)
- Preview deploys for every PR (unique URL per branch)
- Cloudflare's global CDN (no extra config)
- Our `_headers` and `_redirects` files honored automatically
- Bandwidth: unlimited on free tier

**Cost**: $0/month for everything below.

---

## One-time setup (15 minutes)

### Prerequisites

- [x] `oneliq.xyz` registered in your Cloudflare account
- [ ] Repo pushed to GitHub (or GitLab/Bitbucket)
- [ ] You're logged into Cloudflare dashboard

---

### Step 1 — Create the Pages project (5 min)

1. Open https://dash.cloudflare.com → **Workers & Pages** (left sidebar)
2. Click **Create** → tab **Pages** → **Connect to Git**
3. Authorize Cloudflare to read your GitHub account
4. Select the `arc-swap-v9` repo → **Begin setup**
5. Configure build:

   | Field | Value |
   |---|---|
   | **Project name** | `arcswap` |
   | **Production branch** | `main` |
   | **Framework preset** | **None** (it's plain HTML) |
   | **Build command** | _leave empty_ |
   | **Build output directory** | `/` (root) |
   | **Root directory** | _leave empty_ |

6. Click **Save and Deploy**

Cloudflare clones the repo, reads `_headers` + `_redirects`, and within ~30 seconds you get a
URL like `https://arcswap.pages.dev`. Open it — the site should be live with all security
headers applied.

---

### Step 2 — Wire up `oneliq.xyz` (5 min)

1. Inside the Pages project → tab **Custom domains** → **Set up a custom domain**
2. Type `oneliq.xyz` → **Continue**
3. Cloudflare detects the domain is in your account → asks to **Activate** the domain
4. It auto-creates a `CNAME` record pointing `oneliq.xyz` → `arcswap.pages.dev`
5. SSL cert provisions automatically (Universal SSL — free, ~1 minute)

6. **Repeat for `www`** (recommended):
   - Add custom domain `www.oneliq.xyz`
   - Cloudflare creates the CNAME

7. **Add www → apex redirect** (so `www.oneliq.xyz` and `oneliq.xyz` resolve to the same canonical URL):
   - Go to your domain in Cloudflare → tab **Rules** → **Redirect Rules**
   - Create rule:
     - Field: `Hostname`
     - Operator: `equals`
     - Value: `www.oneliq.xyz`
     - Then: `Dynamic` → Expression: `concat("https://oneliq.xyz", http.request.uri.path)`
     - Status: `301`
   - Save & deploy

---

### Step 3 — Verify everything works (5 min)

```bash
# 1. Site loads with HTTPS
curl -I https://oneliq.xyz
# Expect: HTTP/2 200, with cf-ray header

# 2. Security headers present (the ones from _headers)
curl -I https://oneliq.xyz | grep -iE 'content-security|strict-transport|x-frame|referrer-policy'

# 3. Clean URLs work (from _redirects)
curl -I https://oneliq.xyz/docs
curl -I https://oneliq.xyz/vault
# Expect: HTTP/2 200 (NOT 301 — these are rewrite-style proxies, not redirects)

# 4. Old aliases redirect
curl -I https://oneliq.xyz/swap
# Expect: HTTP/2 301, location: /trade

# 5. www → apex
curl -I https://www.oneliq.xyz
# Expect: HTTP/2 301, location: https://oneliq.xyz/
```

If any of these fail → see **Troubleshooting** below.

---

## Per-release flow (after one-time setup)

Cloudflare auto-deploys on every push. Your release flow becomes:

```bash
# 1. Pre-flight check (your existing script)
bash scripts/preflight-check.sh

# 2. Commit + push
git add .
git commit -m "release: vX.Y.Z — what changed"
git push origin main

# 3. Cloudflare auto-builds (~30s)
# Watch: https://dash.cloudflare.com → arcswap → Deployments

# 4. Verify the new build is live
curl -s https://oneliq.xyz/ | grep -oE 'version[^"]*' | head -3
bash scripts/health-check.sh
```

**Rollback** (if a deploy is broken):
1. Cloudflare dashboard → Deployments → find the previous green deploy
2. Click **⋯** → **Rollback to this deployment**
3. Live in seconds. No code changes needed.

---

## Recommended Cloudflare settings

These are NOT defaults but you should turn them on:

### Speed → Optimization
- **Auto Minify**: HTML, CSS, JS — all ON
- **Brotli**: ON (default)
- **Early Hints**: ON
- **Rocket Loader**: ⚠️ **OFF** (it rewrites JS — breaks our SRI hashes)

### Caching → Configuration
- **Browser Cache TTL**: `4 hours` (so security updates propagate quickly)
- **Always Online**: ON (free)

### SSL/TLS → Overview
- **SSL/TLS encryption mode**: **Full (strict)** — required, not just "Full"
- **Always Use HTTPS**: ON
- **Automatic HTTPS Rewrites**: ON
- **Minimum TLS Version**: `TLS 1.2` (or 1.3 if you're sure no users on ancient browsers)

### Security → Settings
- **Security Level**: `Medium`
- **Bot Fight Mode**: ON (free, blocks obvious bots)
- **Browser Integrity Check**: ON
- **Challenge Passage**: 30 minutes

### DNS → Records
After setup, you should have:
```
Type   Name    Content                Proxy   TTL
CNAME  @       arcswap.pages.dev      Yes 🟠  Auto
CNAME  www     arcswap.pages.dev      Yes 🟠  Auto
TXT    @       v=spf1 -all            DNS     Auto   (block email spoofing)
```

The orange-cloud (`Proxied`) is what makes Cloudflare's CDN + DDoS protection active.
Don't turn it grey unless you have a specific reason.

### Email — IMPORTANT for `security@oneliq.xyz`
You promised `security@oneliq.xyz` in `SECURITY.md` and `.well-known/security.txt`.
Make it real:

1. Cloudflare dashboard → your domain → **Email** → **Email Routing** → enable
2. Add destination address: your personal email (will receive forwarded mail)
3. Add custom address: `security@oneliq.xyz` → forwards to your destination
4. Cloudflare auto-adds the MX + SPF records
5. Verify destination email
6. Test by sending an email to `security@oneliq.xyz` from another account

Free, takes 5 minutes.

---

## Alternative: Direct Upload via Wrangler CLI

If you don't want the auto-deploy-on-push behavior (e.g. for sensitive releases that need
manual review), use wrangler:

```bash
# One-time install
npm install -g wrangler

# Login (opens browser)
wrangler login

# Deploy current directory to the project
wrangler pages deploy . --project-name=arcswap --branch=main
```

This skips Git entirely — uploads exactly what's on disk. Useful for hot-fixes when CI is broken.

---

## Troubleshooting

### "DNS resolution failed" or "domain not active"
Cloudflare needs to be the authoritative nameserver. Check:
1. Cloudflare dashboard → domain overview → status should say **Active**
2. If it says **Pending**, your registrar's nameservers are wrong. Update them at the registrar to:
   - `clyde.ns.cloudflare.com`
   - `iris.ns.cloudflare.com`
   *(your actual NS values are shown on the same page)*
3. Propagation can take up to 24h, usually < 1h

### Custom domain shows "522" or "525" errors
- **522**: Origin connection timeout. Check that `arcswap.pages.dev` works first.
- **525**: SSL handshake failed. SSL/TLS mode must be **Full (strict)**, not "Flexible" or "Off".

### Security headers missing
- Verify `_headers` file is in the **build output directory** (= repo root for us)
- Cloudflare reads it from the deployed root, not from `/public` or `/dist`
- Test: `curl -I https://oneliq.xyz` should show all headers

### `/docs` or `/vault` returns 404
- Verify `_redirects` is in the deployed root
- Each line must be: `<from> <to> <status>`
- 200 = rewrite (URL stays `/docs`), 301 = visible redirect (URL changes)

### Build deploys but pages look broken
- Check the deployment log in Cloudflare dashboard — look for `[Errno: 2]` (missing file)
- Common cause: a file referenced in HTML doesn't exist (typo in path)
- Fix locally, push again, Cloudflare redeploys

### `cf-ray` header not appearing
- The orange-cloud (Proxy) is OFF for that DNS record. Turn it on.

---

## Deploy checklist

For each release:

- [ ] Working tree clean
- [ ] `bash scripts/preflight-check.sh` passes (6/6)
- [ ] Commit + push to `main`
- [ ] Cloudflare deployment goes green (~30s)
- [ ] `curl -I https://oneliq.xyz` returns 200 with security headers
- [ ] Spot-check 3 pages: `/`, `/docs`, `/vault`
- [ ] `bash scripts/health-check.sh` passes
- [ ] Update `releases/RELEASE-YYYY-MM-DD.json` with deploy ID from Cloudflare
- [ ] Discord / X announcement (optional for testnet)

---

## Why this setup is fine for testnet (and even early mainnet)

- **Free** — no credit card required
- **Globally distributed** — Cloudflare has 300+ PoPs
- **Honest TLS** — Universal SSL is real Let's Encrypt-tier crypto
- **Atomic rollback** — one click, instant
- **Headers honored** — our `_headers` and `_redirects` work as-shipped
- **DDoS protection included** — at no extra cost

**When to consider IPFS + ENS in addition** (NOT replacement):
- You start handling real money on mainnet
- You want users to verify the served build matches a published hash
- You want a host that can't be subpoena'd or rate-limited

→ Run both in parallel: Cloudflare Pages as the daily-driver, IPFS+ENS as the immutable
audit trail. See `DEPLOYMENT.md` for that path.

---

_Last updated: 2026-04-26_
