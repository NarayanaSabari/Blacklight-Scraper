#!/usr/bin/env node
/**
 * Clean unwanted platform credentials out of config/credentials.json.
 *
 * Once a platform moves to the REMOTE credential pool (managed in centralD),
 * its local credentials in credentials.json are dead weight. This removes the
 * platform sections you no longer want locally while ALWAYS preserving the API
 * config (`blacklight`, `scraperCredentials`). A timestamped backup is written
 * before anything changes.
 *
 * Usage:
 *   node scripts/clean-credentials.js                          # interactive — pick what to remove
 *   node scripts/clean-credentials.js -- --remove linkedin,indeed
 *   node scripts/clean-credentials.js -- --keep glassdoor      # remove every platform EXCEPT these
 *   node scripts/clean-credentials.js -- --all                 # remove ALL platform sections
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// API config sections — never removed (the scraper needs them).
const PROTECTED = ['blacklight', 'scraperCredentials'];
const FILE = path.join(process.cwd(), 'config', 'credentials.json');

function parseArgs(argv) {
    const out = { remove: null, keep: null, all: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--all') out.all = true;
        else if (a === '--remove') out.remove = splitList(argv[++i]);
        else if (a === '--keep') out.keep = splitList(argv[++i]);
    }
    return out;
}

function splitList(s) {
    return (s || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
    if (!fs.existsSync(FILE)) {
        console.error(`No credentials file at ${FILE}`);
        process.exit(1);
    }
    let data;
    try {
        data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (err) {
        console.error(`Could not parse ${FILE}: ${err.message}`);
        process.exit(1);
    }

    const platforms = Object.keys(data).filter((k) => !PROTECTED.includes(k));
    console.log(`Protected (always kept): ${PROTECTED.filter((k) => k in data).join(', ') || '(none)'}`);
    if (platforms.length === 0) {
        console.log('No platform credential sections to clean.');
        return;
    }
    console.log(`Platform creds present:  ${platforms.join(', ')}`);

    const args = parseArgs(process.argv.slice(2));
    const nonInteractive = args.all || args.remove || args.keep;
    let toRemove;
    if (args.all) toRemove = [...platforms];
    else if (args.remove) toRemove = args.remove;
    else if (args.keep) toRemove = platforms.filter((p) => !args.keep.includes(p));
    else {
        const ans = await ask('\nWhich platform creds to REMOVE? (comma-separated, "all", or blank to cancel): ');
        if (!ans) return console.log('Cancelled — nothing changed.');
        toRemove = ans.toLowerCase() === 'all' ? [...platforms] : splitList(ans);
    }

    // Drop anything not actually a present platform section (incl. protected keys).
    const unknown = toRemove.filter((p) => !platforms.includes(p));
    if (unknown.length) console.warn(`Skipping (not a removable platform section): ${unknown.join(', ')}`);
    toRemove = [...new Set(toRemove.filter((p) => platforms.includes(p)))];
    if (toRemove.length === 0) return console.log('Nothing to remove.');

    console.log(`\nRemove: ${toRemove.join(', ')}`);
    console.log(`Keep:   ${Object.keys(data).filter((k) => !toRemove.includes(k)).join(', ')}`);
    if (!nonInteractive) {
        const confirm = await ask('Proceed? [y/N]: ');
        if (confirm.toLowerCase() !== 'y') return console.log('Cancelled — nothing changed.');
    }

    // Timestamped backup before writing.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(FILE), `credentials.backup-${stamp}.json`);
    fs.copyFileSync(FILE, backup);

    for (const p of toRemove) delete data[p];
    fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);

    console.log(`\n✅ Removed ${toRemove.length} section(s). Backup: ${backup}`);
    console.log(`Remaining keys: ${Object.keys(data).join(', ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
