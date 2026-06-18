// Quick: does the findPopularLocationAjax endpoint resolve free-text → locId/locT?
import { launch } from 'cloakbrowser';
const log = (...a) => console.log('[loc-probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launch({ headless: true });
const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
// warm a session first so the ajax endpoint has cookies
await page.goto('https://www.glassdoor.com/index.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(3000);
for (const term of ['United States', 'New York', 'California', 'Texas', 'Remote']) {
    try {
        const res = await page.evaluate(async (t) => {
            const r = await fetch(`/findPopularLocationAjax.htm?maxLocationsToReturn=3&term=${encodeURIComponent(t)}`, { headers: { accept: 'application/json' } });
            return { status: r.status, body: (await r.text()).slice(0, 300) };
        }, term);
        log(term, '→', res.status, res.body);
    } catch (e) { log(term, '→ ERR', e.message); }
    await sleep(1200);
}
await browser.close().catch(() => {});
process.exit(0);
