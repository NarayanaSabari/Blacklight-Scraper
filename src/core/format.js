// Translates a normalized job into the Blacklight API request body.
// Moved out of common/utils.js so server.js has zero scraping concerns.

import { hashString } from './html.js';

const VALID_STRING = (value) =>
    value && value !== 'N/A' && typeof value === 'string';

function pickPlatformJobId(jobData, job, platform) {
    const candidates = [
        jobData.jobId, jobData.postId, jobData.id,
        job.jobId, job.postId, job.id,
    ];
    for (const candidate of candidates) {
        if (VALID_STRING(candidate)) return candidate;
    }

    const url = jobData.url || jobData.applyUrl || job.url || job.applyUrl || '';
    if (VALID_STRING(url)) return hashString(url);

    return `${platform}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
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

export function formatJobForBlacklight(job, platform) {
    // Accept both nested (normalized) and flat scraper output.
    const jobData = job.job ?? job;
    const companyData = job.company ?? {};
    const locationData = job.location ?? {};
    const compensationData = job.compensation ?? {};
    const employmentData = job.employment ?? {};
    const experienceData = job.experience ?? {};

    const platformJobId = pickPlatformJobId(jobData, job, platform);
    const title = jobData.title ?? job.title ?? 'N/A';
    const description = jobData.description ?? job.description ?? '';
    const url = jobData.url ?? jobData.applyUrl ?? job.url ?? job.applyUrl ?? '';
    const company = extractString(companyData.name ?? job.company);
    const location = extractString(locationData.formatted ?? job.location);

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

    return formatted;
}
