// A durable, one-way export of newly posted Team WIP updates.
const TAB = 'Black Fox Updates';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const encoder = new TextEncoder();

export function wipSheetEnabled(env) {
  return Boolean(env.WIP_SHEET_ID && env.WIP_SHEETS_SERVICE_ACCOUNT);
}

// Keep setup independent of the existing D1 schema and safe across Worker instances.
export async function ensureWipOutbox(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS wip_sheet_outbox (
    update_id TEXT PRIMARY KEY,
    cells TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0
  )`).run();
}

function cellText(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length > 49000 ? text.slice(0, 49000).replace(/[\uD800-\uDBFF]$/, '') + '…' : text;
}

export function prepareWipSheetUpdate(db, id, data, email, ts) {
  if (typeof data.projectId !== 'string' || !data.projectId || (!cellText(data.done) && !cellText(data.next))) return null;
  const date = typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.date)
    ? data.date : new Date(ts).toISOString().slice(0, 10);
  return db.prepare(`INSERT INTO wip_sheet_outbox (update_id, cells, queued_at)
    SELECT ?, json_array(?, COALESCE(NULLIF(json_extract(project.data, '$.name'), ''), ?),
      COALESCE(NULLIF(users.name, ''), 'Team member'), ?, ?, ?, ?), ?
    FROM docs AS project LEFT JOIN users ON users.email = ?
    WHERE project.path = ? AND project.deleted = 0`)
    .bind(id, date, data.projectId, cellText(data.done), cellText(data.next), cellText(data.link),
      id, ts, email, 'projects/' + data.projectId);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function serviceToken(config) {
  const account = JSON.parse(config);
  const der = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: account.private_key_id };
  const claims = { iss: account.client_email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 600 };
  const unsigned = [header, claims].map(part => base64Url(encoder.encode(JSON.stringify(part)))).join('.');
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm, key, encoder.encode(unsigned)));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + base64Url(signature)
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('WIP Sheets token request failed (' + res.status + ')');
  const { access_token } = await res.json();
  if (!access_token) throw new Error('WIP Sheets token missing');
  return access_token;
}

async function sheetsRequest(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('WIP Sheets request failed (' + res.status + ')');
  return res;
}

export async function syncWipSheet(env) {
  if (!wipSheetEnabled(env)) return;
  const db = env.DB;
  await ensureWipOutbox(db);
  const now = Date.now();
  // Claim the batch in one statement. A failed run becomes eligible again after its lease.
  const { results: rows } = await db.prepare(`UPDATE wip_sheet_outbox
    SET lease_until = ?, attempts = attempts + 1
    WHERE update_id IN (
      SELECT update_id FROM wip_sheet_outbox WHERE lease_until <= ? ORDER BY queued_at, update_id LIMIT 30
    ) RETURNING update_id, cells, attempts, queued_at`).bind(now + 180000, now).all();
  if (!rows.length) return;
  rows.sort((a, b) => a.queued_at - b.queued_at || a.update_id.localeCompare(b.update_id));

  const token = await serviceToken(env.WIP_SHEETS_SERVICE_ACCOUNT);
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(env.WIP_SHEET_ID) + '/values/';
  const range = cells => encodeURIComponent("'" + TAB + "'!" + cells);

  // An append can succeed even if its response is lost. Read back the IDs before retrying.
  let existing = new Set();
  if (rows.some(row => row.attempts > 1)) {
    const res = await sheetsRequest(base + range('AD7:AD'), token);
    const { values = [] } = await res.json();
    existing = new Set(values.map(([id]) => id));
  }
  const pending = rows.filter(row => !existing.has(row.update_id));
  if (pending.length) {
    await sheetsRequest(base + range('X6:AD') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', token, {
      method: 'POST',
      body: JSON.stringify({ values: pending.map(row => JSON.parse(row.cells)) })
    });
  }
  await db.prepare('DELETE FROM wip_sheet_outbox WHERE update_id IN (' + rows.map(() => '?').join(',') + ')')
    .bind(...rows.map(row => row.update_id)).run();
}
