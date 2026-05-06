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
    const rawLocation = typeof job.location === 'string' ? job.location : null;
    return {
        formatted: job.location ?? job.jobLocation ?? 'N/A',
        city: job.city ?? null,
        state: job.state ?? null,
        country: job.country ?? null,
        remote: job.isRemote ?? job.remote ?? (rawLocation?.toLowerCase().includes('remote') ?? false),
        workplaceType: job.workplaceType ?? null,
        companyLocation: job.companyLocation ?? null,
    };
}

function compensationInfo(job) {
    return {
        salary: job.salary ?? job.rate ?? job.salaryEstimate ?? job.compensationDetail ?? 'N/A',
        salaryMin: job.salary_min ?? job.salaryMin ?? null,
        salaryMax: job.salary_max ?? job.salaryMax ?? null,
        currency: job.salary_currency ?? job.salaryCurrency ?? 'USD',
        period: job.salary_period ?? job.salaryPeriod ?? null,
    };
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
        level: job.experienceLevel ?? null,
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
