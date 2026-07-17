const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || path.join(process.env.TEMP || '.', 'kol_source_resp_strict.json');
const outDir = process.argv[3] || path.join('data', 'exports');

function toCsv(rows) {
  const cols = [
    'rank',
    'platform',
    'displayName',
    'handle',
    'followers',
    'engagementRate',
    'score',
    'tier',
    'profileUrl',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

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

function main() {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (parsed.error) {
    console.log('ERROR', parsed.error);
    process.exit(1);
  }

  const shortlist = Array.isArray(parsed.shortlist) ? parsed.shortlist : [];
  const backups = Array.isArray(parsed.backups) ? parsed.backups : [];

  const byPlatform = { Instagram: [], TikTok: [] };
  for (const r of shortlist) {
    if (byPlatform[r.platform]) byPlatform[r.platform].push(r);
  }

  Object.values(byPlatform).forEach((arr) => {
    arr.sort(
      (a, b) =>
        (Number(b.score) || 0) - (Number(a.score) || 0) ||
        (Number(b.engagementRate) || 0) - (Number(a.engagementRate) || 0)
    );
  });

  const top10 = [];
  let i = 0;
  while (top10.length < 10 && (byPlatform.Instagram.length || byPlatform.TikTok.length)) {
    const preferred = i % 2 === 0 ? 'Instagram' : 'TikTok';
    const alternate = preferred === 'Instagram' ? 'TikTok' : 'Instagram';
    if (byPlatform[preferred].length) {
      top10.push(byPlatform[preferred].shift());
    } else if (byPlatform[alternate].length) {
      top10.push(byPlatform[alternate].shift());
    }
    i += 1;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  const top10Path = path.join(outDir, `kol_top10_outreach_${ts}.csv`);
  const shortlistPath = path.join(outDir, `kol_shortlist_${ts}.csv`);
  const backupsPath = path.join(outDir, `kol_backups_${ts}.csv`);

  fs.writeFileSync(top10Path, toCsv(top10));
  fs.writeFileSync(shortlistPath, toCsv(shortlist));
  fs.writeFileSync(backupsPath, toCsv(backups));

  console.log('TOP10_COUNT', top10.length);
  top10.forEach((x, idx) => {
    console.log(
      [
        idx + 1,
        x.platform || '',
        x.displayName || x.handle || x.username || '',
        x.followers || '',
        x.engagementRate ?? '',
        x.score ?? '',
        x.profileUrl || '',
      ].join('\t')
    );
  });

  console.log('FILES', top10Path, shortlistPath, backupsPath);
}

main();
