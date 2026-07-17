const path = require('path');
const fs = require('fs');
const os = require('os');
const initSqlJs = require('sql.js');

const isServerless = Boolean(process.env.NETLIFY) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const dataDir = isServerless
  ? path.join(os.tmpdir(), 'dnuvo-data')
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'pipeline.db');
let db;

function persistDb() {
  const bytes = db.export();
  fs.writeFileSync(dbPath, Buffer.from(bytes));
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

async function initDb() {
  const SQL = await initSqlJs({});
  if (fs.existsSync(dbPath)) {
    const filebuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
  }

  run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      setup_json TEXT,
      creators_text TEXT,
      content_json TEXT,
      budget_json TEXT,
      schedule_json TEXT,
      verifications_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
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
  persistDb();
}

async function saveCampaign(payload) {
  const {
    id,
    name,
    status = 'draft',
    setup,
    creators,
    content,
    budget,
    schedule,
    verifications,
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
  };

  if (id) {
    run(
      `UPDATE campaigns
       SET name = ?, status = ?, setup_json = ?, creators_text = ?, content_json = ?,
           budget_json = ?, schedule_json = ?, verifications_json = ?, updated_at = CURRENT_TIMESTAMP
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
        id,
      ]
    );
    persistDb();
    return Number(id);
  }

  const created = run(
    `INSERT INTO campaigns
      (name, status, setup_json, creators_text, content_json, budget_json, schedule_json, verifications_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.name,
      row.status,
      row.setup_json,
      row.creators_text,
      row.content_json,
      row.budget_json,
      row.schedule_json,
      row.verifications_json,
    ]
  );
  persistDb();
  return created.lastID;
}

async function listCampaigns() {
  return all(
    `SELECT id, name, status, created_at AS createdAt, updated_at AS updatedAt
     FROM campaigns
     ORDER BY updated_at DESC`
  );
}

async function getCampaign(id) {
  const c = await get(
    `SELECT id, name, status, setup_json, creators_text, content_json, budget_json, schedule_json, verifications_json,
            created_at AS createdAt, updated_at AS updatedAt
     FROM campaigns
     WHERE id = ?`,
    [id]
  );
  if (!c) return null;
  return {
    id: c.id,
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
    },
  };
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

module.exports = {
  initDb,
  saveCampaign,
  listCampaigns,
  getCampaign,
  logCampaignAudit,
  listCampaignAudit,
  saveKpiEntry,
  listKpiEntries,
  getLatestKpiEntry,
};
