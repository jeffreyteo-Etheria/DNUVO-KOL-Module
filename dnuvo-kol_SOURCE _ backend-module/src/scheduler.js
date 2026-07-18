// Scheduler — runs every 5 minutes, posts anything queued whose datetime has passed.
// Start with: npm run scheduler   (keep alive with pm2 in production)
require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { postTikTok } = require('./postTikTok');
const { postInstagram, postFacebook } = require('./postMeta');
const { initDb } = require('./db');

const FILE = path.join(__dirname, '..', 'data', 'schedule.json');

// Posting reads OAuth tokens from the repository DB (with env fallback).
const dbReady = initDb().catch((e) => console.error('DB init failed, using env tokens only:', e.message));

cron.schedule('*/5 * * * *', async () => {
  await dbReady;
  if (!fs.existsSync(FILE)) return;
  const all = JSON.parse(fs.readFileSync(FILE));
  const now = new Date();
  for (const post of all) {
    if (post.status !== 'queued') continue;
    if (new Date(`${post.date}T${post.time}:00+08:00`) > now) continue; // SGT
    try {
      if (post.platform === 'TikTok') post.result = await postTikTok(post);
      else if (post.platform === 'Instagram') post.result = await postInstagram(post);
      else if (post.platform === 'Facebook') post.result = await postFacebook(post);
      else { post.status = 'manual'; post.note = `${post.platform}: post via Seller Centre (no public posting API)`; continue; }
      post.status = 'posted'; post.postedAt = now.toISOString();
    } catch (e) { post.status = 'failed'; post.error = e.message; }
  }
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  console.log(`[${now.toISOString()}] scheduler pass complete`);
});
console.log('d.nuvo scheduler running — checks queue every 5 min (SGT timezone)');
