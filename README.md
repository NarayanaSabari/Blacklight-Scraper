# Unified Job Scraper

Node.js scraper that pulls job postings from Monster, Dice, TechFetch,
LinkedIn, Glassdoor, and Indeed and feeds them into the Blacklight
backend for matching.

## Deployment topology

The six platforms split across two hosts based on what they tolerate:

| Host | Platforms | Why |
|---|---|---|
| **Hetzner VM** (Linux, datacenter IP) | `monster, dice, techfetch` | HTTP-API or cookie-only flows; headless Chromium fine; tolerates datacenter IP |
| **Windows machine** (residential IP) | `linkedin, glassdoor, indeed` | Need a headed Chrome (LinkedIn CDP, Glassdoor visible window) **and** a clean residential IP — Indeed and Monster are both behind Cloudflare/DataDome anti-bot which 403s the VM IP at the edge |

Both hosts run the **same code**. Each gets its own scraper API key with
a `platform_allowlist` set in the central dashboard (Dashboard → API
Keys), and the backend routes each queued role to the right host based
on the key's allowlist. Adding a new host = registering a new key.

**Setting up a fresh residential host**:
- 🪟 [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md)
- 🍎 [docs/MAC_SETUP.md](docs/MAC_SETUP.md)

## 🚀 What this scraper does

- **Queue-driven** — polls the Blacklight backend every 30s, claims a
  role, scrapes all platforms in its allowlist **in parallel** within a
  single session, submits jobs back, completes the session
- **Multi-platform** — Monster (HTTP API behind DataDome), Dice (Crawlee
  + Cheerio), TechFetch (Playwright + login), LinkedIn (CDP to a real
  Chrome with persistent profile), Glassdoor (cookie auth + stealth
  Playwright), Indeed (cookie auth + stealth Playwright)
- **Express API** for manual scraping (`POST /scrape`)
- **Credential management** via the backend — credentials live in the
  central dashboard, scraper fetches them on demand
- **Observability** — Prometheus metrics + Loki logs ship through the
  Blacklight API to Grafana

## 📋 Prerequisites

- **Node.js** ≥ 20 LTS
- **npm** ≥ 10
- **Google Chrome** (only on hosts that scrape LinkedIn)
- **Playwright Chromium** — installed below

## 🔧 Installation (Linux dev / VM)

If you're setting up a fresh **residential** host for production, use
the OS-specific runbooks instead — they cover dashboard setup,
launchd/NSSM service wrapping, and the exact troubleshooting we've
hit:
- 🪟 [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md)
- 🍎 [docs/MAC_SETUP.md](docs/MAC_SETUP.md)

The instructions below cover the manual / dev-laptop path on
Linux/macOS.

### 1. Clone the Repository

```bash
git clone https://github.com/NarayanaSabari/Blacklight-Scraper.git
cd Blacklight-Scraper
```

### 2. Install Dependencies

```bash
npm install
```

This will install all required packages including:
- Express.js (Web server)
- Crawlee (Web scraping framework)
- Playwright (Browser automation)
- Cheerio (HTML parsing)
- JSDOM (DOM manipulation)

### 3. Install Playwright Browsers

```bash
npx playwright install
```

This downloads Chromium, Firefox, and WebKit browsers used for scraping.

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

Per-platform credentials (LinkedIn email/password, Glassdoor cookies,
Indeed cookies, TechFetch login) live in the central dashboard
(Dashboard → Credentials), not in this file. The scraper pulls them on
demand via the `scraperCredentials` API config above.

## 🎯 Usage

### Start the Server (Production)

```bash
npm start
```

The server will start on `http://localhost:3001` with:
- ✅ REST API endpoints available
- ✅ Auto queue checker running (checks every 30 seconds)
- ✅ Connects to Blacklight backend for queue and credentials

### Development Mode (with auto-restart)

```bash
npm run dev
```

Auto-restarts the server when you make code changes.

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
2. **Fetches the next role+location** to scrape
3. **Scrapes all configured platforms** for that role
4. **Submits jobs to Blacklight** for matching
5. **Completes the session** and triggers candidate matching
6. **Repeats** for the next queue item

### Queue Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    AUTOMATIC WORKFLOW                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Check active session                                    │
│  2. Get next role+location from queue                       │
│  3. For each platform:                                      │
│     a. Get credentials (if needed)                          │
│     b. Scrape jobs                                          │
│     c. Submit to Blacklight                                 │
│  4. Complete session → Trigger matching                     │
│  5. Wait 30s → Repeat                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 📂 Project Structure

```
Job-Scraper/
├── server.js                 # Thin HTTP entry (~85 lines) — wires routes + graceful shutdown
├── package.json
├── README.md
├── Complete API.md           # Blacklight API documentation
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
│   │   ├── browser.js        # Playwright launch helpers (withBrowser cleanup guarantee)
│   │   ├── fingerprints.js   # Shared UAs/viewports
│   │   ├── cookies.js        # Unified cookie loader
│   │   ├── delays.js         # humanDelay, randomDelay, backoff+jitter
│   │   ├── html.js           # stripHtmlTags, sanitizeFilename, hashString
│   │   ├── normalize.js      # Unified master schema normalization
│   │   └── format.js         # Format for Blacklight API submission
│   ├── scrapers/
│   │   └── registry.js       # Platform → scraper mapping
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
├── scrapers/                 # Platform-specific scraping logic (unchanged selectors/flows)
│   ├── monster.js            # Monster Jobs (HTTP API)
│   ├── dice.js               # Dice Jobs (Playwright + Crawlee)
│   ├── techfetch.js          # TechFetch (requires login)
│   ├── linkedin.js           # LinkedIn (CDP to existing Chrome)
│   ├── glassdoor.js          # Glassdoor (cookie auth + stealth)
│   └── indeed.js             # Indeed (cookie auth + stealth)
│
├── schemas/
│   └── master-schema.json
│
└── results/                  # Scraped output (gitignored)
```

## 🛠️ Configuration

### Environment Variables

Copy `.env.example` to `.env` and adjust as needed:

```bash
NODE_ENV=production             # 'development' disables auto queue + uses local credentials
PORT=3001
LOG_LEVEL=info                  # debug | info | warn | error
QUEUE_CHECK_INTERVAL_MS=30000   # Auto queue poll interval
QUEUE_CHECK_STARTUP_DELAY_MS=5000

# LinkedIn CDP
CHROME_PATH=/usr/bin/google-chrome
CDP_PORT=9222

# Observability (optional — auto-enabled when blacklight.apiUrl is configured)
INSTANCE_ID=                    # Unique host identifier; defaults to os.hostname()
SCRAPER_MODE=interactive        # daemon | interactive (daemon fires offline alerts)
TELEMETRY_URL=                  # Override telemetry base URL (default: blacklight.apiUrl)
TELEMETRY_KEY=                  # Override telemetry key (default: blacklight.apiKey)
```

### LinkedIn — log in once to the persistent stealth profile

LinkedIn scraping uses a long-lived CloakBrowser stealth profile stored on
disk. Log in by hand once; the session persists across scraper runs and
rotates organically (no per-run cookie injection):

```bash
npm run linkedin:login
```

This:
- Opens a **headed** CloakBrowser on the scraper's persistent profile dir
  (`~/.blacklight-linkedin-profile`; override with `LINKEDIN_PROFILE_DIR`)
- Navigates to `linkedin.com/login` — log in (and solve any challenge), then
  press Enter in the terminal to save + close
- `npm start` then reuses this exact logged-in session (one warm browser for
  the whole process, a fresh tab per role)

After logging in once, the session persists in the profile dir across
restarts, so subsequent scraper runs remember your login.

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

| Platform | Credential type | Where to set it |
|---|---|---|
| Monster | None — HTTP API behind DataDome (uses a hardcoded reverse-engineered clientid) | n/a |
| Dice | None — public scrape | n/a |
| TechFetch | Email + password | Dashboard → Credentials → TechFetch |
| LinkedIn | Email + password (one-time interactive login per host, then persistent profile) | Dashboard → Credentials → LinkedIn |
| Glassdoor | JSON cookie array (export from a cleared browser) | Dashboard → Credentials → Glassdoor |
| Indeed | JSON cookie array (export from a cleared browser) | Dashboard → Credentials → Indeed |

### IP-binding caveats

Cleared browser sessions (Glassdoor, Indeed cookies; DataDome on Monster)
are **bound to the IP that solved the captcha**. Cookies exported from a
laptop won't authenticate when sent from a VM in a different region.
This is why LinkedIn/Glassdoor/Indeed run on a residential Windows host
rather than the VM — see the deployment-topology table at the top.

## 🐛 Troubleshooting

### "Queue is empty"
- No jobs in the Blacklight queue
- Wait for admin to add roles/locations
- Or use manual `/scrape` endpoint

### "Active session exists"
- A scraping session is already in progress
- Wait for it to complete or fail
- Check session status in Blacklight admin panel

### "No credentials available"
- No LinkedIn/Glassdoor credentials in the backend pool
- Add credentials via Blacklight admin panel
- Scraper will automatically fetch them from the API

### Playwright Installation Issues

```bash
# Force reinstall browsers
npx playwright install --force

# Install system dependencies (Linux)
npx playwright install-deps
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
- `409` - Conflict (active session exists)
- `500` - Internal Server Error

## 📚 API Documentation

Full Blacklight API documentation is available in [Complete API.md](Complete%20API.md)

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
- **Windows host setup**: [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md)
- **Mac host setup**: [docs/MAC_SETUP.md](docs/MAC_SETUP.md)

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
- Review the API documentation in `Complete API.md`

---

**Happy Scraping! 🎉**
