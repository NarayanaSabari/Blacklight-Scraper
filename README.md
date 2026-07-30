> ⚠️ **Read-only mirror.** The source of truth for this code is the **Blacklight monorepo** at `scraper/`.
> Direct commits to this repository are **overwritten** by CI on the next mirror push.
> Make all changes in the monorepo and let the mirror propagate them.

# Unified Job Scraper

Node.js scraper that pulls job postings from Monster, Dice, TechFetch,
LinkedIn, Glassdoor, and Indeed and feeds them into the Blacklight
backend for matching.

## Deployment topology

The six platforms split across two hosts based on what they tolerate:

| Host | Platforms | Why |
|---|---|---|
| **Hetzner VM** (Linux, with an ISP/residential proxy pool) | `monster, dice, techfetch` | Monster needs the pool for DataDome; Dice and TechFetch can run headless |
| **Windows machine** (residential IP) | `linkedin, glassdoor, indeed` | LinkedIn needs a headed CloakBrowser only for login/template setup; its RSC requests are browserless. Glassdoor discovery stays direct while its detail enrichment can use the proxy pool; Indeed needs a clean residential IP |

Both hosts run the **same code**. Each gets its own scraper API key with
a `platform_allowlist` set in the central dashboard (Dashboard → API
Keys), and the backend routes each queued role to the right host based
on the key's allowlist. Adding a new host = registering a new key.

**Setting up a fresh residential host**:
- 📗 [docs/SETUP.md](docs/SETUP.md) — one guide, all hosts

## 🚀 What this scraper does

- **Queue-driven** — polls the Blacklight backend every 30s, claims a
  role, starts all platforms in its allowlist **in parallel** within a
  single session, submits jobs back, completes the session. CloakBrowser
  launches are seat-pooled, so excess browser launches wait when the
  configured licence keys are saturated.
- **Multi-platform** - Monster (CloakBrowser + appsapi JSON behind
  DataDome), Dice (CloakBrowser + Crawlee + Cheerio), TechFetch (CloakBrowser + login),
  LinkedIn (browserless RSC API with a persistent profile for auth), Glassdoor
  (`/graph` API plus CloakBrowser detail enrichment, with an opt-in browser
  fallback), Indeed (mobile API with an opt-in browser fallback)
- **Express API** for manual scraping (`POST /scrape`)
- **Credential management** via the backend — credentials live in the
  central dashboard, scraper fetches them on demand
- **Observability** — Prometheus metrics + Loki logs ship through the
  Blacklight API to Grafana

## 📋 Prerequisites

- **Node.js** ≥ 22.19.0
- **npm** ≥ 10
- **CloakBrowser** - downloads its stealth Chromium on first launch

## 🔧 Installation

If you're setting up a fresh **residential** host for production, use
the single setup guide — it covers dashboard setup, launchd/NSSM service
wrapping, and host-specific troubleshooting:
- 📗 [docs/SETUP.md](docs/SETUP.md) — one guide, all hosts

The quick-start path below is for a manual or development run.

### 1. Clone the Repository

```bash
git clone https://github.com/NarayanaSabari/Blacklight.git
cd Blacklight/scraper
```

### 2. Install Dependencies

```bash
npm ci
```

This will install all required packages including:
- Express.js (Web server)
- Crawlee (Web scraping framework)
- Playwright (browser automation used by Crawlee)
- Cheerio (HTML parsing)
- JSDOM (DOM manipulation)

### 3. Pre-warm CloakBrowser (recommended)

```bash
node -e "import('cloakbrowser').then(async m => { const b = await m.launch({headless:true}); await b.close(); })"
```

CloakBrowser downloads and caches the browser required by the active scrapers.
No `playwright install` is needed for the active scraping paths.

### 4. Configure Credentials

Get a scraper API key from the central dashboard
(central.qpeakhire.com → Dashboard → API Keys → + New API Key) with the
right `platform_allowlist` for this host's role:

- VM host → `["monster", "dice", "techfetch"]`
- Windows host → `["linkedin", "glassdoor", "indeed"]`
- Dev laptop → leave allowlist empty (or set whichever subset you want
  to test)

Then create `config/credentials.json`:

```json
{
  "blacklight": {
    "apiUrl": "https://api.qpeakhire.com",
    "apiKey": "<your-scraper-api-key>"
  },
  "scraperCredentials": {
    "apiUrl": "https://api.qpeakhire.com",
    "apiKey": "<your-scraper-api-key>"
  }
}
```

`config/credentials.json` is **gitignored** — never commit it.

Per-platform credentials (LinkedIn account lease, Indeed cookies, TechFetch
login) live in the central dashboard (Dashboard → Credentials), not in this
file. The scraper pulls them on demand via the `scraperCredentials` API config
above. LinkedIn's authenticated session itself lives in the host's persistent
profile, configured with `npm run linkedin:login`.

## After updating

Node does NOT hot-reload imported source files. After `git pull` you
MUST restart `node server.js` for the new code to take effect. Confirm
with `curl -s http://localhost:3001/healthz | jq .gitSha` — the value
must match `git rev-parse --short HEAD`.

Platform-specific recipes:

- See [docs/SETUP.md](docs/SETUP.md#9-updating)

## Exit codes

`node server.js` exits with a structured code so supervisors can pick a
restart policy:

| Code | Reason | Supervisor action |
|---|---|---|
| 0 | clean SIGINT/SIGTERM | per policy |
| 2 | `auth-dead` — LinkedIn session unrecoverable, no fallback | page humans, do NOT auto-restart |
| 3 | `lease-starved` — credential pool empty for N polls | back off, retry later |
| 42 | `crash` — uncaught exception / unhandled rejection | restart |
| 1 | unknown / startup failure | treat as crash |

## 🎯 Usage

### Start the Server (Production)

```bash
npm start
```

The server will start on `http://localhost:3001` with:
- ✅ REST API endpoints available
- ✅ Auto queue checker running (checks every 30 seconds)
- ✅ Connects to Blacklight backend for queue and credentials

### Development Mode

There is no file-watching script in this package. Run `npm start` and restart
the process after source changes.

## 📡 API Endpoints

### 1. Manual Scraping

Scrape jobs from specific platforms:

```bash
# Single platform
curl -X POST http://localhost:3001/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "dice",
    "jobTitle": "DevOps Engineer",
    "location": "New York"
  }'

# Multiple platforms
curl -X POST http://localhost:3001/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "monster,dice,techfetch",
    "jobTitle": "Software Engineer",
    "location": "California"
  }'

# All platforms
curl -X POST http://localhost:3001/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "all",
    "jobTitle": "Data Scientist",
    "location": "Remote"
  }'
```

### 2. Health Check

```bash
curl http://localhost:3001/
```

Response:
```json
{
  "message": "Unified Job Scraper API is running",
  "version": "1.0.0",
  "platforms": ["monster", "dice", "techfetch", "linkedin", "glassdoor", "indeed"],
  "endpoints": {
    "scrape": "POST /scrape - Scrape jobs from platforms",
    "health": "GET / - API health check"
  }
}
```

## 🔄 Automatic Queue Processing

The scraper automatically:

1. **Checks the Blacklight queue** every 30 seconds
2. **Fetches one or more role assignments** with allowlisted platforms
3. **Scrapes each returned platform** for every assignment
4. **Submits jobs to Blacklight** for matching
5. **Completes each assignment's session** and triggers candidate matching
6. **Repeats** for the next queue batch

### Queue Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    AUTOMATIC WORKFLOW                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Get role assignments from the queue                     │
│  2. For each assignment and platform:                       │
│     a. Get credentials (if needed)                          │
│     b. Scrape jobs                                          │
│     c. Submit to Blacklight                                 │
│  3. Complete each session → Trigger matching                │
│  4. Wait 30s → Repeat                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 📂 Project Structure

```
Job-Scraper/
├── server.js                 # Thin HTTP entry (~85 lines) — wires routes + graceful shutdown
├── package.json
├── README.md
├── docs/BACKEND_API.md       # Blacklight API documentation
├── .gitignore
├── .env.example              # Environment variable template
│
├── config/
│   ├── credentials.example.json   # Template — copy to credentials.json
│   └── credentials.json           # Real secrets (gitignored)
│
├── src/                      # All non-scraping infrastructure
│   ├── config/
│   │   └── env.js            # Env + credentials loader (immutable, validated)
│   ├── logger/
│   │   ├── index.js          # Structured logger with secret masking
│   │   └── loki-transport.js # Buffered log push to Loki /loki/api/v1/push
│   ├── metrics/
│   │   ├── registry.js       # prom-client counters, gauges, histograms
│   │   ├── push.js           # Pushgateway push loop (every 30s)
│   │   ├── heartbeat.js      # scraper_up + heartbeat gauge tick (every 10s)
│   │   └── classify.js       # Error → failure reason mapper
│   ├── http/
│   │   └── client.js         # fetch wrapper: timeout, retry+jitter, circuit breaker
│   ├── api/
│   │   ├── blacklight.js     # Blacklight queue API client
│   │   └── credentials.js    # Scraper credentials API client (lease-based)
│   ├── core/
│   │   ├── errors.js         # Typed error hierarchy (ScraperError, AuthError, …)
│   │   ├── base-scraper.js   # Shared scraper lifecycle + logging
│   │   ├── browser-pool.js   # CloakBrowser launchers with licence-seat leasing
│   │   ├── license-pool.js    # Cross-process CloakBrowser licence-seat pool
│   │   ├── fingerprints.js   # Shared UAs/viewports
│   │   ├── delays.js         # humanDelay, randomDelay, backoff+jitter
│   │   ├── html.js           # stripHtmlTags, sanitizeFilename, hashString
│   │   ├── normalize.js      # Unified master schema normalization
│   │   ├── glassdoor-jd.js   # Shared Glassdoor detail-page parser
│   │   ├── proxy-pool.js     # Per-platform proxy leasing and cooldowns
│   │   └── format.js         # Format for Blacklight API submission
│   ├── scrapers/
│   │   ├── registry.js       # Platform → scraper mapping
│   │   └── linkedin-rsc/     # LinkedIn React Server Components transport
│   ├── queue/
│   │   ├── mutex.js          # Single-slot mutex
│   │   └── orchestrator.js   # QueueOrchestrator (runOnce + auto checker)
│   ├── validation/
│   │   └── schemas.js        # Zod request schemas
│   └── routes/
│       ├── health.js         # GET /
│       ├── scrape.js         # POST /scrape
│       ├── scrape-queue.js   # POST /scrape-queue
│       └── metrics.js        # GET /metrics (Prometheus text format)
│
├── scrapers/                 # Platform-specific scraping logic
│   ├── monster.js            # Monster Jobs (HTTP API)
│   ├── dice.js               # Dice Jobs (CloakBrowser + Crawlee)
│   ├── techfetch.js          # TechFetch (requires login)
│   ├── glassdoor.js          # Glassdoor browser fallback + detail extraction
│   ├── glassdoor-api.js      # Glassdoor /graph discovery + detail enrichment
│   └── indeed.js             # Indeed mobile API + browser fallback
│
├── schemas/
│   └── master-schema.json
│
└── results/                  # Scraped output (gitignored)
```

## 🛠️ Configuration

### Environment Variables

Copy [`.env.example`](.env.example) to `.env` and adjust as needed.
It is the authoritative reference for supported variables and defaults.
For host-oriented configuration, see [the setup guide](docs/SETUP.md#4-env-optional)
and the [scraper runbook](docs/scraper-runbook.md).

### LinkedIn — log in once and capture the RSC template

LinkedIn uses a persistent profile for authentication and browserless RSC
requests.
Follow [the LinkedIn setup steps](docs/SETUP.md#6-linkedin-two-one-time-steps)
to log in and capture the request template.

### Credentials

`config/credentials.json` is **git-ignored** — never commit it. Copy the template:

```bash
cp config/credentials.example.json config/credentials.json
# Then edit with real values
```

### TLS & development mode

The HTTP client validates certificates by default. In development mode
(`NODE_ENV=development`) self-signed certificates are accepted so you can point
at a local Blacklight API. Production always validates.

### Auto queue checker

Automatically enabled when `NODE_ENV != development` **and** `blacklight` is
configured in `credentials.json`. Interval controlled by
`QUEUE_CHECK_INTERVAL_MS`. A single-slot mutex (see `src/queue/mutex.js`) means
overlapping polls never cause concurrent runs.

## 📈 Observability

The scraper ships metrics and logs back through the **same Blacklight
scraper API** it already uses for the queue — no extra URL, no extra
auth, no agent on the host. Outbound HTTPS only. Works through any
NAT/firewall the scraper can already talk to Blacklight from.

### Flow

```
Scraper  ──POST /api/scraper/telemetry/metrics──▶  Flask (api.qpeakhire.com)
                                                        │
                                                        ├─▶ Pushgateway (private net)
                                                        └─▶ Loki         (private net)
```

The backend validates `X-Scraper-API-Key`, **injects** `scraper_key_id`,
`scraper_name`, and `instance` labels (can't be spoofed by clients),
then forwards to Pushgateway and Loki over the private network on
`quantipeak-monitor`.

### Metrics (Prometheus)
- `prom-client` registry in `src/metrics/registry.js`
- Heartbeat every 10s (`scraper_up`, `scraper_last_heartbeat_timestamp_seconds`)
- Push loop every 30s to `POST /api/scraper/telemetry/metrics`
- Local debug endpoint: `GET /metrics` (returns Prometheus text format)
- Exposed series: `scraper_sessions_total`, `scraper_jobs_scraped_total`,
  `scraper_failures_total{reason=...}`, `scraper_session_duration_seconds`,
  `scraper_queue_checks_total`, `scraper_blacklight_api_requests_total`, …

### Logs (Loki)
- `src/logger/loki-transport.js` batches log lines and POSTs to
  `POST /api/scraper/telemetry/logs`
- Every `log.info/warn/error` call is mirrored to Loki with client labels
  `{host, os, mode, level, scope}`; backend adds
  `{app="job-scraper", instance, scraper_name, scraper_key_id}`
- stdout is unaffected — local dev still sees the full pretty output

### Enabling remote telemetry

**Nothing to do.** If `config/credentials.json` already has a `blacklight`
block (which it must for `/scrape-queue` to work), metrics and logs will
automatically flow to the telemetry proxy on startup. Override via
`TELEMETRY_URL` / `TELEMETRY_KEY` only if you want to target a different
backend.

Both sinks are best-effort — a push failure logs a warning and retries
on the next cycle; the scraping loop is never blocked.

### Mode labels
- `SCRAPER_MODE=daemon` — for always-on hosts (VPS, Raspberry Pi). Grafana
  alerts fire when the scraper goes silent for 5+ minutes.
- `SCRAPER_MODE=interactive` (default) — for laptops. No offline alerts.

## 📊 Data Format

Jobs are scraped and normalized to this format before submission:

```json
{
  "platform_job_id": "12345",
  "title": "Senior DevOps Engineer",
  "company": "Acme Corp",
  "location": "New York, NY",
  "description": "Full job description...",
  "url": "https://...",
  "salary_min": 120000,
  "salary_max": 160000,
  "salary_currency": "USD",
  "job_type": "full_time",
  "experience_level": "senior",
  "posted_date": "2026-01-14",
  "is_remote": false
}
```

See `schemas/master-schema.json` for complete schema details.

## 🔐 Credential Management

All per-platform credentials are managed through the central dashboard
(Dashboard → Credentials). The scraper fetches them on demand via the
`scraperCredentials` API config in `config/credentials.json` and reports
success/failure back so the backend can rotate / cool down bad creds.
Long-lived LinkedIn sessions heartbeat their lease and use the returned
`lease_token` for ownership checks.

| Platform | Credential type | Where to set it |
|---|---|---|
| Monster | None — HTTP API behind DataDome (uses a hardcoded reverse-engineered clientid) | n/a |
| Dice | None — public scrape | n/a |
| TechFetch | Email + password | Dashboard → Credentials → TechFetch |
| LinkedIn | Credential lease plus persistent profile (one-time interactive login per host) | Dashboard → Credentials → LinkedIn, then `npm run linkedin:login` and `npm run linkedin:rsc-template` |
| Glassdoor | None for the primary `/graph` API; browser fallback is opt-in | n/a unless the fallback flow is enabled |
| Indeed | JSON cookie array (export from a cleared browser) | Dashboard → Credentials → Indeed |

### IP-binding caveats

Cleared browser sessions (Indeed cookies; DataDome on Monster) are **bound to
the IP that solved the captcha**. Cookies exported from a laptop won't
authenticate when sent from a VM in a different region. Glassdoor's primary
API path warms its own session and uses direct discovery plus separate pooled
detail enrichment; see the deployment-topology table at the top.

## 🐛 Troubleshooting

### "Queue is empty"
- No jobs in the Blacklight queue
- Wait for admin to add roles/locations
- Or use manual `/scrape` endpoint

### "No credentials available"
- No LinkedIn credentials in the backend pool
- Add credentials via Blacklight admin panel
- Scraper will automatically fetch them from the API

### Browser Installation Issues

```bash
# CloakBrowser provisions its browser on first launch.
# On Linux, install the host libraries required by Chromium if needed.
npm start
```

### Module Import Errors

Ensure `package.json` has `"type": "module"` for ES6 imports:

```json
{
  "type": "module"
}
```

## 📝 Logs

The scraper provides detailed console logs:

```
[2:30:15 pm] [DICE] Searching for "DevOps Engineer" in "New York"
[2:30:16 pm] [DICE] Page 1: Found 60 job URLs
[2:30:17 pm] [DICE] Total unique job URLs found: 100
[2:30:45 pm] [DICE] ✅ Job saved: Senior DevOps Engineer at Acme Corp (Total: 25)
[2:31:22 pm] [DICE] Completed! Saved 100 detailed jobs
```

## 🚦 Status Codes

- `200` - Success
- `202` - Accepted (async processing)
- `400` - Bad Request (invalid parameters)
- `404` - Not Found (invalid platform)
- `409` - Conflict (credential lease ownership conflict)
- `500` - Internal Server Error

## 📚 API Documentation

Full Blacklight API documentation is available in [docs/BACKEND_API.md](docs/BACKEND_API.md)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License - See LICENSE file for details

## 🔗 Links

- **Repository**: https://github.com/NarayanaSabari/Blacklight-Scraper
- **Blacklight Backend (production)**: https://api.qpeakhire.com
- **Central Dashboard**: https://central.qpeakhire.com
- **Grafana**: https://grafana.qpeakhire.com
- **Host setup (all platforms)**: [docs/SETUP.md](docs/SETUP.md)

## 💡 Tips

1. **Rate Limiting**: The scraper respects platform rate limits automatically
2. **Concurrency**: Scrapes multiple jobs in parallel (configurable in scraper files)
3. **Resilience**: Continues even if some jobs fail
4. **Deduplication**: Blacklight backend handles duplicate detection
5. **Monitoring**: Check logs for detailed progress information

## 🆘 Support

For issues, questions, or contributions:
- Open an issue on GitHub
- Check existing issues for solutions
- Review the API documentation in `docs/BACKEND_API.md`

---

**Happy Scraping! 🎉**
