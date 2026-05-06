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
│     └── Returns: session_id, role, platforms[]                         │
│        (platforms filtered by this key's platform_allowlist if set)    │
│                                                                         │
│  2. For each platform:                                                  │
│     a. If platform requires credentials (linkedin, glassdoor, etc.):   │
│        GET /api/scraper-credentials/queue/{platform}/next              │
│        └── Returns: email, password (or cookies for glassdoor)         │
│                                                                         │
│     b. Scrape jobs using credentials (if applicable)                   │
│                                                                         │
│     c. Report credential result:                                        │
│        - POST .../queue/{id}/success  (success - release credential)   │
│        - POST .../queue/{id}/failure  (failed - mark as failed)        │
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

Fetch the next role from the queue to scrape.

**Important:** A scraper can only have ONE active session at a time. Complete or fail the current session before requesting a new one.

The `platforms[]` returned is filtered to this API key's `platform_allowlist`
(if set). Multiple scrapers can work the same role concurrently — each gets
only its allowed platforms back. The role finalizes (and matching fires) only
after all sibling sessions for that role complete.

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
    { "id": 3, "name": "monster", "display_name": "Monster" },
    { "id": 4, "name": "glassdoor", "display_name": "Glassdoor" },
    { "id": 5, "name": "techfetch", "display_name": "TechFetch" },
    { "id": 6, "name": "dice", "display_name": "Dice" }
  ]
}
```

#### Empty Queue Response (204 No Content)
No body - queue is empty, nothing to scrape.

#### Active Session Conflict (409 Conflict)
```json
{
  "error": "Conflict",
  "message": "Scraper already has an active session: 9405a3de-904a-46dd-84fb-02464f872cb0. Complete it before requesting a new role.",
  "code": "ACTIVE_SESSION_EXISTS"
}
```

---

### 2. Check Current Session (Optional)

Check if the scraper has an active session. Useful for resuming after a restart.

```
GET /api/scraper/queue/current-session
```

#### Request
```bash
curl -X GET "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper/queue/current-session" \
  -H "X-Scraper-API-Key: your-api-key"
```

#### Has Active Session (200 OK)
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

#### No Active Session (200 OK)
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
        "is_remote": false
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


def report_credential_success(credential_id: int):
    """Report successful use of a credential."""
    requests.post(
        f"{BASE_URL}/api/scraper-credentials/queue/{credential_id}/success",
        headers=HEADERS
    )


def report_credential_failure(credential_id: int, error: str, cooldown_minutes: int = None):
    """Report credential failure."""
    payload = {"error_message": error}
    if cooldown_minutes:
        payload["cooldown_minutes"] = cooldown_minutes
    
    requests.post(
        f"{BASE_URL}/api/scraper-credentials/queue/{credential_id}/failure",
        headers=HEADERS,
        json=payload
    )


def scrape_jobs(default_location="United States"):
    while True:
        # 1. Get next role (platforms filtered by this key's platform_allowlist)
        response = requests.get(
            f"{BASE_URL}/api/scraper/queue/next-role",
            headers=HEADERS
        )

        if response.status_code == 204:
            print("Queue empty, waiting...")
            time.sleep(60)
            continue

        if response.status_code == 409:
            print(f"Active session exists: {response.json()}")
            break

        data = response.json()
        session_id = data["session_id"]
        role_name = data["role"]["name"]
        platforms = data["platforms"]
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
                    print(f"    Using credential: {credential.get('email') or credential.get('name')}")
                
                # Your scraping logic here
                jobs = scrape_platform(platform_name, role_name, location, credential)
                
                # Report credential success if used
                if credential_id:
                    report_credential_success(credential_id)
                
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
                    report_credential_failure(credential_id, str(e), cooldown_minutes=60)
                
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
                    report_credential_failure(credential_id, str(e))
                
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
                        headers=HEADERS
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
        credential: Optional dict with login credentials
                   - LinkedIn/Techfetch: {"email": "...", "password": "..."}
                   - Glassdoor: {"credentials": {"cookie": "...", "csrf_token": "..."}}
    """
    jobs = []
    
    if platform_name == "linkedin" and credential:
        # Use credential["email"] and credential["password"] to login
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

### Get Credentials for a Platform

Fetch the next available credential before scraping a platform that requires login.

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
  "email": "user@example.com",
  "password": "secret123"
}
```

#### Response - Glassdoor (200 OK)
```json
{
  "id": 1,
  "platform": "glassdoor",
  "name": "Cookie Set 1",
  "credentials": {
    "cookie": "session_id=abc123",
    "csrf_token": "xyz789"
  }
}
```

#### No Credentials Available (204 No Content)
No body - all credentials are either in use, failed, or on cooldown.

---

### Report Credential Success

After successfully using a credential, report success to release it back to the pool.

```
POST /api/scraper-credentials/queue/{credential_id}/success
```

#### Request
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper-credentials/queue/1/success" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"message": "Scraped 50 jobs successfully"}'
```

#### Response (200 OK)
```json
{
  "message": "Credential released successfully",
  "status": "available"
}
```

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
    "error_message": "Login failed: Invalid credentials"
  }'
```

#### Request with Cooldown (Rate Limited)
```bash
curl -X POST "https://blacklight-backend-kko63bb3aa-el.a.run.app/api/scraper-credentials/queue/1/failure" \
  -H "X-Scraper-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "error_message": "Rate limited by LinkedIn",
    "cooldown_minutes": 60
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

---

### Credential Statuses

| Status | Description |
|--------|-------------|
| `available` | Credential is ready to be used |
| `in_use` | Credential is currently assigned to a scraper |
| `failed` | Credential has failed (e.g., invalid password, account locked) |
| `disabled` | Credential is manually disabled by admin |
| `cooldown` | Credential is temporarily unavailable (rate limited) |

---

### Platforms Requiring Credentials

| Platform | Auth Type | Fields Returned |
|----------|-----------|-----------------|
| `linkedin` | Email/Password | `email`, `password` |
| `glassdoor` | Cookies/JSON | `credentials` (object with cookies, tokens) |
| `techfetch` | Email/Password | `email`, `password` |
| `indeed` | None | No credentials needed |
| `monster` | None | No credentials needed |
| `ziprecruiter` | None | No credentials needed |
| `dice` | None | No credentials needed |

> **Full Credentials API Documentation:** See [SCRAPER_CREDENTIALS_API.md](./SCRAPER_CREDENTIALS_API.md) for complete CRUD operations and admin endpoints.

---

## Important Notes

1. **One Session at a Time**: Each scraper can only have one active session. Complete or fail the current session before requesting a new one.

2. **Batch Processing**: Jobs are processed in batches of 20. Large submissions are automatically split.

3. **Duplicate Detection**: The backend automatically detects and skips duplicate jobs based on:
   - Platform + Platform Job ID
   - Title + Company + Location
   - Title + Company + Description similarity

4. **Async Processing**: Job imports are processed asynchronously. The session completion happens after all batches finish processing.

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
| 409 | Conflict (active session exists) |
| 500 | Internal Server Error |
