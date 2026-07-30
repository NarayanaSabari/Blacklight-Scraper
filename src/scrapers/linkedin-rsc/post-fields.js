// Deriving job fields from a LinkedIn post body.
//
// A LinkedIn post has no title, company or location field — only free text. The
// original mapping used the post's FIRST LINE as the title, which produced values
// like "Hiring Alert.!!", "Hello Recruiters," and 200-char prose fragments.
//
// That was not merely untidy. Those strings reached
// AIRoleNormalizationService.normalize_job_title, which appends the raw title to
// GlobalRole.aliases, and prod ended up with 241 posting fragments as role
// aliases across 98 of 346 roles — including provably wrong attributions
// ("We are Hiring for GCP Cloud Engineer..." filed under AWS Cloud Engineer,
// "Site Reliability Engineer II" under an SEO role). Embedding a prose blob is
// dominated by generic hiring language, so it lands on an adjacent-but-wrong
// role, and each bad alias then becomes a permanent matching rule.
//
// So the rule here is: emit a REAL job title or emit nothing recognizable as one.
// Recruiter posts overwhelmingly label the fields explicitly ("Title:", "Role:",
// "Location:", "Client:"), so read the labels and validate hard. Anything that
// fails validation becomes NEUTRAL_TITLE, which is deliberately a constant: a
// constant is honest about not knowing, and cannot poison role data because it
// carries no role-specific tokens.

// Kept well under the backend alias guard so a real extracted title stays usable
// while prose can never squeeze through.
export const MAX_TITLE_CHARS = 100;
export const NEUTRAL_TITLE = 'LinkedIn Job Post';

// Ordered by trustworthiness: an explicit "Job Title:" beats a bare "Hiring:".
const TITLE_LABELS = [
    'job title', 'position title', 'title', 'role', 'position', 'requirement',
    'opening', 'req', 'designation', 'job role', 'hiring for', 'hiring',
    'resource required', 'urgently hiring', 'immediate hiring',
];
const LOCATION_LABELS = ['work location', 'job location', 'locations', 'location', 'loc'];
const COMPANY_LABELS = ['client', 'company', 'employer', 'end client'];

// Post openers that carry no role information. Even when short enough to pass a
// length check these are the most damaging possible aliases, because every
// recruiter writes them — one generic alias funnels unrelated jobs into whatever
// role it first matched.
const OPENER = [
    'hiring alert', 'hiring', 'we are hiring', "we're hiring", 'were hiring',
    'urgent requirement', 'urgent(?:ly)?', 'immediate requirement', 'immediate(?:ly)?',
    'hello', 'hi', 'hey', 'greetings', 'good morning', 'good afternoon',
    'good evening', 'happy \\w+', 'dear', 'attention', 'job alert', 'new',
    'open position', 'opportunity', 'opportunities', 'looking for', 'available',
    'bench', 'hot list', 'hotlist', 'please share', 'share profiles', 'need',
].join('|');
// Words that follow an opener when it is being used as a salutation or banner
// rather than as the head of a real title. This is what separates the useless
// "Hello Recruiters," / "Hiring Alert!!" from the legitimate "Hiring Manager".
const VOCATIVE = [
    'alert', 'alerts', 'recruiters', 'recruiter', 'everyone', 'all', 'folks', 'guys',
    'friends', 'connections', 'network', 'team', 'there', 'people', 'community',
    // banner nouns: "Immediate Hiring!!", "Available Bench Consultants", "Urgent Requirement"
    'hiring', 'requirement', 'requirements', 'opening', 'openings', 'position', 'positions',
    'role', 'roles', 'job', 'jobs', 'consultant', 'consultants', 'bench', 'list', 'update', 'updates',
].join('|');
// Rejected when the opener is the WHOLE string, is followed only by punctuation,
// or is followed by a vocative/banner word. `\b` after the opener keeps it from
// matching a longer real word ("need" must not swallow "Needs Assessment Analyst").
const GENERIC_OPENER = new RegExp(
    `^(?:${OPENER})\\b(?:[\\s\\p{P}]*$|[\\s\\p{P}]+(?:${VOCATIVE})\\b)`,
    'iu',
);

// Labels that commonly follow a value on the same line. Used to stop an
// extracted value from swallowing the next field. Matching known keywords is
// deliberate: a generic "any words then a colon" lookahead splits far too early
// ("Title: Data Engineer Location: X" would cut after "Data").
const NEXT_LABEL = [
    'work location', 'job location', 'locations', 'location', 'loc',
    'job title', 'title', 'role', 'position', 'designation',
    'client', 'company', 'employer', 'end client',
    'type', 'job type', 'work mode', 'mode', 'employment type', 'contract',
    'duration', 'rate', 'pay', 'salary', 'budget',
    'visa', 'work authorization', 'authorization', 'experience', 'exp',
    'skills', 'mandatory skills', 'required skills', 'interview', 'note', 'notes',
    'start date', 'openings', 'positions', 'shift',
].join('|');

// Contact / URL / hashtag debris that means we grabbed body text, not a title.
// Also LinkedIn's own UI furniture ("• 3rd+", follower counts), which appears in
// post text and produced titles that were just a person's name plus a badge.
const DEBRIS = new RegExp([
    'https?://', 'www\\.', '@[\\w.-]+\\.\\w', '\\bhashtag#', '#\\w+',
    '\\+?\\d[\\d\\s().-]{8,}',
    '•\\s*\\d(?:st|nd|rd|th)', '\\bfollowers?\\b', '\\bconnections?\\b',
].join('|'), 'i');

// A job title names a job. Requiring one of these is a whitelist, which is the
// right shape here: the blacklist of promotional phrasings is unbounded (every
// recruiter invents new banners) while the vocabulary of IT-staffing role nouns
// is finite. Anything without one becomes NEUTRAL_TITLE — the safe direction,
// since a missed real title costs nothing but a poisoned alias is permanent.
const ROLE_TOKEN = new RegExp('\\b(' + [
    'engineer', 'engineering', 'developer', 'dev', 'programmer', 'analyst', 'architect',
    'administrator', 'admin', 'manager', 'consultant', 'specialist', 'lead', 'leader',
    'designer', 'scientist', 'tester', 'qa', 'sdet', 'sre', 'devops', 'technician',
    'coordinator', 'director', 'officer', 'recruiter', 'accountant', 'auditor',
    'nurse', 'physician', 'therapist', 'teacher', 'instructor', 'professor',
    'attorney', 'paralegal', 'clerk', 'assistant', 'associate', 'intern',
    'operator', 'supervisor', 'foreman', 'electrician', 'plumber', 'welder',
    'driver', 'mechanic', 'machinist', 'inspector', 'estimator', 'surveyor',
    'planner', 'scheduler', 'buyer', 'expeditor', 'writer', 'editor',
    'strategist', 'marketer', 'salesperson', 'representative', 'rep',
    'agent', 'advisor', 'advisor', 'counselor', 'trainer', 'facilitator',
    'scrum ?master', 'product owner', 'owner', 'principal', 'staff', 'fellow',
    'head', 'chief', 'vp', 'president', 'cto', 'cio', 'ceo', 'cfo',
    'modeler', 'modeller', 'researcher', 'statistician', 'actuary',
    'technologist', 'practitioner', 'generalist', 'partner', 'liaison',
].join('|') + ')\\b', 'i');

function tidy(raw) {
    return String(raw ?? '')
        // Normalize smart quotes so "we’re" is recognized alongside "we're".
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”]/g, '"')
        // leading emoji / bullets / decoration
        .replace(/^[\s\p{P}\p{S}]+/u, '')
        // Trailing noise, but NEVER a closing bracket — ")" is part of a real
        // title like "Pega Lead System Architect (CLSA)".
        .replace(/[\s,;:|\-–—*·•!?.\p{S}]+$/u, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// An unbalanced "(" means a split landed mid-parenthetical
// ("Data Engineer (PySpark"). Drop the dangling fragment rather than storing it.
function balanceParens(s) {
    const opens = (s.match(/\(/g) ?? []).length;
    const closes = (s.match(/\)/g) ?? []).length;
    if (opens > closes) return s.slice(0, s.lastIndexOf('(')).trim().replace(/[\s,;:|\-–—]+$/u, '');
    return s;
}

/**
 * Is this plausibly a job title rather than a fragment of a post?
 *
 * Intentionally strict — a false negative costs a neutral title, a false
 * positive costs a permanently poisoned role alias.
 */
export function looksLikeJobTitle(value) {
    const s = balanceParens(tidy(value));
    if (s.length < 3 || s.length > MAX_TITLE_CHARS) return false;
    // Must actually name a job — see ROLE_TOKEN.
    if (!ROLE_TOKEN.test(s)) return false;
    if (!/\p{L}/u.test(s)) return false;              // must contain a letter
    if (DEBRIS.test(s)) return false;
    if (GENERIC_OPENER.test(s)) return false;
    // Prose markers: sentence breaks, or a second labelled field bleeding in.
    if (/[.!?]\s+\p{Lu}/u.test(s)) return false;
    if (/:/.test(s)) return false;
    if (s.split(/\s+/).length > 12) return false;     // titles are short
    // A trailing verb-y clause ("... to join our team") is prose, not a title.
    if (/\b(we are|we're|join our|apply now|please|kindly|reach out|dm me|share your)\b/i.test(s)) return false;
    return true;
}

/**
 * Read "Label: value" from a post body, trying labels in order.
 * Value runs to end of line, or to the next "Word:" label on the same line.
 */
export function extractLabeled(text, labels) {
    const body = String(text ?? '');
    if (!body) return null;
    for (const label of labels) {
        // Label may be followed by ':' or '-' and arbitrary spacing.
        const re = new RegExp(
            `(?:^|[\\n\\r|•*·]|\\s{2,})\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\-–]\\s*([^\\n\\r]+)`,
            'i',
        );
        const m = body.match(re);
        if (!m) continue;
        // Stop at a following known label on the same line ("Title: X Location: Y").
        const cut = new RegExp(`\\s+(?=(?:${NEXT_LABEL})\\s*[:\\-–])`, 'i');
        let value = m[1].split(cut)[0];
        value = tidy(value);
        if (value) return value;
    }
    return null;
}

/**
 * Job title for a post. Returns NEUTRAL_TITLE when no trustworthy title exists,
 * never a raw slice of the body.
 */
export function titleFromPost(text) {
    const labeled = extractLabeled(text, TITLE_LABELS);
    if (labeled && looksLikeJobTitle(labeled)) return balanceParens(tidy(labeled));
    // Fall back to a first line ONLY if it independently passes as a title —
    // many posts lead with the bare role ("Senior Data Engineer - Remote").
    const firstLine = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    // Trim a trailing "- Remote"/"(C2C)" style qualifier before judging.
    const head = balanceParens(tidy(firstLine.split(/\s+[|–—]\s+/)[0]));
    if (looksLikeJobTitle(head)) return head;
    return NEUTRAL_TITLE;
}

/**
 * Location from the post body, falling back to the search location. Without
 * this the search term was echoed onto every row, so a "Delhi Hybrid" post
 * harvested by a "United States" search was stored as United States.
 */
export function locationFromPost(text, searchLocation) {
    const labeled = extractLabeled(text, LOCATION_LABELS);
    if (labeled) {
        const v = balanceParens(tidy(labeled));
        // Guard against grabbing a sentence; locations are short.
        if (v.length >= 2 && v.length <= 120 && !DEBRIS.test(v) && v.split(/\s+/).length <= 14) {
            return v;
        }
    }
    return searchLocation || '';
}

/**
 * Hiring company when the post names a client, else null so the caller can
 * decide. The post author is a recruiter, not necessarily the employer.
 */
export function companyFromPost(text) {
    const labeled = extractLabeled(text, COMPANY_LABELS);
    if (!labeled) return null;
    const v = tidy(labeled);
    if (v.length < 2 || v.length > 80) return null;
    if (DEBRIS.test(v)) return null;
    if (v.split(/\s+/).length > 8) return null;
    return v;
}
