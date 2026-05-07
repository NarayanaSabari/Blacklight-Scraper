# Monster DataDome Session Refresh

Monster's API sits behind DataDome bot mitigation. Each request must carry a
`(x-datadome-clientid, datadome cookie)` pair from a session that solved
DataDome's in-page captcha. The cleared session is bound to **the IP that
solved it** — so cookies cleared on your laptop's IP don't work from the VM,
and vice versa.

## When to refresh

Refresh whenever you see Monster failure rate climbing in Grafana, or when
the metric `scraper_monster_datadome_path_total{path="fallback"}` starts
incrementing — that means the manual session 403'd mid-scrape and we
degraded to the legacy clientid path. Cookies typically last **a few hours
to ~24h** depending on traffic volume and DataDome's reputation scoring.

The scraper never goes to 0% Monster on its own — we always fall back to
the legacy hardcoded clientid (~80% historical success). Refreshing
restores the cleaner ~100% mode.

## How it works (one-liner)

```bash
npm run refresh-monster
```

That script:
1. Opens an SSH SOCKS proxy on `localhost:1080` to the VM
2. Tells you to launch a fresh Chrome window through that proxy
3. You solve the captcha (browser exits via VM IP, so DataDome credits the
   solve against the VM's IP — exactly what we need)
4. You paste the request headers from any `appsapi.monster.io` call back
   into the script
5. Script writes the parsed `monster` block to BOTH `config/credentials.json`
   locally AND the VM's `config/credentials.json` via scp
6. Both scrapers hot-reload via `fs.watch` within ~2 seconds

## Step-by-step

### 1. Run the helper

```bash
npm run refresh-monster
```

It prints instructions for launching Chrome with the SOCKS proxy. On macOS:

```bash
open -na "Google Chrome" --args \
    --user-data-dir=/tmp/monster-refresh \
    --proxy-server="socks5://localhost:1080"
```

Use a fresh `--user-data-dir` so this Chrome doesn't share cookies with
your normal browser — keeps the cleared session clean and avoids
contaminating your normal browsing profile.

### 2. Solve the captcha

In that Chrome:

1. Visit https://www.monster.com/jobs/search?q=DevOps+Engineer&where=United+States
2. Solve the DataDome captcha if shown (slider, dot puzzle, etc.)
3. Wait for the job results to fully render

### 3. Capture the headers

1. Open DevTools → **Network** tab
2. Click any request to `appsapi.monster.io` (POST, returns JSON)
3. Right-click the request → **Copy** → **Copy all as cURL**
4. Paste it into the script's stdin
5. Type `EOF` on its own line and press Enter

The script accepts either:
- The cURL paste (preferred — has everything)
- The raw "Request Headers" pane from DevTools (alternating name/value lines)

### 4. Done

You'll see:
```
→ Parsed 14 cookies, clientid Ppc5ZvlLjzMXVm0R…
✓ wrote /Users/.../config/credentials.json
✓ pushed Monster session to root@5.161.248.170:/home/scraper/scraper/config/credentials.json
✓ Done. Both scrapers will pick up the new session within ~2 seconds.
```

The next Monster scrape on each environment will use the new manual session.

## Flags

| Flag | Effect |
|---|---|
| `--local-only` | Update `config/credentials.json` only, skip the VM push. Useful for local-only testing. |
| `--paste-only` | Skip the SSH SOCKS proxy step. Useful when you've already solved the captcha through some other means and just want to register the cookies. |

## Env overrides

```bash
VM_HOST=root@5.161.248.170 \
VM_KEY=~/.ssh/hetzner_quantipeak \
VM_PATH=/home/scraper/scraper/config/credentials.json \
SOCKS_PORT=1080 \
  npm run refresh-monster
```

## Troubleshooting

**`SOCKS proxy on :1080 not reachable`** — your SSH key can't connect to the
VM. Test with `ssh -i ~/.ssh/hetzner_quantipeak root@5.161.248.170 echo ok`.

**`could not extract cookie + x-datadome-clientid from paste`** — the paste
didn't contain those values. If you copied the response headers instead of
the request headers, you'll see `set-cookie` etc. but not the request-side
`cookie` header. Switch to the "Request Headers" pane.

**Monster scraper still 403s after refresh** — check the log for
`Loaded manual Monster DataDome session` shortly after the merge completes.
If you don't see it, the file watcher might not be firing (rare on Linux);
restart the scraper service: `ssh root@5.161.248.170 systemctl restart qp-scraper`.

**Captcha keeps re-appearing in the SOCKS-proxied Chrome** — DataDome may
still be flagging the VM IP heavily. If you scrape Monster a lot, consider
combining this with a residential proxy that anchors the VM to a cleaner
IP. The current architecture is unchanged either way; just add the proxy
config to credentials.json.

## Architecture notes

The scraper has two DataDome paths, controlled by the presence of a
`monster` block in `config/credentials.json`:

- **Manual** (preferred) — uses the cleared cookies + clientid. ~100%
  success while cookies are fresh.
- **Legacy** (fallback) — uses a hardcoded clientid that's been used
  across this codebase for months. ~80% success in production; the rest
  gets challenged when DataDome's reputation drift catches up.

If the manual session 403s mid-scrape, we transparently retry that
single request with legacy headers and continue on the legacy path
(metric: `path="fallback"`). The scrape never throws on a recoverable
403 — worst case is today's legacy behavior.

For full implementation context see:
- `src/core/datadome.js` — session loader + hot-reload
- `scrapers/monster.js` — request loop + mid-scrape fallback
- `src/metrics/registry.js` — `scraper_monster_datadome_path_total`
