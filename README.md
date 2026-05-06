# Unified Job Scraper

A powerful Node.js-based job scraping system that automatically collects job postings from multiple platforms (Monster, Dice, TechFetch, LinkedIn, Glassdoor, Indeed) and integrates with the Blacklight backend for job matching.

## 🚀 Features

- **Multi-Platform Support**: Scrapes jobs from 6 major platforms
  - Monster
  - Dice Jobs
  - TechFetch
  - LinkedIn
  - Glassdoor
  - Indeed

- **Blacklight Integration**: Seamless integration with Blacklight backend API
  - Queue-based role+location workflow
  - Automatic job submission and duplicate detection
  - Session management and progress tracking
  - Credential management for authenticated platforms

- **Automated Queue Processing**: Auto-checks queue every 30 seconds
- **Express API**: REST API for manual scraping and status checks
- **Credential Management**: Handles authentication for LinkedIn and Glassdoor
- **Robust Error Handling**: Graceful failure recovery and detailed logging

## 📋 Prerequisites

- **Node.js** v18 or higher
- **npm** v9 or higher
- **Playwright** browsers (auto-installed)

## 🔧 Installation

### 1. Clone the Repository

```bash
git clone https://github.com/guruvedhanth-s/Scraper.git
cd Scraper
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

Create a `config/credentials.json` file with the following structure:

```json
{
  "blacklight": {
    "apiUrl": "https://blacklight-backend-kko63bb3aa-el.a.run.app",
    "apiKey": "your-scraper-api-key-here"
  },
  "scraperCredentials": {
    "apiUrl": "https://blacklight-backend-kko63bb3aa-el.a.run.app",
    "apiKey": "your-scraper-api-key-here"
  }
}
```

**Important**:
- Replace `your-scraper-api-key-here` with your actual Blacklight API key
- LinkedIn, Glassdoor, Indeed, and TechFetch credentials can be fetched from the Blacklight backend or loaded from this file in local mode
- **Never commit this file to version control.** It contains real credentials — add `config/credentials.json` to `.gitignore` before pushing. (This is tracked as a bug in the upcoming security PR.)

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

### LinkedIn — launch Chrome for interactive login

LinkedIn scraping uses Chrome DevTools Protocol, which requires a
real Chrome running with `--remote-debugging-port=9222`. Run this
once before starting the scraper so you can log in manually (and
solve any security challenges LinkedIn throws):

```bash
npm run chrome:login
```

This:
- Launches Chrome with `--user-data-dir=~/chrome-debug-profile` (separate
  from your regular browser — they can run side-by-side)
- Opens `linkedin.com/feed` in the new window
- Is idempotent — if a Chrome is already running on port 9222 it
  prints guidance and exits cleanly
- Picks the right Chrome binary per OS (macOS / Windows / Linux);
  override with `CHROME_PATH=/custom/chrome`

After logging in once, cookies persist in `~/chrome-debug-profile`
across restarts, so subsequent launches remember your session.

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

### LinkedIn & Glassdoor Credentials

Both LinkedIn and Glassdoor scraping require authentication. The scraper automatically:
1. **Fetches credentials** from Blacklight backend API
2. **Uses credentials** for authenticated scraping
3. **Reports success/failure** back to API for credential management

**No manual credential configuration needed!** All credentials are managed through the Blacklight backend admin panel.

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

- **Repository**: https://github.com/guruvedhanth-s/Scraper.git
- **Blacklight Backend**: https://blacklight-backend-kko63bb3aa-el.a.run.app
- **Issues**: https://github.com/guruvedhanth-s/Scraper/issues

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
