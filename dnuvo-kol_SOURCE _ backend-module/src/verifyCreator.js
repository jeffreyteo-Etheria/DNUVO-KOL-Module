// Creator profile link verification — the honest layer.
// A browser cannot do this (CORS). This server-side check confirms:
//   live: profile URL returns 200
//   redirected: URL 30x'd (handle changed or moved)
//   dead: 404/410 — profile deleted or handle wrong
//   blocked: platform bot-walled the request (needs manual check or official API)
const https = require('https');

function head(url, redirects = 0) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dnuvo-verifier/1.0)' },
      timeout: 10000,
    }, (res) => {
      res.destroy();
      if ([301, 302, 307, 308].includes(res.statusCode) && redirects < 3 && res.headers.location) {
        return resolve(head(new URL(res.headers.location, url).href, redirects + 1)
          .then(r => ({ ...r, redirected: true })));
      }
      resolve({ status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    req.end();
  });
}

async function verifyCreator(url) {
  const r = await head(url);
  let verdict;
  if (r.status === 200) verdict = r.redirected ? 'redirected — confirm new handle' : 'live';
  else if ([404, 410].includes(r.status)) verdict = 'dead — profile not found';
  else if ([403, 429].includes(r.status)) verdict = 'blocked — bot wall; check manually or via official API';
  else if (r.status === 0) verdict = `unreachable (${r.error})`;
  else verdict = `unknown (HTTP ${r.status})`;
  return { url, httpStatus: r.status, verdict };
}

module.exports = { verifyCreator };

// CLI: npm run verify -- https://www.tiktok.com/@handle
if (require.main === module) {
  const url = process.argv[2];
  if (!url) return console.log('Usage: npm run verify -- <profile-url>');
  verifyCreator(url).then(r => console.log(JSON.stringify(r, null, 2)));
}
