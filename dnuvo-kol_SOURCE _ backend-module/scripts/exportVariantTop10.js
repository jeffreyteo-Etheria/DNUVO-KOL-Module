const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || path.join(process.env.TEMP || '.', 'kol_source_resp_strict.json');
const outDir = process.argv[3] || path.join('data', 'exports');

function esc(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const cols = ['rank', 'platform', 'displayName', 'handle', 'followers', 'engagementRate', 'score', 'tier', 'profileUrl'];
  const lines = [cols.join(',')];

  rows.forEach((r, idx) => {
    const row = {
      rank: idx + 1,
      platform: r.platform,
      displayName: r.displayName,
      handle: r.handle,
      followers: r.followers,
      engagementRate: r.engagementRate,
      score: r.score,
      tier: r.tier,
      profileUrl: r.profileUrl,
    };
    lines.push(cols.map((c) => esc(row[c])).join(','));
  });

  return lines.join('\n');
}

function rank(a, b) {
  return (Number(b.score) || 0) - (Number(a.score) || 0)
    || (Number(b.engagementRate) || 0) - (Number(a.engagementRate) || 0)
    || (Number(b.followers) || 0) - (Number(a.followers) || 0);
}

function printRows(title, rows) {
  console.log(title, rows.length);
  rows.forEach((x, i) => {
    console.log([
      i + 1,
      x.platform || '',
      x.displayName || x.handle || x.username || '',
      x.tier || '',
      x.followers || '',
      x.engagementRate ?? '',
      x.score ?? '',
      x.profileUrl || '',
    ].join('\t'));
  });
}

function main() {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.error) {
    console.log('ERROR', parsed.error);
    process.exit(1);
  }

  const shortlist = Array.isArray(parsed.shortlist) ? parsed.shortlist : [];
  const igTop10 = shortlist
    .filter((x) => String(x.platform || '').toLowerCase() === 'instagram')
    .sort(rank)
    .slice(0, 10);

  const microMidTop10 = shortlist
    .filter((x) => ['micro', 'mid'].includes(String(x.tier || '').toLowerCase()))
    .sort(rank)
    .slice(0, 10);

  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const igPath = path.join(outDir, `kol_top10_instagram_only_${ts}.csv`);
  const mmPath = path.join(outDir, `kol_top10_micro_mid_${ts}.csv`);

  fs.writeFileSync(igPath, toCsv(igTop10));
  fs.writeFileSync(mmPath, toCsv(microMidTop10));

  printRows('IG_TOP10', igTop10);
  printRows('MICRO_MID_TOP10', microMidTop10);
  console.log('FILES', igPath, mmPath);
}

main();
