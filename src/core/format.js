// Translates a normalized job into the Blacklight API request body.
// Moved out of common/utils.js so server.js has zero scraping concerns.
//
// MATCHED PAIR NOTICE: the field list emitted by formatJobForBlacklight()
// below is mirrored by ScrapedJobPayload in
// server/app/schemas/scraper_ingest_schema.py, which validates this exact
// shape at the POST /api/scraper/queue/jobs ingest boundary. If you add,
// rename, or remove a field here, update that schema too — see SCR-19 /
// issue #402.

import { createHash } from 'crypto';
import { hashString } from './html.js';

const VALID_STRING = (value) =>
    value && value !== 'N/A' && typeof value === 'string';

// SCR-7 (#390): CANONICAL synthetic dedup key.
//
// MATCHED PAIR: `_synthetic_external_id` in
// server/app/inngest/functions/job_import.py must produce the byte-identical
// string for the same inputs. If you change the field list, the separator, the
// normalisation, the hash, or the truncation length, change BOTH — otherwise the
// scraper and the backend (and the Apify producer, see #404) mint different keys
// for one posting and it inserts twice instead of deduping.
//
// Why content and not time/random: the previous fallback was
// `${platform}-${Date.now()}-${Math.random()}`, so the SAME posting got a new key
// on every cycle and re-inserted forever, which is the exact opposite of a dedup
// key. Content-derived means the same posting yields the same key across
// sessions, hosts and producers.
//
// Trade-off, deliberately accepted: two genuinely different postings sharing
// platform+title+company+location collide and the second is skipped as a
// duplicate. Description is NOT included because scrapes of one posting differ in
// whitespace and truncation, which would make the key unstable — and an unstable
// key is the bug being fixed. On this platform, same title + same company + same
// location is the same opening for dedup purposes.
export function syntheticExternalId(platform, { title, company, location } = {}) {
    const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const basis = [norm(platform), norm(title), norm(company), norm(location)].join('|');
    return `syn-${createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * @param content Already-EXTRACTED title/company/location strings.
 *   Deliberately passed in rather than re-read off the raw job here: the nested
 *   schema puts them at job.company.name / job.location.formatted, so reading
 *   `job.company` raw yields an OBJECT. Stringifying that gives
 *   "[object Object]" for every posting, which would hash them all to ONE key —
 *   a far worse dedup bug than the random ids this replaces.
 */
function pickPlatformJobId(jobData, job, platform, content) {
    const candidates = [
        jobData.jobId, jobData.postId, jobData.id,
        job.jobId, job.postId, job.id,
    ];
    for (const candidate of candidates) {
        if (VALID_STRING(candidate)) return candidate;
    }

    const url = jobData.url || jobData.applyUrl || job.url || job.applyUrl || '';
    if (VALID_STRING(url)) return hashString(url);

    // No platform id and no URL: fall back to a STABLE content hash rather than
    // minting a fresh id per scrape.
    return syntheticExternalId(platform, content);
}

function extractString(value, fallback = 'N/A') {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof value.name === 'string') return value.name;
    if (value && typeof value === 'object' && typeof value.formatted === 'string') return value.formatted;
    return fallback;
}

// Normalize "Full Time" / "full-time" → "full_time"
function slugifyEnum(value) {
    return String(value).toLowerCase().replace(/[\s-]/g, '_');
}

// Post bodies are attacker-controlled public text: cap and sanitise recruiter
// contacts here, at the wire boundary, so a post stuffed with addresses can't
// become a wall of contacts downstream.
const MAX_CONTACTS = 5;
const MAX_CONTACT_LENGTH = 254;

function sanitizeContactList(values, { lowercase = false } = {}) {
    const seen = new Set();
    const out = [];
    for (const raw of values ?? []) {
        if (typeof raw !== 'string') continue;
        let value = raw.trim().slice(0, MAX_CONTACT_LENGTH);
        if (!value) continue;
        if (lowercase) value = value.toLowerCase();
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
        if (out.length >= MAX_CONTACTS) break;
    }
    return out;
}

export function formatJobForBlacklight(job, platform) {
    // Accept both nested (normalized) and flat scraper output.
    const jobData = job.job ?? job;
    const companyData = job.company ?? {};
    const locationData = job.location ?? {};
    const compensationData = job.compensation ?? {};
    const employmentData = job.employment ?? {};
    const experienceData = job.experience ?? {};

    const title = jobData.title ?? job.title ?? 'N/A';
    const description = jobData.description ?? job.description ?? '';
    const url = jobData.url ?? jobData.applyUrl ?? job.url ?? job.applyUrl ?? '';
    const company = extractString(companyData.name ?? job.company);
    const location = extractString(locationData.formatted ?? job.location);
    // Computed AFTER extraction so the synthetic-id fallback hashes real strings
    // rather than the nested objects (see pickPlatformJobId).
    const platformJobId = pickPlatformJobId(jobData, job, platform, { title, company, location });

    const formatted = {
        platform_job_id: platformJobId,
        title,
        company,
        location,
        description,
        url,
    };

    const salaryMin = compensationData.salaryMin ?? job.salary_min ?? job.salaryMin ?? null;
    const salaryMax = compensationData.salaryMax ?? job.salary_max ?? job.salaryMax ?? null;
    const salaryCurrency = compensationData.currency ?? job.salary_currency ?? 'USD';

    if (salaryMin) formatted.salary_min = Number.parseInt(salaryMin, 10);
    if (salaryMax) formatted.salary_max = Number.parseInt(salaryMax, 10);
    if (salaryCurrency && salaryCurrency !== 'N/A') formatted.salary_currency = salaryCurrency;

    const jobType = employmentData.type ?? job.job_type ?? job.jobType ?? job.employmentType ?? null;
    if (jobType && jobType !== 'N/A') formatted.job_type = slugifyEnum(jobType);

    const experienceLevel = experienceData.level ?? job.experience_level ?? job.experienceLevel ?? null;
    if (experienceLevel && experienceLevel !== 'N/A') formatted.experience_level = String(experienceLevel).toLowerCase();

    const postedDate = jobData.postedDate ?? job.posted_date ?? job.postedDate ?? null;
    if (postedDate && /^\d{4}-\d{2}-\d{2}/.test(postedDate)) {
        formatted.posted_date = postedDate.split('T')[0];
    }

    const locationIsRemoteString =
        typeof location === 'string' && location.toLowerCase().includes('remote');
    const isRemote = locationData.remote ?? job.is_remote ?? job.isRemote ?? locationIsRemoteString ?? false;
    if (isRemote === true) formatted.is_remote = true;

    const recruiterData = job.recruiter ?? null;
    if (recruiterData) {
        const emails = sanitizeContactList(recruiterData.emails, { lowercase: true });
        const phones = sanitizeContactList(recruiterData.phones);
        if (emails.length || phones.length) {
            formatted.recruiter = {
                name: recruiterData.name ?? null,
                profile_url: recruiterData.profileUrl ?? null,
                emails,
                phones,
            };
        }
    }

    return formatted;
}
