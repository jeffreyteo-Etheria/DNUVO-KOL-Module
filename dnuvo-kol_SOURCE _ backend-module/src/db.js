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
      tiktok_handle TEXT,
      instagram_handle TEXT,
      meta_handle TEXT,
      line_id TEXT,
      outreach_stage TEXT DEFAULT 'not_contacted',
      last_contacted_at TEXT,
      partnership_type TEXT DEFAULT 'unset',
      flat_fee REAL,
      commission_livestream_pct REAL,
      commission_ugc_affiliate_pct REAL,
      payment_status TEXT DEFAULT 'unpaid',
      payment_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { run('CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_sources_adv_url ON creator_sources(advertiser_id, profile_url)'); } catch (_) {}
  // Migrations for creator_sources columns added after the table's first release.
  try { run('ALTER TABLE creator_sources ADD COLUMN tiktok_handle TEXT'); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN instagram_handle TEXT'); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN meta_handle TEXT'); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN line_id TEXT'); } catch (_) {}
  try { run("ALTER TABLE creator_sources ADD COLUMN outreach_stage TEXT DEFAULT 'not_contacted'"); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN last_contacted_at TEXT'); } catch (_) {}
  try { run("ALTER TABLE creator_sources ADD COLUMN partnership_type TEXT DEFAULT 'unset'"); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN flat_fee REAL'); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN commission_livestream_pct REAL'); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN commission_ugc_affiliate_pct REAL'); } catch (_) {}
  try { run("ALTER TABLE creator_sources ADD COLUMN payment_status TEXT DEFAULT 'unpaid'"); } catch (_) {}
  try { run('ALTER TABLE creator_sources ADD COLUMN payment_notes TEXT'); } catch (_) {}

  // Creator activity calendar — UGC posts, livestreams, and paid-boost flights,
  // one row per scheduled activity. This is the umbrella view everything else
  // (deliverables, payments, activity KPI) hangs off of via calendar_entry_id.
  run(`
    CREATE TABLE IF NOT EXISTS creator_calendar_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_id INTEGER,
      campaign_id INTEGER,
      creator_id INTEGER,
      activity_type TEXT NOT NULL,
      title TEXT,
      sku TEXT,
      platform TEXT,
      scheduled_date TEXT,
      scheduled_time TEXT,
      status TEXT DEFAULT 'scheduled',
      budget_allocated REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  run('CREATE INDEX IF NOT EXISTS idx_calendar_campaign ON creator_calendar_entries(campaign_id)');
  run('CREATE INDEX IF NOT EXISTS idx_calendar_creator ON creator_calendar_entries(creator_id)');

  // Proof-of-delivery submissions against a calendar entry.
  run(`
    CREATE TABLE IF NOT EXISTS creator_deliverables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_entry_id INTEGER NOT NULL,
      creator_id INTEGER,
      submission_url TEXT,
      submission_note TEXT,
      status TEXT DEFAULT 'pending',
      submitted_at TEXT,
      reviewed_at TEXT,
      reviewer_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (calendar_entry_id) REFERENCES creator_calendar_entries(id)
    )
  `);
  run('CREATE INDEX IF NOT EXISTS idx_deliverables_entry ON creator_deliverables(calendar_entry_id)');

  // Creator payment ledger: flat fees, livestream-GMV commission, and UGC
  // affiliate-sale commission all post here so budget utilisation and payout
  // status can be tracked per creator per campaign.
  run(`
    CREATE TABLE IF NOT EXISTS creator_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_id INTEGER,
      campaign_id INTEGER,
      creator_id INTEGER,
      calendar_entry_id INTEGER,
      pay_type TEXT NOT NULL,
      basis_amount REAL DEFAULT 0,
      rate_pct REAL,
      amount REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      scheduled_date TEXT,
      paid_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  run('CREATE INDEX IF NOT EXISTS idx_payments_campaign ON creator_payments(campaign_id)');
  run('CREATE INDEX IF NOT EXISTS idx_payments_creator ON creator_payments(creator_id)');

  // Activity-level KPI split (UGC / livestream / paid_boost), distinct from the
  // whole-campaign campaign_kpi_entries roll-up above.
  run(`
    CREATE TABLE IF NOT EXISTS campaign_activity_kpi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      spend REAL DEFAULT 0,
      revenue REAL DEFAULT 0,
      gmv REAL DEFAULT 0,
      views_count INTEGER DEFAULT 0,
      clicks_count INTEGER DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    )
  `);
  run('CREATE INDEX IF NOT EXISTS idx_activity_kpi_campaign ON campaign_activity_kpi(campaign_id)');

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
    tiktokHandle: r.tiktokHandle || '',
    instagramHandle: r.instagramHandle || '',
    metaHandle: r.metaHandle || '',
    lineId: r.lineId || '',
    outreachStage: r.outreachStage || 'not_contacted',
    lastContactedAt: r.lastContactedAt || null,
    partnershipType: r.partnershipType || 'unset',
    flatFee: r.flatFee ?? null,
    commissionLivestreamPct: r.commissionLivestreamPct ?? null,
    commissionUgcAffiliatePct: r.commissionUgcAffiliatePct ?? null,
    paymentStatus: r.paymentStatus || 'unpaid',
    paymentNotes: r.paymentNotes || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const CREATOR_SOURCE_COLUMNS = `id, advertiser_id AS advertiserId, name, platform, handle, profile_url AS profileUrl,
  followers, tier, rate_note AS rateNote, niche, notes, source, verify_status AS verifyStatus,
  verify_http AS verifyHttp, verified_at AS verifiedAt, tiktok_handle AS tiktokHandle,
  instagram_handle AS instagramHandle, meta_handle AS metaHandle, line_id AS lineId,
  outreach_stage AS outreachStage, last_contacted_at AS lastContactedAt,
  partnership_type AS partnershipType, flat_fee AS flatFee,
  commission_livestream_pct AS commissionLivestreamPct, commission_ugc_affiliate_pct AS commissionUgcAffiliatePct,
  payment_status AS paymentStatus, payment_notes AS paymentNotes,
  created_at AS createdAt, updated_at AS updatedAt`;

async function saveCreatorSource(payload) {
  if (payload.id) {
    // Partial update: merge only the fields the caller actually supplied onto
    // the existing row, so e.g. a stage-change call ({id, outreachStage}) can't
    // silently blank out followers/handles/notes the way a blind overwrite would.
    const existing = mapCreatorSource(get(`SELECT ${CREATOR_SOURCE_COLUMNS} FROM creator_sources WHERE id = ?`, [payload.id]));
    if (!existing) throw new Error('Creator source not found');
    const merged = { ...existing, ...Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)) };
    if (!merged.name || !merged.platform || !merged.profileUrl) {
      throw new Error('name, platform, and profileUrl are required');
    }
    run(
      `UPDATE creator_sources
       SET name = ?, platform = ?, handle = ?, profile_url = ?, followers = ?, tier = ?,
           rate_note = ?, niche = ?, notes = ?, source = ?, tiktok_handle = ?, instagram_handle = ?,
           meta_handle = ?, line_id = ?, outreach_stage = ?, last_contacted_at = ?,
           partnership_type = ?, flat_fee = ?, commission_livestream_pct = ?, commission_ugc_affiliate_pct = ?,
           payment_status = ?, payment_notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [merged.name, merged.platform, merged.handle || '', merged.profileUrl, merged.followers || 0, merged.tier || '',
        merged.rateNote || '', merged.niche || '', merged.notes || '', merged.source || 'manual',
        merged.tiktokHandle || '', merged.instagramHandle || '', merged.metaHandle || '', merged.lineId || '',
        merged.outreachStage || 'not_contacted', merged.lastContactedAt || null,
        merged.partnershipType || 'unset', merged.flatFee ?? null, merged.commissionLivestreamPct ?? null,
        merged.commissionUgcAffiliatePct ?? null, merged.paymentStatus || 'unpaid', merged.paymentNotes || '',
        payload.id]
    );
    persistDb();
    return Number(payload.id);
  }
  const {
    advertiserId, name, platform, handle, profileUrl,
    followers = 0, tier = '', rateNote = '', niche = '', notes = '', source = 'manual',
    tiktokHandle = '', instagramHandle = '', metaHandle = '', lineId = '',
    partnershipType = 'unset', flatFee = null, commissionLivestreamPct = null, commissionUgcAffiliatePct = null,
    paymentStatus = 'unpaid', paymentNotes = '',
  } = payload;
  if (!name || !platform || !profileUrl) {
    throw new Error('name, platform, and profileUrl are required');
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
      (advertiser_id, name, platform, handle, profile_url, followers, tier, rate_note, niche, notes, source,
       tiktok_handle, instagram_handle, meta_handle, line_id,
       partnership_type, flat_fee, commission_livestream_pct, commission_ugc_affiliate_pct, payment_status, payment_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(advertiser_id, profile_url) DO UPDATE SET
       name = excluded.name, platform = excluded.platform, handle = excluded.handle,
       followers = excluded.followers, tier = excluded.tier, rate_note = excluded.rate_note,
       niche = excluded.niche, notes = excluded.notes, source = excluded.source,
       tiktok_handle = excluded.tiktok_handle, instagram_handle = excluded.instagram_handle,
       meta_handle = excluded.meta_handle, line_id = excluded.line_id,
       partnership_type = excluded.partnership_type, flat_fee = excluded.flat_fee,
       commission_livestream_pct = excluded.commission_livestream_pct,
       commission_ugc_affiliate_pct = excluded.commission_ugc_affiliate_pct,
       payment_status = excluded.payment_status, payment_notes = excluded.payment_notes,
       updated_at = CURRENT_TIMESTAMP`,
    [advKey, name, platform, handle || '', profileUrl, followers, tier, rateNote, niche, notes, source,
      tiktokHandle, instagramHandle, metaHandle, lineId,
      partnershipType, flatFee, commissionLivestreamPct, commissionUgcAffiliatePct, paymentStatus, paymentNotes]
  );
  persistDb();
  const row = get(
    `SELECT id FROM creator_sources WHERE profile_url = ? AND advertiser_id = ?`,
    [profileUrl, advKey]
  );
  return row ? row.id : null;
}

// Bulk-loads creator rows (e.g. from a CSV upload) instead of one POST per
// creator. Each row goes through the same validation/upsert as saveCreatorSource
// so a bad row is reported, not silently dropped or allowed to corrupt the batch.
async function bulkImportCreatorSources(items, advertiserId) {
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i];
    try {
      const id = await saveCreatorSource({ ...row, advertiserId });
      results.push({ row: i, ok: true, id, name: row.name });
    } catch (e) {
      results.push({ row: i, ok: false, error: e.message, name: row?.name });
    }
  }
  return {
    imported: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

// Search across the creator library. LIKE-based, case-insensitive via COLLATE
// NOCASE on TEXT columns — fine at this table's expected scale, not meant for
// full-text search at very large volumes.
async function searchCreatorSources({ advertiserId = null, q = '', partnershipType = '', outreachStage = '' } = {}) {
  const clauses = [];
  const params = [];
  if (advertiserId) { clauses.push('advertiser_id = ?'); params.push(advertiserId); }
  if (partnershipType) { clauses.push('partnership_type = ?'); params.push(partnershipType); }
  if (outreachStage) { clauses.push('outreach_stage = ?'); params.push(outreachStage); }
  if (q) {
    const like = `%${q}%`;
    clauses.push(`(
      name LIKE ? COLLATE NOCASE OR handle LIKE ? COLLATE NOCASE OR platform LIKE ? COLLATE NOCASE OR
      tier LIKE ? COLLATE NOCASE OR niche LIKE ? COLLATE NOCASE OR notes LIKE ? COLLATE NOCASE OR
      rate_note LIKE ? COLLATE NOCASE OR tiktok_handle LIKE ? COLLATE NOCASE OR instagram_handle LIKE ? COLLATE NOCASE
    )`);
    params.push(like, like, like, like, like, like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT ${CREATOR_SOURCE_COLUMNS} FROM creator_sources ${where} ORDER BY updated_at DESC LIMIT 200`,
    params
  ).map(mapCreatorSource);
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

// ── Creator activity calendar (UGC / livestream / paid_boost) ──────────────
const CALENDAR_COLUMNS = `id, advertiser_id AS advertiserId, campaign_id AS campaignId, creator_id AS creatorId,
  activity_type AS activityType, title, sku, platform, scheduled_date AS scheduledDate,
  scheduled_time AS scheduledTime, status, budget_allocated AS budgetAllocated, notes,
  created_at AS createdAt, updated_at AS updatedAt`;

function mapCalendarEntry(r) {
  if (!r) return null;
  return {
    id: r.id,
    advertiserId: r.advertiserId || null,
    campaignId: r.campaignId || null,
    creatorId: r.creatorId || null,
    activityType: r.activityType,
    title: r.title || '',
    sku: r.sku || '',
    platform: r.platform || '',
    scheduledDate: r.scheduledDate || null,
    scheduledTime: r.scheduledTime || '',
    status: r.status || 'scheduled',
    budgetAllocated: Number(r.budgetAllocated || 0),
    notes: r.notes || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function getCalendarEntry(id) {
  return mapCalendarEntry(get(`SELECT ${CALENDAR_COLUMNS} FROM creator_calendar_entries WHERE id = ?`, [id]));
}

async function saveCalendarEntry(payload) {
  if (payload.id) {
    // Partial update (e.g. a bare {id, status} status change) merges onto the
    // existing row instead of blanking every other column — the same pattern
    // saveCreatorSource already uses, for the same reason.
    const existing = await getCalendarEntry(payload.id);
    if (!existing) throw new Error('Calendar entry not found');
    const merged = { ...existing, ...Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)) };
    if (!merged.activityType) throw new Error('activityType is required');
    run(
      `UPDATE creator_calendar_entries
       SET campaign_id = ?, creator_id = ?, activity_type = ?, title = ?, sku = ?, platform = ?,
           scheduled_date = ?, scheduled_time = ?, status = ?, budget_allocated = ?, notes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [merged.campaignId || null, merged.creatorId || null, merged.activityType, merged.title, merged.sku, merged.platform,
        merged.scheduledDate, merged.scheduledTime, merged.status, merged.budgetAllocated, merged.notes, payload.id]
    );
    persistDb();
    return Number(payload.id);
  }
  const {
    advertiserId, campaignId, creatorId, activityType, title = '', sku = '',
    platform = '', scheduledDate = null, scheduledTime = '', status = 'scheduled',
    budgetAllocated = 0, notes = '',
  } = payload;
  if (!activityType) throw new Error('activityType is required');
  const created = run(
    `INSERT INTO creator_calendar_entries
      (advertiser_id, campaign_id, creator_id, activity_type, title, sku, platform, scheduled_date, scheduled_time, status, budget_allocated, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [advertiserId || null, campaignId || null, creatorId || null, activityType, title, sku, platform,
      scheduledDate, scheduledTime, status, budgetAllocated, notes]
  );
  persistDb();
  return created.lastID;
}

async function listCalendarEntries({ campaignId = null, advertiserId = null } = {}) {
  const clauses = [];
  const params = [];
  if (campaignId) { clauses.push('campaign_id = ?'); params.push(campaignId); }
  if (advertiserId) { clauses.push('advertiser_id = ?'); params.push(advertiserId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT ${CALENDAR_COLUMNS} FROM creator_calendar_entries ${where} ORDER BY scheduled_date ASC, id ASC`,
    params
  ).map(mapCalendarEntry);
}

async function deleteCalendarEntry(id) {
  run('DELETE FROM creator_deliverables WHERE calendar_entry_id = ?', [id]);
  const res = run('DELETE FROM creator_calendar_entries WHERE id = ?', [id]);
  persistDb();
  return res.changes > 0;
}

// ── Proof-of-delivery submissions ───────────────────────────────────────────
const DELIVERABLE_COLUMNS = `id, calendar_entry_id AS calendarEntryId, creator_id AS creatorId,
  submission_url AS submissionUrl, submission_note AS submissionNote, status,
  submitted_at AS submittedAt, reviewed_at AS reviewedAt, reviewer_notes AS reviewerNotes,
  created_at AS createdAt, updated_at AS updatedAt`;

function mapDeliverable(r) {
  if (!r) return null;
  return {
    id: r.id,
    calendarEntryId: r.calendarEntryId,
    creatorId: r.creatorId || null,
    submissionUrl: r.submissionUrl || '',
    submissionNote: r.submissionNote || '',
    status: r.status || 'pending',
    submittedAt: r.submittedAt || null,
    reviewedAt: r.reviewedAt || null,
    reviewerNotes: r.reviewerNotes || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function getDeliverable(id) {
  return mapDeliverable(get(`SELECT ${DELIVERABLE_COLUMNS} FROM creator_deliverables WHERE id = ?`, [id]));
}

async function saveDeliverable(payload) {
  const { calendarEntryId, creatorId, submissionUrl = '', submissionNote = '' } = payload;
  if (!calendarEntryId) throw new Error('calendarEntryId is required');
  const created = run(
    `INSERT INTO creator_deliverables (calendar_entry_id, creator_id, submission_url, submission_note, status, submitted_at)
     VALUES (?, ?, ?, ?, 'submitted', CURRENT_TIMESTAMP)`,
    [calendarEntryId, creatorId || null, submissionUrl, submissionNote]
  );
  run(`UPDATE creator_calendar_entries SET status = 'delivered', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [calendarEntryId]);
  persistDb();
  return created.lastID;
}

const DELIVERABLE_COLUMNS_JOINED = `d.id, d.calendar_entry_id AS calendarEntryId, d.creator_id AS creatorId,
  d.submission_url AS submissionUrl, d.submission_note AS submissionNote, d.status,
  d.submitted_at AS submittedAt, d.reviewed_at AS reviewedAt, d.reviewer_notes AS reviewerNotes,
  d.created_at AS createdAt, d.updated_at AS updatedAt`;

async function listDeliverables({ calendarEntryId = null, campaignId = null } = {}) {
  if (campaignId) {
    return all(
      `SELECT ${DELIVERABLE_COLUMNS_JOINED}
       FROM creator_deliverables d
       JOIN creator_calendar_entries ce ON ce.id = d.calendar_entry_id
       WHERE ce.campaign_id = ?
       ORDER BY d.id DESC`,
      [campaignId]
    ).map(mapDeliverable);
  }
  const clauses = [];
  const params = [];
  if (calendarEntryId) { clauses.push('calendar_entry_id = ?'); params.push(calendarEntryId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT ${DELIVERABLE_COLUMNS} FROM creator_deliverables ${where} ORDER BY id DESC`, params).map(mapDeliverable);
}

async function updateDeliverableStatus(id, { status, reviewerNotes = '' }) {
  run(
    `UPDATE creator_deliverables SET status = ?, reviewer_notes = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, reviewerNotes, id]
  );
  persistDb();
}

// ── Creator payment ledger (flat fee, livestream commission, UGC affiliate commission) ──
const PAYMENT_COLUMNS = `id, advertiser_id AS advertiserId, campaign_id AS campaignId, creator_id AS creatorId,
  calendar_entry_id AS calendarEntryId, pay_type AS payType, basis_amount AS basisAmount, rate_pct AS ratePct,
  amount, status, scheduled_date AS scheduledDate, paid_at AS paidAt, notes,
  created_at AS createdAt, updated_at AS updatedAt`;

function mapPayment(r) {
  if (!r) return null;
  return {
    id: r.id,
    advertiserId: r.advertiserId || null,
    campaignId: r.campaignId || null,
    creatorId: r.creatorId || null,
    calendarEntryId: r.calendarEntryId || null,
    payType: r.payType,
    basisAmount: Number(r.basisAmount || 0),
    ratePct: r.ratePct ?? null,
    amount: Number(r.amount || 0),
    status: r.status || 'pending',
    scheduledDate: r.scheduledDate || null,
    paidAt: r.paidAt || null,
    notes: r.notes || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function getPayment(id) {
  return mapPayment(get(`SELECT ${PAYMENT_COLUMNS} FROM creator_payments WHERE id = ?`, [id]));
}

async function savePayment(payload) {
  const {
    id, advertiserId, campaignId, creatorId, calendarEntryId, payType,
    basisAmount = 0, ratePct = null, amount = 0, status = 'pending',
    scheduledDate = null, notes = '',
  } = payload;
  if (!payType) throw new Error('payType is required');
  if (id) {
    run(
      `UPDATE creator_payments
       SET campaign_id = ?, creator_id = ?, calendar_entry_id = ?, pay_type = ?, basis_amount = ?,
           rate_pct = ?, amount = ?, status = ?, scheduled_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [campaignId || null, creatorId || null, calendarEntryId || null, payType, basisAmount, ratePct, amount, status, scheduledDate, notes, id]
    );
    persistDb();
    return Number(id);
  }
  const created = run(
    `INSERT INTO creator_payments
      (advertiser_id, campaign_id, creator_id, calendar_entry_id, pay_type, basis_amount, rate_pct, amount, status, scheduled_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [advertiserId || null, campaignId || null, creatorId || null, calendarEntryId || null, payType, basisAmount, ratePct, amount, status, scheduledDate, notes]
  );
  persistDb();
  return created.lastID;
}

async function listPayments({ campaignId = null, creatorId = null, advertiserId = null } = {}) {
  const clauses = [];
  const params = [];
  if (campaignId) { clauses.push('campaign_id = ?'); params.push(campaignId); }
  if (creatorId) { clauses.push('creator_id = ?'); params.push(creatorId); }
  if (advertiserId) { clauses.push('advertiser_id = ?'); params.push(advertiserId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT ${PAYMENT_COLUMNS} FROM creator_payments ${where} ORDER BY id DESC`, params).map(mapPayment);
}

async function updatePaymentStatus(id, { status, paidAt = null }) {
  run(
    `UPDATE creator_payments SET status = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, status === 'paid' ? (paidAt || new Date().toISOString()) : paidAt, id]
  );
  persistDb();
}

async function deletePayment(id) {
  const res = run('DELETE FROM creator_payments WHERE id = ?', [id]);
  persistDb();
  return res.changes > 0;
}

// ── Activity-type KPI (UGC / livestream / paid_boost split) ────────────────
async function saveActivityKpi({ campaignId, activityType, spend = 0, revenue = 0, gmv = 0, views = 0, clicks = 0, orders = 0, notes = '' }) {
  const row = run(
    `INSERT INTO campaign_activity_kpi
      (campaign_id, activity_type, spend, revenue, gmv, views_count, clicks_count, orders_count, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [campaignId, activityType, spend, revenue, gmv, views, clicks, orders, notes]
  );
  persistDb();
  return row.lastID;
}

async function listActivityKpi(campaignId) {
  return all(
    `SELECT id, campaign_id AS campaignId, activity_type AS activityType, spend, revenue, gmv,
            views_count AS views, clicks_count AS clicks, orders_count AS orders, notes,
            created_at AS createdAt
     FROM campaign_activity_kpi WHERE campaign_id = ? ORDER BY id DESC`,
    [campaignId]
  );
}

function summarizeActivityKpi(rows) {
  const byType = {};
  rows.forEach((r) => {
    const t = r.activityType;
    if (!byType[t]) byType[t] = { activityType: t, spend: 0, revenue: 0, gmv: 0, views: 0, clicks: 0, orders: 0 };
    byType[t].spend += Number(r.spend || 0);
    byType[t].revenue += Number(r.revenue || 0);
    byType[t].gmv += Number(r.gmv || 0);
    byType[t].views += Number(r.views || 0);
    byType[t].clicks += Number(r.clicks || 0);
    byType[t].orders += Number(r.orders || 0);
  });
  return Object.values(byType).map((t) => ({
    ...t,
    roas: t.spend > 0 ? Number(((t.revenue + t.gmv) / t.spend).toFixed(4)) : null,
  }));
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
  bulkImportCreatorSources,
  searchCreatorSources,
  saveCalendarEntry,
  getCalendarEntry,
  listCalendarEntries,
  deleteCalendarEntry,
  saveDeliverable,
  getDeliverable,
  listDeliverables,
  updateDeliverableStatus,
  savePayment,
  getPayment,
  listPayments,
  updatePaymentStatus,
  deletePayment,
  saveActivityKpi,
  listActivityKpi,
  summarizeActivityKpi,
};
