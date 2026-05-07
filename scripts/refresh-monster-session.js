#!/usr/bin/env node
// Refresh the manual Monster DataDome session — local + VM.
//
// Why this exists
// ---------------
// Monster's API sits behind DataDome. Each API request must carry a
// (clientid, datadome-cookie) pair from a session that solved the in-page
// captcha. The cleared session is bound to the IP that solved it — so
// solving from your laptop's IP yields cookies that work locally but not
// on the VM, and vice versa.
//
// This script runs an SSH SOCKS proxy to the VM, so when you point your
// real browser at it, your outgoing traffic exits the VM's static IP.
// Anything you solve through that proxy is credited against the VM's
// IP — exactly what we need.
//
// Workflow
// --------
//   1. Run this script on your laptop.
//   2. It opens an SSH SOCKS proxy on localhost:$SOCKS_PORT.
//   3. Launch a fresh Chrome window pointed at that proxy:
//        open -na "Google Chrome" --args \
//            --user-data-dir=/tmp/monster-refresh \
//            --proxy-server="socks5://localhost:1080"
//      (the script prints this for you).
//   4. In that Chrome, visit https://www.monster.com/jobs/search?q=DevOps+Engineer
//      and solve any captcha.
//   5. Open DevTools → Network → click an appsapi.monster.io POST →
//      right-click headers → Copy all as cURL (or just copy the
//      "Request Headers" pane).
//   6. Paste it here, end with a single line `EOF` then Enter.
//   7. Script parses the headers, writes the new `monster` block into the
//      local config/credentials.json AND scps to the VM. Both scrapers
//      hot-reload via fs.watch.
//
// Env overrides:
//   VM_HOST     default root@5.161.248.170
//   VM_KEY      default ~/.ssh/hetzner_quantipeak
//   VM_PATH     default /home/scraper/scraper/config/credentials.json
//   SOCKS_PORT  default 1080

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

const VM_HOST = process.env.VM_HOST || 'root@5.161.248.170';
const VM_KEY = process.env.VM_KEY || `${os.homedir()}/.ssh/hetzner_quantipeak`;
const VM_PATH = process.env.VM_PATH || '/home/scraper/scraper/config/credentials.json';
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || '1080', 10);
const LOCAL_CREDENTIALS = path.join(process.cwd(), 'config', 'credentials.json');

function die(msg) {
    console.error(`✗ ${msg}`);
    process.exit(1);
}

function startSocksProxy() {
    if (!fs.existsSync(VM_KEY)) die(`SSH key not found: ${VM_KEY}`);

    console.log(`→ Opening SSH SOCKS proxy: localhost:${SOCKS_PORT} → ${VM_HOST}`);
    const child = spawn(
        'ssh',
        ['-i', VM_KEY, '-D', String(SOCKS_PORT), '-N', '-o', 'ServerAliveInterval=30', VM_HOST],
        { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('error', (err) => die(`failed to spawn ssh: ${err.message}`));

    // Give ssh ~2s to establish.
    return new Promise((resolve) => {
        setTimeout(() => {
            // Quick liveness check.
            const test = spawnSync('nc', ['-z', '-w', '2', 'localhost', String(SOCKS_PORT)]);
            if (test.status !== 0) {
                child.kill();
                die(`SOCKS proxy on :${SOCKS_PORT} not reachable — check ssh access to ${VM_HOST}`);
            }
            console.log(`✓ SOCKS proxy live`);
            resolve(child);
        }, 2000);
    });
}

function chromeLaunchHint() {
    const isMac = process.platform === 'darwin';
    if (isMac) {
        return [
            'open -na "Google Chrome" --args \\',
            '    --user-data-dir=/tmp/monster-refresh \\',
            `    --proxy-server="socks5://localhost:${SOCKS_PORT}"`,
        ].join('\n');
    }
    return `google-chrome --user-data-dir=/tmp/monster-refresh --proxy-server="socks5://localhost:${SOCKS_PORT}"`;
}

async function readPaste() {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const lines = [];
    for await (const line of rl) {
        if (line.trim() === 'EOF') break;
        lines.push(line);
    }
    return lines.join('\n');
}

// Two paste formats supported:
//   (a) DevTools "Headers" pane raw paste — alternating lines of
//       `header-name` then `value` (sometimes with `:authority`, etc.
//       prefixed by colon — we ignore those).
//   (b) curl --copy-as-curl output — extract -H 'name: value' lines.
function parseHeaders(blob) {
    const headers = {};
    const lines = blob.split('\n').map((l) => l.replace(/\r$/, ''));

    // Format (b): -H 'name: value'
    for (const line of lines) {
        const m = line.match(/^\s*-H\s+['"]([^:'"]+):\s*(.+?)['"]\s*\\?\s*$/);
        if (m) headers[m[1].toLowerCase()] = m[2];
    }
    // Format (b) cont'd: -b 'cookie-string' (curl cookie flag)
    for (const line of lines) {
        const m = line.match(/^\s*-b\s+['"](.+?)['"]\s*\\?\s*$/);
        if (m) headers['cookie'] = m[1];
    }
    if (Object.keys(headers).length > 0) return headers;

    // Format (a): alternating name / value, two lines per header.
    for (let i = 0; i + 1 < lines.length; i++) {
        const name = lines[i].trim();
        if (!name || name.includes(' ') || name.includes(':')) continue; // skip values, pseudo-headers like :authority
        const value = lines[i + 1];
        if (value === undefined) continue;
        headers[name.toLowerCase()] = value.trim();
        i++; // consume value line
    }
    return headers;
}

function parseCookieHeader(cookieStr) {
    const cookies = {};
    for (const part of cookieStr.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name) cookies[name] = value;
    }
    return cookies;
}

function buildMonsterBlock(h) {
    const need = ['cookie', 'x-datadome-clientid', 'user-agent'];
    const missing = need.filter((k) => !h[k]);
    if (missing.length) die(`paste is missing required headers: ${missing.join(', ')}`);

    return {
        _comment:
            'Manually-cleared DataDome session. Refresh via scripts/refresh-monster-session.js when API starts returning 403.',
        _refreshedAt: new Date().toISOString(),
        datadomeClientId: h['x-datadome-clientid'],
        userAgent: h['user-agent'],
        secChUa: h['sec-ch-ua'] || '"Chromium";v="146", "Not-A.Brand";v="24"',
        secChUaMobile: h['sec-ch-ua-mobile'] || '?0',
        secChUaPlatform: h['sec-ch-ua-platform'] || '"macOS"',
        acceptLanguage: h['accept-language'] || 'en-US,en;q=0.9',
        cookies: parseCookieHeader(h['cookie']),
    };
}

function writeLocal(monster) {
    let creds = {};
    if (fs.existsSync(LOCAL_CREDENTIALS)) {
        creds = JSON.parse(fs.readFileSync(LOCAL_CREDENTIALS, 'utf-8'));
    }
    creds.monster = monster;
    fs.writeFileSync(LOCAL_CREDENTIALS, JSON.stringify(creds, null, 2));
    console.log(`✓ wrote ${LOCAL_CREDENTIALS}`);
}

function pushToVm(monster) {
    // scp the monster block to a temp file on the VM, then merge it into
    // the existing credentials.json server-side via Python. Avoids stdin
    // multiplexing issues with `ssh bash -s`, and keeps the merge atomic
    // from the scraper process's perspective (single fs.writeFile call).
    const tmpLocal = `/tmp/monster-session-${Date.now()}.json`;
    fs.writeFileSync(tmpLocal, JSON.stringify(monster, null, 2));
    const remoteTmp = `/tmp/monster-session-push-${Date.now()}.json`;

    const scp = spawnSync('scp', ['-i', VM_KEY, tmpLocal, `${VM_HOST}:${remoteTmp}`], {
        stdio: 'inherit',
    });
    if (scp.status !== 0) die('scp failed');

    const merge = spawnSync(
        'ssh',
        [
            '-i', VM_KEY, VM_HOST,
            `python3 -c "
import json
with open('${VM_PATH}','r') as f: c = json.load(f)
with open('${remoteTmp}','r') as f: c['monster'] = json.load(f)
with open('${VM_PATH}','w') as f: json.dump(c, f, indent=2)
print('merged')
" && chown scraper:scraper '${VM_PATH}' && rm -f '${remoteTmp}'`,
        ],
        { stdio: 'inherit' },
    );
    if (merge.status !== 0) die('remote merge failed');
    fs.unlinkSync(tmpLocal);
    console.log(`✓ pushed Monster session to ${VM_HOST}:${VM_PATH}`);
}

async function main() {
    if (process.argv.includes('--paste-only')) {
        // Skip SSH proxy; just read paste, write local, push to VM.
        // Useful when you already have a tunnel / browser flow set up.
    } else {
        await startSocksProxy();
    }

    console.log('');
    console.log('▶ Open a fresh Chrome window through the SOCKS proxy:');
    console.log('');
    console.log(chromeLaunchHint());
    console.log('');
    console.log('▶ In that window:');
    console.log('  1. Visit https://www.monster.com/jobs/search?q=DevOps+Engineer&where=United+States');
    console.log('  2. Solve any captcha; wait until job results render.');
    console.log('  3. DevTools → Network → click an appsapi.monster.io POST');
    console.log('  4. Right-click → Copy → Copy all as cURL (or copy the "Request Headers" pane)');
    console.log('  5. Paste below. Type EOF on its own line when done.');
    console.log('');

    const blob = await readPaste();
    const headers = parseHeaders(blob);
    if (!headers['cookie'] || !headers['x-datadome-clientid']) {
        console.error('!! parsed headers — keys we got:', Object.keys(headers).slice(0, 12));
        die('could not extract cookie + x-datadome-clientid from paste');
    }

    const monster = buildMonsterBlock(headers);
    console.log(
        `→ Parsed ${Object.keys(monster.cookies).length} cookies, clientid ${monster.datadomeClientId.slice(0, 16)}…`,
    );

    writeLocal(monster);

    const skipVm = process.argv.includes('--local-only');
    if (skipVm) {
        console.log('Skipping VM push (--local-only). Run without that flag to deploy.');
    } else {
        pushToVm(monster);
    }

    console.log('');
    console.log('✓ Done. Both scrapers will pick up the new session within ~2 seconds.');
    process.exit(0);
}

main().catch((err) => die(err.message));
