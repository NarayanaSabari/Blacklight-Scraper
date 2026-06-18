// Normalises raw scraper output into the unified master schema.
// This is the ONE place that defines the output contract — every scraper
// funnels through here so downstream consumers see a stable shape.

function parseList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter((s) => s && String(s).trim());
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s && s !== 'N/A');
    }
    return [];
}

// Infer a coarse seniority level from the job title when the scraper didn't
// provide one (no platform currently does). Ordered most-specific first.
const LEVEL_PATTERNS = [
    [/\b(intern|internship|co-?op|apprentice)\b/i, 'Internship'],
    [/\b(principal|staff|distinguished|fellow)\b/i, 'Principal'],
    [/\b(lead|architect|head of|director|vp|chief|manager)\b/i, 'Lead'],
    [/\b(sr\.?|senior)\b/i, 'Senior'],
    [/\b(jr\.?|junior|entry[- ]?level|associate|graduate|new[- ]?grad|trainee)\b/i, 'Entry'],
    [/\b(mid[- ]?level|intermediate)\b/i, 'Mid'],
];
export function inferExperienceLevel(title) {
    if (!title || typeof title !== 'string') return null;
    for (const [re, level] of LEVEL_PATTERNS) if (re.test(title)) return level;
    return null;
}

// Best-effort parse of a salary STRING into structured {min,max,currency,period}
// — used only as a fallback when the scraper didn't already provide min/max.
// Conservative: applies a plausibility window per period so stray numbers
// (zips, years) don't become salaries.
export function parseSalaryText(text) {
    const out = { min: null, max: null, currency: null, period: null };
    if (!text || typeof text !== 'string' || text === 'N/A') return out;
    const t = text;
    out.currency = /£|\bGBP\b/i.test(t) ? 'GBP'
        : /€|\bEUR\b/i.test(t) ? 'EUR'
            : /₹|\bINR\b/i.test(t) ? 'INR'
                : (/\$|\bUSD\b/i.test(t) ? 'USD' : null);
    if (/hour|hourly|\bhr\b|\/\s*hr|an hour/i.test(t)) out.period = 'hour';
    else if (/month|monthly|\/\s*mo\b|a month/i.test(t)) out.period = 'month';
    else if (/week|weekly|\/\s*wk\b|a week/i.test(t)) out.period = 'week';
    else if (/year|yearly|annual|\byr\b|\/\s*yr|a year|per year|p\.?a\.?\b/i.test(t)) out.period = 'year';
    const nums = [];
    for (const m of t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g)) {
        let n = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isNaN(n)) continue;
        if (m[2]) n *= 1000;
        nums.push(n);
    }
    let lo = 1000; let hi = 100000000;             // year / unknown ⇒ annual-scale
    if (out.period === 'hour') { lo = 2; hi = 2000; }
    else if (out.period === 'week') { lo = 100; hi = 100000; }
    else if (out.period === 'month') { lo = 500; hi = 1000000; }
    const plausible = nums.filter((n) => n >= lo && n <= hi);
    if (plausible.length) {
        out.min = Math.min(...plausible);
        const mx = Math.max(...plausible);
        out.max = mx === out.min ? null : mx;
    }
    return out;
}

const COUNTRY_ONLY = /^(united states(?: of america)?|usa|u\.?s\.?a?\.?|united kingdom|u\.?k\.?|canada|australia|india|remote)$/i;
// Parse a formatted location string into {city,state,country} as a fallback
// when the scraper didn't provide structured parts. Handles "City, ST",
// "City, ST 80203", "City, State, Country", and bare country/Remote.
export function parseLocationText(formatted) {
    const out = { city: null, state: null, country: null };
    if (!formatted || typeof formatted !== 'string' || formatted === 'N/A') return out;
    const s = formatted.trim();
    if (COUNTRY_ONLY.test(s)) {
        if (/united kingdom|u\.?k\.?/i.test(s)) out.country = 'United Kingdom';
        else if (/canada/i.test(s)) out.country = 'Canada';
        else if (/australia/i.test(s)) out.country = 'Australia';
        else if (/india/i.test(s)) out.country = 'India';
        else if (/united states|usa|u\.?s\.?a?/i.test(s)) out.country = 'United States';
        return out;
    }
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
        out.city = parts[0] || null;
        // second part may be "CO" or "CO 80203" or a full state name
        const sp = parts[1].match(/^([A-Za-z .]+?)(?:\s+\d{5}(?:-\d{4})?)?$/);
        out.state = sp ? sp[1].trim() : (parts[1] || null);
        if (parts.length >= 3) out.country = parts[parts.length - 1] || null;
    } else if (parts.length === 1 && /\bremote\b/i.test(parts[0])) {
        // e.g. "Remote, US" handled above; bare "Remote" → nothing structured
    }
    return out;
}

function coreJob(job) {
    return {
        id: job.id ?? job.jobId ?? job.postId ?? null,
        title: job.title ?? job.jobTitle ?? 'N/A',
        description: job.description ?? 'N/A',
        url: job.url ?? job.jobUrl ?? job.jobLink ?? 'N/A',
        applyUrl: job.applyUrl ?? job.url ?? job.jobUrl ?? job.jobLink ?? 'N/A',
        postedDate: job.postedDate ?? job.datePosted ?? job.createdDate ?? 'N/A',
        validThrough: job.validThrough ?? null,
    };
}

function companyInfo(job) {
    const companyData = job.companyData ?? {};
    return {
        name: job.company ?? job.hiringOrganization ?? 'N/A',
        rating: job.rating ?? job.companyRating ?? null,
        about: companyData.about ?? null,
        website: companyData.website ?? null,
        profileUrl: job.companyProfileUrl ?? companyData.profileUrl ?? null,
        logoUrl: job.companyLogoUrl ?? companyData.logoUrl ?? null,
        headquarters: companyData.headquarters ?? null,
        employeesCount: companyData.employeesCount ?? null,
        foundedYear: companyData.foundedYear ?? null,
        techStacks: companyData.techStacks ?? [],
    };
}

function locationInfo(job) {
    const formatted = job.location ?? job.jobLocation ?? 'N/A';
    const rawLocation = typeof job.location === 'string' ? job.location : null;
    // Fill structured parts from the formatted string when the scraper didn't.
    const parsed = (job.city == null && job.state == null && job.country == null)
        ? parseLocationText(formatted)
        : {};
    return {
        formatted,
        city: job.city ?? parsed.city ?? null,
        state: job.state ?? parsed.state ?? null,
        country: job.country ?? parsed.country ?? null,
        remote: job.isRemote ?? job.remote ?? (rawLocation?.toLowerCase().includes('remote') ?? false),
        workplaceType: job.workplaceType ?? null,
        companyLocation: job.companyLocation ?? null,
    };
}

function compensationInfo(job) {
    const salary = job.salary ?? job.rate ?? job.salaryEstimate ?? job.compensationDetail ?? 'N/A';
    let min = job.salary_min ?? job.salaryMin ?? null;
    let max = job.salary_max ?? job.salaryMax ?? null;
    let currency = job.salary_currency ?? job.salaryCurrency ?? null;
    let period = job.salary_period ?? job.salaryPeriod ?? null;
    // Fallback: derive structured pay from the salary string when not provided.
    if (min == null && max == null && typeof salary === 'string') {
        const p = parseSalaryText(salary);
        min = p.min; max = p.max;
        currency = currency ?? p.currency;
        period = period ?? p.period;
    }
    return { salary, salaryMin: min, salaryMax: max, currency: currency ?? 'USD', period };
}

function employmentInfo(job) {
    return {
        type: job.employmentType ?? 'N/A',
        duration: job.duration ?? null,
        workAuthorization: parseList(job.workAuthorization),
        preferredEmployment: parseList(job.preferredEmployment),
        easyApply: job.easyApply ?? false,
    };
}

function experienceInfo(job) {
    return {
        level: job.experienceLevel ?? inferExperienceLevel(job.title ?? job.jobTitle) ?? null,
        yearsRequired: job.experienceRequired ?? null,
        requiredSkills: parseList(job.skills ?? job.requiredSkills),
        preferredSkills: parseList(job.preferredSkills),
        specialArea: job.specialArea ?? null,
        domain: job.domain ?? null,
    };
}

function pruneEmptyCollections(normalized) {
    if (!normalized.recruiter) delete normalized.recruiter;
    if (!normalized.social) delete normalized.social;
    if (normalized.company.techStacks.length === 0) delete normalized.company.techStacks;
    if (normalized.employment.workAuthorization.length === 0) delete normalized.employment.workAuthorization;
    if (normalized.employment.preferredEmployment.length === 0) delete normalized.employment.preferredEmployment;
    if (normalized.experience.requiredSkills.length === 0) delete normalized.experience.requiredSkills;
    if (normalized.experience.preferredSkills.length === 0) delete normalized.experience.preferredSkills;
    return normalized;
}

export function normalizeJobData(job, platform) {
    const normalized = {
        _metadata: {
            platform: platform.toLowerCase(),
            extractedAt: new Date().toISOString(),
            scraperId: `${platform}-${Date.now()}`,
        },
        job: coreJob(job),
        company: companyInfo(job),
        location: locationInfo(job),
        compensation: compensationInfo(job),
        employment: employmentInfo(job),
        experience: experienceInfo(job),
        recruiter: job.recruiter
            ? {
                name: job.recruiter.name ?? job.recruiter,
                title: job.recruiter.title ?? null,
                company: job.recruiter.company ?? null,
                profileUrl: job.recruiter.profileUrl ?? null,
                contact: job.recruiter.contact ?? null,
            }
            : null,
        social: (job.postId ?? job.activityUrn)
            ? {
                postId: job.postId ?? null,
                activityUrn: job.activityUrn ?? null,
                author: job.author ?? job.authorName ?? null,
                authorProfile: job.authorProfile ?? job.authorUrl ?? null,
                timestamp: job.timestamp ?? job.postTime ?? null,
                engagement: job.engagement ?? null,
                isJobRelated: job.isJobRelated ?? null,
            }
            : null,
    };

    return pruneEmptyCollections(normalized);
}
