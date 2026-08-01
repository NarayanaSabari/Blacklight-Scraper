# Blacklight Scraper API Documentation

## Overview

This document describes the API endpoints for the Blacklight job scraper to interact with the backend. The scraper uses a **role queue** workflow where each scraping session targets a specific role; the `platforms[]` returned for that session is filtered by the API key's `platform_allowlist` (set per-key in the dashboard), so two scrapers can share the same role and split the platform work between them.

**Base URL:** `https://blacklight-backend-kko63bb3aa-el.a.run.app`

---

## Authentication

All API requests require the `X-Scraper-API-Key` header.

```
X-Scraper-API-Key: your-api-key-here
```

### Error Response (401 Unauthorized)
```json
{
  "error": "Unauthorized",
  "message": "Missing X-Scraper-API-Key header"
}
```

---

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SCRAPER WORKFLOW                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. GET /api/scraper/queue/next-role                                   │
│     └── Returns: assignments[] (each has session_id, role, platforms[])│
│        (platforms filtered by this key's platform_allowlist if set)    │
│                                                                         │
│  2. For each assignment and platform:                                   │
│     a. If platform requires credentials (linkedin, glassdoor, etc.):   │
│        GET /api/scraper-credentials/queue/{platform}/next              │
│        └── Returns: credentials plus lease_token                       │
│                                                                         │
│     b. Scrape jobs using credentials (if applicable)                   │
│                                                                         │
│     c. Report credential result:                                        │
│        - POST .../queue/{id}/success  (terminal or role success)       │
│        - POST .../queue/{id}/failure  (failed - mark as failed)        │
│        - POST .../queue/{id}/heartbeat (long-lived lease)              │
│                                                                         │
│  3. POST /api/scraper/queue/jobs (once per platform)                   │
│     └── Submit jobs for: linkedin, indeed, monster, etc.               │
│     └── Can also report platform failure                               │
│                                                                         │
│  4. POST /api/scraper/queue/complete                                   │
│     └── Finalize session and trigger job matching                      │
│                                                                         │
│  (Optional) POST /api/scraper/queue/fail                               │
│     └── Report complete session failure                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

### 1. Get Next Role

Fetch the next batch of work from the queue.

The response contains zero or more `assignments`. Each assignment has its own
session and role, with `platforms[]` filtered to this API key's
`platform_allowlist` (if set). Multiple scrapers can work the same role
concurrently — each gets only its allowed platforms back. The role finalizes
(and matching fires) only after all sibling sessions for that role complete.

```
GET /api/scraper/queue/next-role
```

#### Request
```bash
curl -X GET "https://api.qpeakhire.com/api/scraper/queue/next-role" \
  -H "X-Scraper-API-Key: your-api-key"
```

#### Success Response (200 OK)
```json
{
  "assignments": [
    {
      "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
      "role": {
        "id": 42,
        "name": "DevOps Engineer",
        "aliases": ["DevOps", "Site Reliability Engineer", "SRE"],
        "category": "Engineering",
        "candidate_count": 15
      },
      "platforms": [
        { "id": 1, "name": "linkedin", "display_name": "LinkedIn" },
        { "id": 2, "name": "indeed", "display_name": "Indeed" },
        { "id": 3, "name": "monster", "display_name": "Monster" }
      ]
    }
  ]
}
```

#### Empty Queue Response (204 No Content)
No body - queue is empty, nothing to scrape.

---

### 2. Check Current Session (Optional)

Check whether this scraper has a recent session eligible for orphan recovery after a restart.

This endpoint is specifically for recovering a claim whose response may have been lost, rather than for listing every active session.
It considers only `in_progress` sessions started within `SCRAPER_ORPHAN_RECOVERY_WINDOW_SECONDS` (5 minutes by default), returns the newest matching session, and returns at most one session.
If the scraper has only older active sessions, this endpoint returns `has_active_session: false`; those sessions must not be resumed by this recovery path.

```
GET /api/scraper/queue/current-session
```

#### Request
```bash
curl -X GET "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper/queue/current-session" \
  -H "X-Scraper-API-Key: your-api-key"
```

#### Has Resumable Session (200 OK)
```json
{
  "has_active_session": true,
  "session": {
    "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
    "role_name": "DevOps Engineer",
    "role_id": 42,
    "status": "in_progress",
    "started_at": "2026-01-13T07:45:00Z",
    "platforms_total": 6,
    "platforms_completed": 2,
    "platforms_failed": 0,
    "jobs_found": 45,
    "jobs_imported": 12
  }
}
```

#### No Resumable Session (200 OK)
```json
{
  "has_active_session": false,
  "session": null
}
```

---

### 3. Submit Jobs for Platform

Submit scraped jobs for a specific platform. Call this once for each platform after scraping.

```
POST /api/scraper/queue/jobs
```

#### Request - Success (Jobs Found)
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper/queue/jobs" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
    "platform": "linkedin",
    "jobs": [
      {
        "platform_job_id": "3847291056",
        "title": "Senior DevOps Engineer",
        "company": "Acme Corp",
        "location": "New York, NY",
        "description": "We are looking for a Senior DevOps Engineer...",
        "url": "https://linkedin.com/jobs/view/3847291056",
        "salary_min": 150000,
        "salary_max": 200000,
        "salary_currency": "USD",
        "job_type": "full_time",
        "experience_level": "senior",
        "posted_date": "2026-01-10",
        "is_remote": false,
        "recruiter": {
          "name": "Jane Doe",
          "profile_url": "https://www.linkedin.com/in/jane-doe",
          "emails": ["jane@example.com"],
          "phones": ["+1 555 0100"]
        }
      },
      {
        "platform_job_id": "3847291057",
        "title": "DevOps Engineer",
        "company": "Tech Startup Inc",
        "location": "New York, NY (Remote)",
        "description": "Join our growing team...",
        "url": "https://linkedin.com/jobs/view/3847291057",
        "job_type": "full_time",
        "is_remote": true
      }
    ]
  }'
```

#### Job Object Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `platform_job_id` | string | Yes | Unique job ID from the platform |
| `title` | string | Yes | Job title |
| `company` | string | Yes | Company name |
| `location` | string | Yes | Job location |
| `description` | string | Yes | Full job description |
| `url` | string | Yes | URL to the job posting |
| `salary_min` | integer | No | Minimum salary |
| `salary_max` | integer | No | Maximum salary |
| `salary_currency` | string | No | Currency code (USD, EUR, etc.) |
| `job_type` | string | No | full_time, part_time, contract, internship |
| `experience_level` | string | No | entry, mid, senior, executive |
| `posted_date` | string | No | Date posted (YYYY-MM-DD) |
| `is_remote` | boolean | No | Whether the job is remote |

LinkedIn jobs may include an optional `recruiter` object when contacts are
extracted from the post body. Its `emails` and `phones` arrays are kept
separate, trimmed, deduplicated, and capped at five entries each; email values
are lowercased. Existing rows are not backfilled, so this field is forward-only.
The portal displays these contacts on the job detail page and uses the first
email for the existing compose flow; the field is not searchable or exportable.

#### Success Response (202 Accepted)
```json
{
  "status": "accepted",
  "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
  "platform": "linkedin",
  "platform_status": "processing",
  "jobs_count": 47,
  "batches": 3,
  "progress": {
    "total_platforms": 6,
    "completed": 1,
    "pending": 4,
    "failed": 0
  }
}
```

#### Request - Platform Failed
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper/queue/jobs" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
    "platform": "indeed",
    "status": "failed",
    "error_message": "Connection timeout after 30 seconds",
    "jobs": []
  }'
```

#### Failure Response (202 Accepted)
```json
{
  "status": "accepted",
  "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
  "platform": "indeed",
  "platform_status": "failed",
  "error_message": "Connection timeout after 30 seconds",
  "jobs_count": 0,
  "progress": {
    "total_platforms": 6,
    "completed": 2,
    "pending": 3,
    "failed": 1
  }
}
```

#### Error Responses

**Platform Already Submitted (400 Bad Request)**
```json
{
  "error": "Bad Request",
  "message": "Platform 'linkedin' already completed"
}
```

**Invalid Platform (400 Bad Request)**
```json
{
  "error": "Bad Request",
  "message": "Platform 'twitter' not found in session"
}
```

**Session Not Found (404 Not Found)**
```json
{
  "error": "Not Found",
  "message": "Session not found or unauthorized"
}
```

---

### 4. Complete Session

Call this after all platforms have submitted their jobs. This triggers job processing and candidate matching.

```
POST /api/scraper/queue/complete
```

#### Request
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper/queue/complete" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0"
  }'
```

#### Success Response (200 OK)
```json
{
  "status": "completing",
  "message": "Session completion triggered",
  "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
  "role_name": "DevOps Engineer",
  "summary": {
    "total_platforms": 6,
    "successful_platforms": 5,
    "failed_platforms": 1,
    "failed_platform_details": [
      { "platform": "indeed", "error": "Connection timeout after 30 seconds" }
    ]
  },
  "jobs": {
    "total_found": 165,
    "total_imported": 42,
    "total_skipped": 123
  },
  "matching_triggered": true
}
```

**Note:** Jobs are processed asynchronously. The `jobs` counts in the response reflect the current state at the time of the call. Final counts may differ after all batches complete.

#### Session Already Completed (400 Bad Request)
```json
{
  "error": "Bad Request",
  "message": "Session already completed"
}
```

---

### 5. Fail Entire Session (Optional)

Report a complete session failure (e.g., scraper crashed, network issues).

```
POST /api/scraper/queue/fail
```

#### Request
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper/queue/fail" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
    "error_message": "Scraper crashed due to memory overflow"
  }'
```

#### Success Response (200 OK)
```json
{
  "session_id": "9405a3de-904a-46dd-84fb-02464f872cb0",
  "status": "failed",
  "error_message": "Scraper crashed due to memory overflow"
}
```

---

### 6. Get Queue Statistics (Optional)

Get statistics about the role queue.

```
GET /api/scraper/queue/stats
```

#### Request
```bash
curl -X GET "https://api.qpeakhire.com/api/scraper/queue/stats" \
  -H "X-Scraper-API-Key: your-api-key"
```

#### Success Response (200 OK)
```json
{
  "by_status": {
    "pending": 50,
    "approved": 20,
    "processing": 3,
    "completed": 200
  },
  "total_pending_candidates": 1234,
  "queue_depth": 20
}
```

---

## Complete Scraper Example (Python)

```python
import requests
import time
from typing import Optional

BASE_URL = "https://blacklight-backend-kko63bb3aa-el.a.run.app"
API_KEY = "your-api-key-here"

HEADERS = {
    "X-Scraper-API-Key": API_KEY,
    "Content-Type": "application/json"
}

# Platforms that require login credentials
PLATFORMS_REQUIRING_CREDENTIALS = {"linkedin", "glassdoor", "techfetch"}


def get_credential(platform: str, session_id: str) -> Optional[dict]:
    """
    Fetch credentials for platforms that require authentication.
    Returns None if no credentials available.
    """
    response = requests.get(
        f"{BASE_URL}/api/scraper-credentials/queue/{platform}/next",
        headers=HEADERS,
        params={"session_id": session_id}
    )
    
    if response.status_code == 204:
        return None
    
    return response.json()


def report_credential_success(credential_id: int, lease_token: str, terminal: bool = True):
    """Report successful use of a credential."""
    payload = {"lease_token": lease_token, "terminal": terminal}
    requests.post(
        f"{BASE_URL}/api/scraper-credentials/queue/{credential_id}/success",
        headers=HEADERS,
        json=payload
    )


def report_credential_failure(
    credential_id: int,
    lease_token: str,
    error: str,
    cooldown_minutes: int = None,
    auth_dead: bool = False,
):
    """Report credential failure."""
    payload = {
        "error_message": error,
        "lease_token": lease_token,
        "auth_dead": auth_dead,
    }
    if cooldown_minutes:
        payload["cooldown_minutes"] = cooldown_minutes
    
    requests.post(
        f"{BASE_URL}/api/scraper-credentials/queue/{credential_id}/failure",
        headers=HEADERS,
        json=payload
    )


def heartbeat_credential(credential_id: int, lease_token: str):
    """Keep a long-lived credential lease alive."""
    requests.post(
        f"{BASE_URL}/api/scraper-credentials/queue/{credential_id}/heartbeat",
        headers=HEADERS,
        json={"lease_token": lease_token},
    )


def scrape_jobs(default_location="United States"):
    while True:
        # 1. Get the next batch (platforms filtered by this key's platform_allowlist)
        response = requests.get(
            f"{BASE_URL}/api/scraper/queue/next-role",
            headers=HEADERS
        )

        if response.status_code == 204:
            print("Queue empty, waiting...")
            time.sleep(60)
            continue

        data = response.json()
        # This example processes one assignment; repeat this block for every
        # item in data["assignments"] in a production scraper.
        assignment = data["assignments"][0]
        session_id = assignment["session_id"]
        role_name = assignment["role"]["name"]
        platforms = assignment["platforms"]
        # The backend no longer drives location-specific scraping; pick a
        # sensible default for per-platform search URLs.
        location = default_location

        print(f"Scraping: {role_name} in {location}")
        print(f"Session: {session_id}")
        print(f"Platforms: {[p['name'] for p in platforms]}")
        
        # 2. Scrape each platform
        for platform in platforms:
            platform_name = platform["name"]
            print(f"  Scraping {platform_name}...")
            
            credential = None
            credential_id = None
            lease_token = None
            
            try:
                # Get credentials if needed
                if platform_name in PLATFORMS_REQUIRING_CREDENTIALS:
                    credential = get_credential(platform_name, session_id)
                    if not credential:
                        print(f"    No credentials available for {platform_name}, skipping...")
                        requests.post(
                            f"{BASE_URL}/api/scraper/queue/jobs",
                            headers=HEADERS,
                            json={
                                "session_id": session_id,
                                "platform": platform_name,
                                "status": "failed",
                                "error_message": "No credentials available",
                                "jobs": []
                            }
                        )
                        continue
                    
                    credential_id = credential["id"]
                    lease_token = credential["lease_token"]
                    print(f"    Using credential: {credential.get('email') or credential.get('name')}")
                
                # Your scraping logic here
                jobs = scrape_platform(platform_name, role_name, location, credential)
                
                # Report credential success if used
                if credential_id:
                    report_credential_success(credential_id, lease_token)
                
                # Submit jobs
                response = requests.post(
                    f"{BASE_URL}/api/scraper/queue/jobs",
                    headers=HEADERS,
                    json={
                        "session_id": session_id,
                        "platform": platform_name,
                        "jobs": jobs
                    }
                )
                
                result = response.json()
                print(f"    Submitted {result.get('jobs_count', 0)} jobs")
                
            except RateLimitError as e:
                # Rate limited - put credential on cooldown
                if credential_id:
                    report_credential_failure(
                        credential_id, lease_token, str(e), cooldown_minutes=60
                    )
                
                requests.post(
                    f"{BASE_URL}/api/scraper/queue/jobs",
                    headers=HEADERS,
                    json={
                        "session_id": session_id,
                        "platform": platform_name,
                        "status": "failed",
                        "error_message": str(e),
                        "jobs": []
                    }
                )
                print(f"    Rate limited: {e}")
                
            except LoginError as e:
                # Login failed - mark credential as failed
                if credential_id:
                    report_credential_failure(credential_id, lease_token, str(e))
                
                requests.post(
                    f"{BASE_URL}/api/scraper/queue/jobs",
                    headers=HEADERS,
                    json={
                        "session_id": session_id,
                        "platform": platform_name,
                        "status": "failed",
                        "error_message": str(e),
                        "jobs": []
                    }
                )
                print(f"    Login failed: {e}")
                
            except Exception as e:
                # General error - release credential without marking as failed
                if credential_id:
                    requests.post(
                        f"{BASE_URL}/api/scraper-credentials/queue/{credential_id}/release",
                        headers=HEADERS,
                        json={"lease_token": lease_token},
                    )
                
                requests.post(
                    f"{BASE_URL}/api/scraper/queue/jobs",
                    headers=HEADERS,
                    json={
                        "session_id": session_id,
                        "platform": platform_name,
                        "status": "failed",
                        "error_message": str(e),
                        "jobs": []
                    }
                )
                print(f"    Failed: {e}")
        
        # 3. Complete session
        response = requests.post(
            f"{BASE_URL}/api/scraper/queue/complete",
            headers=HEADERS,
            json={"session_id": session_id}
        )
        
        result = response.json()
        print(f"Session completed: {result['jobs']['total_imported']} jobs imported")
        
        # Small delay before next session
        time.sleep(5)


def scrape_platform(platform_name: str, role: str, location: str, credential: dict = None) -> list:
    """
    Your platform-specific scraping logic here.
    Returns list of job objects.
    
    Args:
        platform_name: Name of the platform (linkedin, indeed, etc.)
        role: Job role to search for
        location: Location to search in
        credential: Optional dict with platform credential data
                   - LinkedIn: {"profile_key": "...", "lease_token": "...", "email": "...", "password": "..."}
                   - Techfetch: {"email": "...", "password": "..."}
                   - Glassdoor: {"credentials": {"cookie": "...", "csrf_token": "..."}}
    """
    jobs = []
    
    if platform_name == "linkedin" and credential:
        # Read cookies from the already-authenticated persistent profile.
        # Reuse the persistent profile selected by credential["profile_key"];
        # email/password remain available for the login fallback.
        pass
    elif platform_name == "glassdoor" and credential:
        # Use credential["credentials"]["cookie"] for authenticated requests
        pass
    
    # ... scraping code ...
    return jobs


# Custom exceptions for credential handling
class RateLimitError(Exception):
    """Raised when the platform rate limits the scraper."""
    pass

class LoginError(Exception):
    """Raised when login fails."""
    pass


if __name__ == "__main__":
    scrape_jobs()
```

---

---

## Platform Credentials

Some platforms (LinkedIn, Glassdoor, Techfetch) require authentication credentials to scrape. The API provides endpoints to fetch and manage credentials for these platforms.
The response includes an opaque `lease_token` minted for that assignment.
Send that token on every heartbeat and terminal or non-terminal lease action.

### Get Credentials for a Platform

Fetch the next available credential before scraping a platform that requires an
account or credential lease.

```
GET /api/scraper-credentials/queue/{platform}/next
```

#### Request
```bash
curl -X GET "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper-credentials/queue/linkedin/next?session_id=9405a3de-904a-46dd-84fb-02464f872cb0" \
  -H "X-Scraper-API-Key: your-api-key"
```

#### Response - LinkedIn/Techfetch (200 OK)
```json
{
  "id": 1,
  "platform": "linkedin",
  "name": "Account 1",
  "profile_key": "li-acct-1",
  "proxy": null,
  "lease_token": "<opaque-lease-token>",
  "email": "user@example.com",
  "password": "secret123"
}
```

For LinkedIn, `profile_key` selects the host's persistent profile. The
scraper reads that profile's cookies for RSC requests and does not use the
returned password to perform a login.

#### Response - Glassdoor (200 OK)
```json
{
  "id": 1,
  "platform": "glassdoor",
  "name": "Cookie Set 1",
  "lease_token": "<opaque-lease-token>",
  "credentials": {
    "cookie": "session_id=abc123",
    "csrf_token": "xyz789"
  }
}
```

#### No Credentials Available (204 No Content)
No body - all credentials are either in use, failed, on cooldown, or awaiting
operator re-login.

---

### Report Credential Success

After successfully using a credential, report success.
By default this releases the credential back to the pool.
For a long-lived lease, send `terminal: false` to record role success without
releasing the credential.

```
POST /api/scraper-credentials/queue/{credential_id}/success
```

#### Request
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper-credentials/queue/1/success" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"message": "Scraped 50 jobs successfully", "lease_token": "<opaque-lease-token>"}'
```

`lease_token` is preferred.
The deprecated `session_id` fallback is accepted during rolling deployment,
but at least one identifier is required; sending neither returns `400`.

#### Response (200 OK)
```json
{
  "message": "Credential released successfully",
  "status": "available"
}
```

Use `"terminal": false` for a non-terminal role report.
The response then has `"message": "Credential success recorded"` and
`"status": "in_use"`.

---

### Report Credential Failure

If a credential fails (e.g., invalid password, account locked), report the failure.

```
POST /api/scraper-credentials/queue/{credential_id}/failure
```

#### Request
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper-credentials/queue/1/failure" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "error_message": "Login failed: Invalid credentials",
    "lease_token": "<opaque-lease-token>"
  }'
```

`lease_token` is preferred.
The deprecated `session_id` fallback is accepted for older scraper builds,
but at least one identifier is required; sending neither returns `400`.

#### Request with Cooldown (Rate Limited)
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper-credentials/queue/1/failure" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "error_message": "Rate limited by LinkedIn",
    "cooldown_minutes": 60,
    "lease_token": "<opaque-lease-token>"
  }'
```

#### Response (200 OK)
```json
{
  "message": "Credential failure recorded",
  "status": "failed",
  "failure_count": 3
}
```

Set `"auth_dead": true` when the account needs operator re-login.
That response uses status `needs_relogin` and removes the credential from the
claimable pool.

If a supplied `lease_token` or legacy `session_id` no longer owns the
credential, the endpoint returns `409 Conflict` and leaves the current lease
untouched.

---

### Heartbeat a Long-Lived Lease

Any long-running scraper operation must heartbeat its credential more often
than the 10-minute stale-assignment timeout.
The heartbeat refreshes `assigned_at`; it does not release the lease.
The LinkedIn RSC scraper runs this ticker for the duration of `withCookies()`;
its HTTP scrape does not keep a browser session open.

```
POST /api/scraper-credentials/queue/{credential_id}/heartbeat
```

#### Request

```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper-credentials/queue/1/heartbeat" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"lease_token": "<opaque-lease-token>"}'
```

`lease_token` is preferred.
The legacy `session_id` may be supplied instead during rolling deployment,
but at least one identifier is required for heartbeat.
An ownership failure returns `409 Conflict`; the scraper must stop using that
credential and acquire another lease before continuing.

---

### Stale Lease Recovery

The backend reaper runs every 10 minutes and reclaims `in_use` credentials whose `assigned_at` has not been refreshed for 10 minutes.
A reap clears the lease and increments the credential's consecutive-reap streak.

Before the streak reaches `SCRAPER_REAP_ESCALATE_AFTER` (3 by default), the credential enters `cooldown` for `SCRAPER_REAP_COOLDOWN_SECONDS` (5 minutes by default).
A successful lease report resets the streak.
When the threshold is reached, a credential with `profile_key` moves to `needs_relogin`; other credentials move to `failed`.
The cooldown cron runs every 5 minutes and returns expired cooldowns to `available` without operator action.

The backend settings are configurable with `SCRAPER_ORPHAN_RECOVERY_WINDOW_SECONDS`, `SCRAPER_REAP_COOLDOWN_SECONDS`, and `SCRAPER_REAP_ESCALATE_AFTER`.

---

### Release a Credential

Release a lease without recording success or failure.

```
POST /api/scraper-credentials/queue/{credential_id}/release
```

Send `lease_token` in the JSON body.
The legacy `session_id` fallback remains accepted for old scraper hosts,
but at least one identifier is required; sending neither returns `400`.

---

### Credential Statuses

| Status | Description |
|--------|-------------|
| `available` | Credential is ready to be used |
| `in_use` | Credential is currently assigned to a scraper |
| `failed` | Credential has failed (e.g., an invalid account session or locked account) |
| `disabled` | Credential is manually disabled by admin |
| `cooldown` | Credential is temporarily unavailable, such as after rate limiting or a stale-lease reap |
| `needs_relogin` | Warm profile needs operator re-login |

---

### Platforms Requiring Credentials

| Platform | Auth Type | Fields Returned |
|----------|-----------|-----------------|
| `linkedin` | Persistent/warm profile or email/password + credential lease | `profile_key`, `lease_token`, `email`, `password` |
| `glassdoor` | Cookies/JSON | `credentials` (object with cookies, tokens) |
| `techfetch` | Email/Password | `email`, `password` |
| `indeed` | None | No credentials needed |
| `monster` | None | No credentials needed |
| `ziprecruiter` | None | No credentials needed |
| `dice` | None | No credentials needed |

---

## Important Notes

1. **Assignments**: A queue poll may return multiple role assignments. Complete
   each assignment's session independently before requesting more work.

2. **Batch Processing**: Jobs are processed in batches of 20. Large submissions are automatically split.

3. **Duplicate Detection**: The backend automatically detects and skips duplicate jobs based on:
   - Platform + Platform Job ID
   - Title + Company + Location
   - Title + Company + Description similarity

4. **Async Processing**: Job imports are processed asynchronously.
   Session completion happens after all batches are accounted for, including
   batches that permanently fail after retries are exhausted.

5. **Rate Limiting**: There is no explicit rate limiting, but avoid sending more than 1 request per second per endpoint.

6. **Error Handling**: Always handle 4xx and 5xx errors gracefully. The scraper should be able to recover from temporary failures.

---

## Status Codes Summary

| Code | Description |
|------|-------------|
| 200 | Success |
| 202 | Accepted (async processing started) |
| 204 | No Content (queue empty) |
| 400 | Bad Request (invalid input) |
| 401 | Unauthorized (invalid API key) |
| 404 | Not Found (session not found) |
| 409 | Conflict (credential lease ownership conflict) |
| 500 | Internal Server Error |
