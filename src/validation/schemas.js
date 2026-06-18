// Request validation schemas.
//
// Uses Zod (per project rules) for runtime validation with typed inference.
// Validation happens at the HTTP boundary — everything downstream trusts
// the parsed values.

import { z } from 'zod';
import { PLATFORM_NAMES } from '../scrapers/registry.js';

const platformValue = z.enum([...PLATFORM_NAMES, 'all']);

// Accept "dice", "dice,monster", or ["dice", "monster"], or "all".
const platformField = z
    .union([
        z.string().min(1).max(200),
        z.array(z.string().min(1)).min(1).max(10),
    ])
    .transform((value) => {
        if (Array.isArray(value)) return value.map((v) => v.trim().toLowerCase());
        const lowered = value.trim().toLowerCase();
        if (lowered === 'all') return ['all'];
        return lowered.split(',').map((s) => s.trim()).filter(Boolean);
    })
    .pipe(z.array(platformValue).min(1));

export const scrapeRequestSchema = z.object({
    platform: platformField,
    jobTitle: z.string().min(1).max(200),
    location: z.string().min(1).max(200),
});

export function parseScrapeRequest(body) {
    return scrapeRequestSchema.parse(body);
}
