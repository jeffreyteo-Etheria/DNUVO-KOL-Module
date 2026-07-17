// d.nuvo Pipeline Backend — Express server
// Endpoints: /verify-creator, /schedule, /post/tiktok, /post/meta, /kpi
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { verifyCreator } = require('./src/verifyCreator');
const { postTikTok } = require('./src/postTikTok');
const { postInstagram, postFacebook } = require('./src/postMeta');
const { sourceKolMultiActor } = require('./src/apifySource');
const {
  initDb,
  saveCampaign,
  listCampaigns,
  getCampaign,
  logCampaignAudit,
  listCampaignAudit,
  saveKpiEntry,
  listKpiEntries,
  getLatestKpiEntry,
} = require('./src/db');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // dashboard at http://localhost:3000
const isServerless = Boolean(process.env.NETLIFY) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const runtimeDataDir = isServerless ? path.join(os.tmpdir(), 'dnuvo-data') : path.join(__dirname, 'data');
if (!fs.existsSync(runtimeDataDir)) fs.mkdirSync(runtimeDataDir, { recursive: true });
const SCHEDULE_FILE = path.join(runtimeDataDir, 'schedule.json');
const load = () => fs.existsSync(SCHEDULE_FILE) ? JSON.parse(fs.readFileSync(SCHEDULE_FILE)) : [];
const save = (d) => fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(d, null, 2));

app.get('/health', async (_, res) => {
  let dbOk = false;
  try {
    await listCampaigns();
    dbOk = true;
  } catch (_) {
    dbOk = false;
  }

  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    services: {
      backend: true,
      database: dbOk,
      anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      apifyConfigured: Boolean(process.env.APIFY_TOKEN),
      tiktokConfigured: Boolean(process.env.TIKTOK_ACCESS_TOKEN),
      metaConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    },
  });
});

function sgtToDate(date, time) {
  return new Date(`${date}T${time}:00+08:00`); // SGT
}

async function processQueuedPosts(now = new Date()) {
  const all = load();
  let processed = 0;
  for (const post of all) {
    if (post.status !== 'queued') continue;
    if (sgtToDate(post.date, post.time) > now) continue;
    processed += 1;
    try {
      if (post.platform === 'TikTok') post.result = await postTikTok(post);
      else if (post.platform === 'Instagram') post.result = await postInstagram(post);
      else if (post.platform === 'Facebook') post.result = await postFacebook(post);
      else {
        post.status = 'manual';
        post.note = `${post.platform}: post via Seller Centre (no public posting API)`;
        continue;
      }
      post.status = 'posted';
      post.postedAt = now.toISOString();
    } catch (e) {
      post.status = 'failed';
      post.error = e.message;
    }
  }
  save(all);
  return { processed, total: all.length };
}

// ── Creator link verification ─────────────────────────────────────────────
// POST /verify-creator { "urls": ["https://www.tiktok.com/@handle", ...] }
// Returns per-URL: live (HTTP 200), redirected, dead, or blocked.
app.post('/verify-creator', async (req, res) => {
  const urls = req.body.urls || [];
  if (!urls.length) return res.status(400).json({ error: 'urls[] required' });
  const results = await Promise.all(urls.map(verifyCreator));
  res.json({ checkedAt: new Date().toISOString(), results });
});

// ── Apify multi-actor KOL sourcing ────────────────────────────────────────
app.post('/apify/kol-source', async (req, res) => {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(500).json({ error: 'APIFY_TOKEN missing in .env' });

  const {
    campaignId,
    setup,
    tiers,
    backup = 5,
    maxResults = 40,
  } = req.body || {};

  if (!setup || !setup.loc || !Array.isArray(setup.platforms)) {
    return res.status(400).json({ error: 'setup with loc and platforms[] is required' });
  }

  const actors = {
    discovery: process.env.APIFY_ACTOR_DISCOVERY || 'alizarin_refrigerator-owner/influencer-discovery---find-influencers-across-social-platforms',
    tiktok: process.env.APIFY_ACTOR_TIKTOK || 'alizarin_refrigerator-owner/tiktok-creator-scraper',
    instagram: process.env.APIFY_ACTOR_INSTAGRAM || 'seemuapps/instagram-related-profiles-scraper',
  };

  try {
    const out = await sourceKolMultiActor({ token, setup, tiers, backup, maxResults, actors });
    if (campaignId) {
      await logCampaignAudit({
        campaignId: Number(campaignId),
        action: 'apify_multi_source_run',
        details: {
          actorsUsed: out.actorsUsed,
          totalCandidates: out.totalCandidates,
          shortlist: out.shortlist.length,
          backups: out.backups.length,
        },
      });
    }
    res.json({
      sourcedAt: new Date().toISOString(),
      ...out,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Campaign persistence (SQLite) ──────────────────────────────────────────
app.get('/campaigns', async (_, res) => {
  try {
    res.json({ items: await listCampaigns() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/campaigns/:id', async (req, res) => {
  try {
    const item = await getCampaign(Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'Campaign not found' });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/campaigns/:id/audit', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const items = await listCampaignAudit(campaignId, limit);
    res.json({ campaignId, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/campaigns/:id/kpi', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const { spend = 0, revenue = 0, orders = 0, leads = 0, views = 0, clicks = 0, notes = '' } = req.body || {};
    const id = await saveKpiEntry({ campaignId, spend, revenue, orders, leads, views, clicks, notes });
    const latest = await getLatestKpiEntry(campaignId);
    await logCampaignAudit({
      campaignId,
      action: 'kpi_saved',
      details: { kpiEntryId: id, spend, revenue, orders, leads, views, clicks },
    });
    res.json({ saved: true, entry: latest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/campaigns/:id/kpi', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 200));
    const latest = await getLatestKpiEntry(campaignId);
    const history = await listKpiEntries(campaignId, limit);
    res.json({ campaignId, latest, history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/campaigns/save', async (req, res) => {
  try {
    const { id, name, status, snapshot } = req.body || {};
    if (!snapshot || !snapshot.setup) {
      return res.status(400).json({ error: 'snapshot.setup is required' });
    }
    const campaignId = await saveCampaign({
      id,
      name,
      status,
      setup: snapshot.setup,
      creators: snapshot.creators,
      content: snapshot.content,
      budget: snapshot.budget,
      schedule: snapshot.schedule,
      verifications: snapshot.verifications,
    });
    await logCampaignAudit({
      campaignId,
      action: id ? 'campaign_updated' : 'campaign_created',
      details: {
        name,
        status,
        setupReady: Boolean(snapshot?.setup),
        creatorsReady: Boolean(snapshot?.creators),
        contentBlocks: Array.isArray(snapshot?.content) ? snapshot.content.length : 0,
        scheduleRows: Array.isArray(snapshot?.schedule) ? snapshot.schedule.length : 0,
      },
    });
    const campaign = await getCampaign(campaignId);
    res.json({ saved: true, campaign });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI proxy (keeps API keys server-side) ──────────────────────────────────
app.post('/ai/generate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing in .env' });
  }
  const { prompt, system, maxTokens } = req.body || {};
  if (!prompt || !system) {
    return res.status(400).json({ error: 'prompt and system are required' });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.max(200, Math.min(Number(maxTokens) || 1000, 2000)),
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || 'AI request failed', raw: data });
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Schedule CRUD (accepts CSV rows exported from the dashboard) ──────────
app.post('/schedule', (req, res) => {
  const posts = req.body.posts || [];
  const all = load();
  posts.forEach(p => all.push({ ...p, id: Date.now() + Math.random(), status: 'queued' }));
  save(all);
  if (req.body.campaignId) {
    logCampaignAudit({
      campaignId: Number(req.body.campaignId),
      action: 'schedule_queued',
      details: { queued: posts.length },
    }).catch(() => {});
  }
  res.json({ queued: posts.length, total: all.length });
});
app.get('/schedule', (_, res) => res.json(load()));

app.get('/schedule/summary', (_, res) => {
  const items = load();
  const counts = items.reduce((acc, post) => {
    const k = post.status || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const queued = items
    .filter((p) => p.status === 'queued')
    .sort((a, b) => sgtToDate(a.date, a.time) - sgtToDate(b.date, b.time));
  res.json({
    total: items.length,
    counts,
    nextQueuedPost: queued[0] || null,
    checkedAt: new Date().toISOString(),
  });
});

app.post('/schedule/process-now', async (_, res) => {
  const result = await processQueuedPosts(new Date());
  res.json({ ...result, runAt: new Date().toISOString() });
});

// ── Direct post endpoints (used by scheduler.js or manually) ──────────────
app.post('/post/tiktok', async (req, res) => {
  try { res.json(await postTikTok(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/post/meta', async (req, res) => {
  try {
    const { platform } = req.body; // "instagram" | "facebook"
    const fn = platform === 'facebook' ? postFacebook : postInstagram;
    res.json(await fn(req.body));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KPI pull stubs (fill after API approval) ──────────────────────────────
app.get('/kpi/tiktok', async (_, res) => {
  // TikTok Business API: /v2/video/list + /v2/research endpoints once approved
  res.json({ note: 'Requires approved TikTok API scopes: video.list. See API-APPLICATION-GUIDE.md' });
});
app.get('/kpi/meta', async (_, res) => {
  // Graph API insights: /{ig-user-id}/insights, /{page-id}/insights
  res.json({ note: 'Requires instagram_manage_insights + read_insights permissions.' });
});

let initPromise;
function ensureInitialized() {
  if (!initPromise) initPromise = initDb();
  return initPromise;
}

if (require.main === module) {
  ensureInitialized()
    .then(() => {
      app.listen(process.env.PORT || 3000, () =>
        console.log(`d.nuvo backend running on :${process.env.PORT || 3000}`));
    })
    .catch((e) => {
      console.error('Failed to initialize SQLite DB:', e.message);
      process.exit(1);
    });
}

module.exports = { app, ensureInitialized };
