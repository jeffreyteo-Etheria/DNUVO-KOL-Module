const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const isServerless = Boolean(process.env.NETLIFY) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const dataDir = isServerless
  ? path.join(os.tmpdir(), 'dnuvo-data')
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'pipeline.db');
const BLOB_KEY = 'pipeline.db';
let db;
let storageMode = 'file';
let storageError = null;
let blobWriteChain = Promise.resolve();

function getBlobStore() {
  if (!isServerless) return null;
  try {
    const { getStore } = require('@netlify/blobs');
    return getStore({ name: 'socialmind-db' });
  } catch (e) {
    storageError = 'getStore: ' + e.message;
    return null;
  }
}

function persistDb() {
  const bytes = db.export();
  fs.writeFileSync(dbPath, Buffer.from(bytes));
  const store = getBlobStore();
  if (store) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    blobWriteChain = blobWriteChain
      .then(() => store.set(BLOB_KEY, buf))
      .then(() => { storageMode = 'netlify-blobs'; storageError = null; })
      .catch((e) => { storageError = 'set: ' + e.message; console.error('Blob persist failed:', e.message); });
  }
}

function run(sql, params = []) {
  db.run(sql, params);
  const idRes = db.exec('SELECT last_insert_rowid() AS id');
  const chRes = db.exec('SELECT changes() AS changes');
  const lastID = idRes[0]?.values?.[0]?.[0] || 0;
  const changes = chRes[0]?.values?.[0]?.[0] || 0;
  return { lastID, changes };
}

function get(sql, params = []) {
  const stmt = db.prepare(sql, params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql, params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function loadDbBytes() {
  const store = getBlobStore();
  if (store) {
    try {
      const buf = await store.get(BLOB_KEY, { type: 'arrayBuffer' });
      if (buf && buf.byteLength) {
        storageMode = 'netlify-blobs';
        return new Uint8Array(buf);
      }
      storageMode = 'netlify-blobs';
    } catch (e) {
      storageError = 'get: ' + e.message;
      console.error('Blob load failed, falling back to file:', e.message);
    }
  }
  if (fs.existsSync(dbPath)) return fs.readFileSync(dbPath);
  return null;
}

function getStorageMode() {
  return storageError ? `${storageMode} (${storageError})` : storageMode;
}

async function initDb() {
  const SQL = await initSqlJs({});
  const bytes = await loadDbBytes();
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();

  run(`
    CREATE TABLE IF NOT EXISTS advertisers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      brand TEXT NOT NULL,
      logo_data TEXT,
      access_code TEXT UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_id INTEGER,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      setup_json TEXT,
      creators_text TEXT,
      content_json TEXT,
      budget_json TEXT,
      schedule_json TEXT,
      verifications_json TEXT,
      manual_creators_json TEXT,
      pricing_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migrations for databases created before these columns existed.
  try { run('ALTER TABLE campaigns ADD COLUMN advertiser_id INTEGER'); } catch (_) {}
  try { run('ALTER TABLE campaigns ADD COLUMN manual_creators_json TEXT'); } catch (_) {}
  try { run('ALTER TABLE campaigns ADD COLUMN pricing_json TEXT'); } catch (_) {}
  run(`
    CREATE TABLE IF NOT EXISTS campaign_kpi_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      spend REAL DEFAULT 0,
      revenue REAL DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      leads_count INTEGER DEFAULT 0,
      views_count INTEGER DEFAULT 0,
      clicks_count INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS campaign_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT DEFAULT 'dashboard',
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    )
  `);

  // Accumulative, cross-campaign creator library. A creator saved here from any
  // campaign stays available for every future campaign under the same advertiser.
  run(`
    CREATE TABLE IF NOT EXISTS creator_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_id INTEGER,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      handle TEXT,
      profile_url TEXT NOT NULL,
      followers INTEGER DEFAULT 0,
      tier TEXT,
      rate_note TEXT,
      niche TEXT,
      notes TEXT,
      source TEXT DEFAULT 'manual',
      verify_status TEXT DEFAULT 'unverified',
      verify_http INTEGER,
      verified_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { run('CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_sources_adv_url ON creator_sources(advertiser_id, profile_url)'); } catch (_) {}

  run(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      provider TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      user_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      used INTEGER DEFAULT 0,
      PRIMARY KEY (user_key, metric)
    )
  `);

  // Seed the first advertiser so existing DNUVO campaigns stay reachable.
  const advCount = get('SELECT COUNT(*) AS n FROM advertisers');
  if (!advCount || !advCount.n) {
    run(
      `INSERT INTO advertisers (company, brand, logo_data, access_code) VALUES (?, ?, ?, ?)`,
      ['Etheria Group', 'DNUVO', 'assets/dnuvo_logo_black.png', process.env.DNUVO_ACCESS_CODE || 'DNUVO-2026']
    );
    const seeded = get('SELECT last_insert_rowid() AS id');
    run('UPDATE campaigns SET advertiser_id = ? WHERE advertiser_id IS NULL', [seeded.id]);
  }

  persistDb();
}

function generateAccessCode() {
  return 'SM-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function mapAdvertiser(r) {
  if (!r) return null;
  return {
    id: r.id,
    company: r.company,
    brand: r.brand,
    logo: r.logo_data || null,
    accessCode: r.access_code,
    createdAt: r.createdAt || r.created_at,
    updatedAt: r.updatedAt || r.updated_at,
  };
}

async function saveAdvertiser({ id, company, brand, logo }) {
  if (id) {
    run(
      `UPDATE advertisers SET company = ?, brand = ?, logo_data = COALESCE(?, logo_data), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [company, brand, logo || null, id]
    );
    persistDb();
    return Number(id);
  }
  const created = run(
    `INSERT INTO advertisers (company, brand, logo_data, access_code) VALUES (?, ?, ?, ?)`,
    [company, brand, logo || null, generateAccessCode()]
  );
  persistDb();
  return created.lastID;
}

async function listAdvertisers() {
  return all(
    `SELECT id, company, brand, logo_data, access_code, created_at AS createdAt, updated_at AS updatedAt
     FROM advertisers ORDER BY company COLLATE NOCASE`
  ).map(mapAdvertiser);
}

async function getAdvertiser(id) {
  return mapAdvertiser(get(
    `SELECT id, company, brand, logo_data, access_code, created_at AS createdAt, updated_at AS updatedAt
     FROM advertisers WHERE id = ?`,
    [id]
  ));
}

async function getAdvertiserByCode(code) {
  return mapAdvertiser(get(
    `SELECT id, company, brand, logo_data, access_code, created_at AS createdAt, updated_at AS updatedAt
     FROM advertisers WHERE access_code = ?`,
    [code]
  ));
}

async function saveCampaign(payload) {
  const {
    id,
    advertiserId,
    name,
    status = 'draft',
    setup,
    creators,
    content,
    budget,
    schedule,
    verifications,
    manualCreators,
    pricing,
  } = payload;

  const row = {
    name: name || `Campaign ${new Date().toISOString().slice(0, 10)}`,
    status,
    setup_json: JSON.stringify(setup || null),
    creators_text: creators || null,
    content_json: JSON.stringify(content || []),
    budget_json: JSON.stringify(budget || null),
    schedule_json: JSON.stringify(schedule || []),
    verifications_json: JSON.stringify(verifications || []),
    manual_creators_json: JSON.stringify(manualCreators || []),
    pricing_json: JSON.stringify(pricing || null),
  };

  if (id) {
    run(
      `UPDATE campaigns
       SET name = ?, status = ?, setup_json = ?, creators_text = ?, content_json = ?,
           budget_json = ?, schedule_json = ?, verifications_json = ?, manual_creators_json = ?,
           pricing_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        row.name,
        row.status,
        row.setup_json,
        row.creators_text,
        row.content_json,
        row.budget_json,
        row.schedule_json,
        row.verifications_json,
        row.manual_creators_json,
        row.pricing_json,
        id,
      ]
    );
    persistDb();
    return Number(id);
  }

  const created = run(
    `INSERT INTO campaigns
      (advertiser_id, name, status, setup_json, creators_text, content_json, budget_json, schedule_json, verifications_json, manual_creators_json, pricing_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      advertiserId || null,
      row.name,
      row.status,
      row.setup_json,
      row.creators_text,
      row.content_json,
      row.budget_json,
      row.schedule_json,
      row.verifications_json,
      row.manual_creators_json,
      row.pricing_json,
    ]
  );
  persistDb();
  return created.lastID;
}

async function listCampaigns(advertiserId = null) {
  const where = advertiserId ? 'WHERE c.advertiser_id = ?' : '';
  const params = advertiserId ? [advertiserId] : [];
  return all(
    `SELECT c.id, c.advertiser_id AS advertiserId, c.name, c.status,
            c.created_at AS createdAt, c.updated_at AS updatedAt,
            a.brand AS advertiserBrand, a.company AS advertiserCompany
     FROM campaigns c
     LEFT JOIN advertisers a ON a.id = c.advertiser_id
     ${where}
     ORDER BY c.updated_at DESC`,
    params
  );
}

async function getCampaign(id) {
  const c = await get(
    `SELECT id, advertiser_id AS advertiserId, name, status, setup_json, creators_text, content_json,
            budget_json, schedule_json, verifications_json, manual_creators_json, pricing_json,
            created_at AS createdAt, updated_at AS updatedAt
     FROM campaigns
     WHERE id = ?`,
    [id]
  );
  if (!c) return null;
  return {
    id: c.id,
    advertiserId: c.advertiserId || null,
    name: c.name,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    snapshot: {
      setup: c.setup_json ? JSON.parse(c.setup_json) : null,
      creators: c.creators_text || null,
      content: c.content_json ? JSON.parse(c.content_json) : [],
      budget: c.budget_json ? JSON.parse(c.budget_json) : null,
      schedule: c.schedule_json ? JSON.parse(c.schedule_json) : [],
      verifications: c.verifications_json ? JSON.parse(c.verifications_json) : [],
      manualCreators: c.manual_creators_json ? JSON.parse(c.manual_creators_json) : [],
      pricing: c.pricing_json ? JSON.parse(c.pricing_json) : null,
    },
  };
}

async function deleteAdvertiser(id) {
  const owned = get('SELECT COUNT(*) AS n FROM campaigns WHERE advertiser_id = ?', [id]);
  if (owned && owned.n) {
    throw new Error(`Advertiser still has ${owned.n} campaign(s) in the repository. Delete those first.`);
  }
  const res = run('DELETE FROM advertisers WHERE id = ?', [id]);
  persistDb();
  return res.changes > 0;
}

async function deleteCampaign(id) {
  run('DELETE FROM campaign_kpi_entries WHERE campaign_id = ?', [id]);
  run('DELETE FROM campaign_audit_logs WHERE campaign_id = ?', [id]);
  const res = run('DELETE FROM campaigns WHERE id = ?', [id]);
  persistDb();
  return res.changes > 0;
}

async function logCampaignAudit({ campaignId, action, actor = 'dashboard', details = {} }) {
  run(
    `INSERT INTO campaign_audit_logs (campaign_id, action, actor, details_json)
     VALUES (?, ?, ?, ?)`,
    [campaignId, action, actor, JSON.stringify(details)]
  );
  persistDb();
}

async function listCampaignAudit(campaignId, limit = 50) {
  const rows = all(
    `SELECT id, campaign_id AS campaignId, action, actor, details_json, created_at AS createdAt
     FROM campaign_audit_logs
     WHERE campaign_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [campaignId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    action: r.action,
    actor: r.actor,
    details: r.details_json ? JSON.parse(r.details_json) : {},
    createdAt: r.createdAt,
  }));
}

async function saveKpiEntry({ campaignId, spend = 0, revenue = 0, orders = 0, leads = 0, views = 0, clicks = 0, notes = '' }) {
  const row = run(
    `INSERT INTO campaign_kpi_entries
      (campaign_id, spend, revenue, orders_count, leads_count, views_count, clicks_count, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [campaignId, spend, revenue, orders, leads, views, clicks, notes]
  );
  persistDb();
  return row.lastID;
}

function computeKpiMetrics(item) {
  const spend = Number(item.spend || 0);
  const revenue = Number(item.revenue || 0);
  const orders = Number(item.orders || item.orders_count || 0);
  const leads = Number(item.leads || item.leads_count || 0);
  const views = Number(item.views || item.views_count || 0);
  const clicks = Number(item.clicks || item.clicks_count || 0);
  return {
    roas: spend > 0 ? Number((revenue / spend).toFixed(4)) : null,
    cpl: spend > 0 && leads > 0 ? Number((spend / leads).toFixed(4)) : null,
    aov: orders > 0 ? Number((revenue / orders).toFixed(4)) : null,
    conversionRate: clicks > 0 && orders > 0 ? Number(((orders / clicks) * 100).toFixed(4)) : null,
    cpv: spend > 0 && views > 0 ? Number((spend / views).toFixed(6)) : null,
    ctr: views > 0 && clicks > 0 ? Number(((clicks / views) * 100).toFixed(4)) : null,
  };
}

async function listKpiEntries(campaignId, limit = 30) {
  const rows = all(
    `SELECT id, campaign_id AS campaignId, spend, revenue, orders_count AS orders,
            leads_count AS leads, views_count AS views, clicks_count AS clicks,
            notes, created_at AS createdAt
     FROM campaign_kpi_entries
     WHERE campaign_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [campaignId, limit]
  );
  return rows.map((r) => ({ ...r, metrics: computeKpiMetrics(r) }));
}

async function getLatestKpiEntry(campaignId) {
  const row = get(
    `SELECT id, campaign_id AS campaignId, spend, revenue, orders_count AS orders,
            leads_count AS leads, views_count AS views, clicks_count AS clicks,
            notes, created_at AS createdAt
     FROM campaign_kpi_entries
     WHERE campaign_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [campaignId]
  );
  return row ? { ...row, metrics: computeKpiMetrics(row) } : null;
}

// ── Creator sources (accumulative cross-campaign creator library) ──────────
function mapCreatorSource(r) {
  if (!r) return null;
  return {
    id: r.id,
    advertiserId: r.advertiserId || null,
    name: r.name,
    platform: r.platform,
    handle: r.handle || '',
    profileUrl: r.profileUrl,
    followers: Number(r.followers || 0),
    tier: r.tier || '',
    rateNote: r.rateNote || '',
    niche: r.niche || '',
    notes: r.notes || '',
    source: r.source || 'manual',
    verifyStatus: r.verifyStatus || 'unverified',
    verifyHttp: r.verifyHttp ?? null,
    verifiedAt: r.verifiedAt || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const CREATOR_SOURCE_COLUMNS = `id, advertiser_id AS advertiserId, name, platform, handle, profile_url AS profileUrl,
  followers, tier, rate_note AS rateNote, niche, notes, source, verify_status AS verifyStatus,
  verify_http AS verifyHttp, verified_at AS verifiedAt, created_at AS createdAt, updated_at AS updatedAt`;

async function saveCreatorSource(payload) {
  const {
    id, advertiserId, name, platform, handle, profileUrl,
    followers = 0, tier = '', rateNote = '', niche = '', notes = '', source = 'manual',
  } = payload;
  if (!name || !platform || !profileUrl) {
    throw new Error('name, platform, and profileUrl are required');
  }
  if (id) {
    run(
      `UPDATE creator_sources
       SET name = ?, platform = ?, handle = ?, profile_url = ?, followers = ?, tier = ?,
           rate_note = ?, niche = ?, notes = ?, source = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [name, platform, handle || '', profileUrl, followers, tier, rateNote, niche, notes, source, id]
    );
    persistDb();
    return Number(id);
  }
  // Upsert on (advertiser_id, profile_url) so re-saving the same creator from a
  // different campaign updates the one library row instead of duplicating it.
  // SQLite treats every NULL as distinct from every other NULL, so a NULL
  // advertiser_id would defeat this unique constraint entirely — use 0 as an
  // explicit "no advertiser" sentinel instead (mapCreatorSource maps it back
  // to null on read; real advertiser ids are always >= 1 via AUTOINCREMENT).
  const advKey = advertiserId || 0;
  run(
    `INSERT INTO creator_sources
      (advertiser_id, name, platform, handle, profile_url, followers, tier, rate_note, niche, notes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(advertiser_id, profile_url) DO UPDATE SET
       name = excluded.name, platform = excluded.platform, handle = excluded.handle,
       followers = excluded.followers, tier = excluded.tier, rate_note = excluded.rate_note,
       niche = excluded.niche, notes = excluded.notes, source = excluded.source,
       updated_at = CURRENT_TIMESTAMP`,
    [advKey, name, platform, handle || '', profileUrl, followers, tier, rateNote, niche, notes, source]
  );
  persistDb();
  const row = get(
    `SELECT id FROM creator_sources WHERE profile_url = ? AND advertiser_id = ?`,
    [profileUrl, advKey]
  );
  return row ? row.id : null;
}

async function listCreatorSources(advertiserId = null) {
  const where = advertiserId ? 'WHERE advertiser_id = ?' : '';
  const params = advertiserId ? [advertiserId] : [];
  return all(
    `SELECT ${CREATOR_SOURCE_COLUMNS} FROM creator_sources ${where} ORDER BY updated_at DESC`,
    params
  ).map(mapCreatorSource);
}

async function getCreatorSourcesByIds(ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return all(
    `SELECT ${CREATOR_SOURCE_COLUMNS} FROM creator_sources WHERE id IN (${placeholders})`,
    ids
  ).map(mapCreatorSource);
}

async function deleteCreatorSource(id) {
  const res = run('DELETE FROM creator_sources WHERE id = ?', [id]);
  persistDb();
  return res.changes > 0;
}

async function updateCreatorSourceVerification(id, { status, http, verifiedAt }) {
  run(
    `UPDATE creator_sources SET verify_status = ?, verify_http = ?, verified_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, http ?? null, verifiedAt, id]
  );
  persistDb();
}

// ── API token store (TikTok / Meta OAuth credentials) ──────────────────────
async function saveApiToken(provider, data) {
  run(
    `INSERT INTO api_tokens (provider, data_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET data_json = excluded.data_json, updated_at = CURRENT_TIMESTAMP`,
    [provider, JSON.stringify(data)]
  );
  persistDb();
}

async function getApiToken(provider) {
  const row = get('SELECT data_json FROM api_tokens WHERE provider = ?', [provider]);
  return row ? JSON.parse(row.data_json) : null;
}

async function deleteApiToken(provider) {
  const res = run('DELETE FROM api_tokens WHERE provider = ?', [provider]);
  persistDb();
  return res.changes > 0;
}

// ── OAuth state tokens (CSRF protection for the connect flows) ─────────────
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

async function createOauthState(provider) {
  const state = crypto.randomBytes(16).toString('hex');
  run('DELETE FROM oauth_states WHERE created_at < ?', [Date.now() - OAUTH_STATE_TTL_MS]);
  run('INSERT INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)', [state, provider, Date.now()]);
  persistDb();
  return state;
}

async function consumeOauthState(state, provider) {
  const row = get('SELECT provider, created_at AS createdAt FROM oauth_states WHERE state = ?', [state]);
  if (row) { run('DELETE FROM oauth_states WHERE state = ?', [state]); persistDb(); }
  if (!row || row.provider !== provider) return false;
  return Date.now() - Number(row.createdAt) < OAUTH_STATE_TTL_MS;
}

// ── Usage quotas (per-user cost control for scraping / AI endpoints) ───────
// Fixed-window counters: each (user_key, metric) pair holds one window.
// When the window has elapsed the counter resets on next touch.

function readQuotaRow(userKey, metric, windowMs, now) {
  const row = get(
    'SELECT window_start AS windowStart, used FROM usage_counters WHERE user_key = ? AND metric = ?',
    [userKey, metric]
  );
  let windowStart = row ? Number(row.windowStart) : now;
  let used = row ? Number(row.used) : 0;
  if (!row || now - windowStart >= windowMs) {
    windowStart = now;
    used = 0;
  }
  return { windowStart, used };
}

async function peekQuota({ userKey, metric, limit, windowMs }) {
  const now = Date.now();
  const { windowStart, used } = readQuotaRow(userKey, metric, windowMs, now);
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: new Date(windowStart + windowMs).toISOString(),
  };
}

// force: record usage even past the limit (used after work already ran),
// clamping the counter at the limit instead of rejecting.
async function consumeQuota({ userKey, metric, amount = 1, limit, windowMs, force = false }) {
  const now = Date.now();
  const { windowStart, used } = readQuotaRow(userKey, metric, windowMs, now);
  const resetAt = new Date(windowStart + windowMs).toISOString();
  if (!force && used + amount > limit) {
    return { allowed: false, used, limit, remaining: Math.max(0, limit - used), resetAt };
  }
  const next = Math.min(limit, used + amount);
  run(
    `INSERT INTO usage_counters (user_key, metric, window_start, used) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_key, metric) DO UPDATE SET window_start = excluded.window_start, used = excluded.used`,
    [userKey, metric, windowStart, next]
  );
  persistDb();
  return { allowed: true, used: next, limit, remaining: Math.max(0, limit - next), resetAt };
}

module.exports = {
  initDb,
  peekQuota,
  consumeQuota,
  saveApiToken,
  getApiToken,
  deleteApiToken,
  createOauthState,
  consumeOauthState,
  getStorageMode,
  saveAdvertiser,
  listAdvertisers,
  getAdvertiser,
  getAdvertiserByCode,
  deleteAdvertiser,
  saveCampaign,
  listCampaigns,
  getCampaign,
  deleteCampaign,
  logCampaignAudit,
  listCampaignAudit,
  saveKpiEntry,
  listKpiEntries,
  getLatestKpiEntry,
  saveCreatorSource,
  listCreatorSources,
  getCreatorSourcesByIds,
  deleteCreatorSource,
  updateCreatorSourceVerification,
};
