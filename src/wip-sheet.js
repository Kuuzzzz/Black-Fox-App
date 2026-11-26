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
      COALESCE(NULLIF(users.name, ''), 'Team member'), ?, ?, ?, ?,
      CASE WHEN ? THEN json_object('id', ?, 'client', json_extract(project.data, '$.client'),
        'brand', json_extract(project.data, '$.brand'), 'name', json_extract(project.data, '$.name'),
        'previous', ?, 'next', ?) END), ?
    FROM docs AS project LEFT JOIN users ON users.email = ?
    WHERE project.path = ? AND project.deleted = 0`)
    .bind(id, date, data.projectId, cellText(data.done), cellText(data.next), cellText(data.link),
      id, data.weeks === true ? 1 : 0, data.projectId, weekCell(data.prevDone, data.prevNext),
      weekCell(data.done, data.next), ts, email, 'projects/' + data.projectId);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function serviceToken(config) {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  let account, key;
  try {
    account = JSON.parse(config);
    if (typeof account?.client_email !== 'string' || !account.client_email.endsWith('.iam.gserviceaccount.com') ||
        typeof account.private_key !== 'string') throw new Error();
    const der = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign']);
  } catch {
    throw new Error('WIP Sheets credential must be a valid Google service account JSON key.');
  }
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


function weekCell(done, next) {
  done = typeof done === 'string' ? done.trim() : '';
  next = typeof next === 'string' ? next.trim() : '';
  if (!done && !next) return '';
  return cellText('What Has Been Done:\n' + done + '\n\nNext Action Steps:\n' + next);
}

const normalize = value => String(value ?? '').normalize('NFKC')
  .replace(/[\u2018\u2019]/g, "'").trim().replace(/\s+/g, ' ').toLowerCase();

function findProjectRow(rows, project) {
  const client = normalize(project.client);
  const brand = normalize(project.brand || project.client);
  const name = normalize(project.name);
  if (!client || !name) return null;
  let result = null;
  for (const [index, row] of rows.entries()) {
    if (normalize(row[0]) !== client || normalize(row[1] || row[0]) !== brand || normalize(row[2]) !== name) continue;
    if (result) return null; // Ambiguous matches stay in the update log.
    result = { number: index + 1, previous: row[12] || '', next: row[13] || '' };
  }
  return result;
}

const sheetRange = cells => "'" + TAB + "'!" + cells;
const encodedRange = cells => encodeURIComponent(sheetRange(cells));
const sheetUrl = env => 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(env.WIP_SHEET_ID);

async function projectRows(env, token) {
  const res = await sheetsRequest(sheetUrl(env) + '/values/' + encodedRange('A:N'), token);
  const { values = [] } = await res.json();
  return values;
}

export async function readWipProjectWeeks(env, projectId) {
  const record = await env.DB.prepare('SELECT data FROM docs WHERE path = ? AND deleted = 0')
    .bind('projects/' + projectId).first();
  if (!record) return { status: 'missing' };
  const token = await serviceToken(env.WIP_SHEETS_SERVICE_ACCOUNT);
  const row = findProjectRow(await projectRows(env, token), JSON.parse(record.data));
  if (!row) return { status: 'missing' };

  await ensureWipOutbox(env.DB);
  const pending = await env.DB.prepare(`SELECT cells FROM wip_sheet_outbox
    WHERE json_extract(cells, '$[7].id') = ? ORDER BY queued_at DESC, update_id DESC LIMIT 1`)
    .bind(projectId).first();
  if (pending) {
    const update = JSON.parse(pending.cells)[7];
    return { status: 'pending', ...row, previous: update.previous, next: update.next };
  }
  return { status: 'loaded', ...row };
}


function weekTextRuns(text) {
  const runs = [];
  let startIndex = 0;
  let bold;
  for (const line of text.split('\n')) {
    const label = /^(?:what has been done|next (?:step action|action steps?))\s*:\s*$/i.test(line.trim());
    if (startIndex < text.length && label !== bold) {
      runs.push({ startIndex, format: { bold: label } });
      bold = label;
    }
    startIndex += line.length + 1;
  }
  return runs;
}

function sheetCells(sheetId, rowIndex, columnIndex, values, richText = false) {
  return {
    updateCells: {
      start: { sheetId, rowIndex, columnIndex },
      rows: values.map(row => ({ values: row.map(text => {
        if (text === '') return {};
        const cell = { userEnteredValue: { stringValue: text } };
        if (richText) cell.textFormatRuns = weekTextRuns(text);
        return cell;
      }) })),
      fields: richText ? 'userEnteredValue,textFormatRuns' : 'userEnteredValue'
    }
  };
}

async function projectWeekWrites(env, token, sheetId, pending) {
  const updates = pending.map(cells => cells[7]).filter(Boolean);
  if (!updates.length) return [];
  const rows = await projectRows(env, token);
  const writes = new Map();
  for (const update of updates) {
    const row = findProjectRow(rows, update);
    if (!row) continue;
    writes.set(row.number, sheetCells(sheetId, row.number - 1, 12, [[update.previous, update.next]], true));
  }
  return [...writes.values()];
}

async function ensureLogCapacity(env, token, lastRow) {
  const url = sheetUrl(env);
  const fields = 'sheets(properties(sheetId,title,gridProperties(rowCount)))';
  const res = await sheetsRequest(url + '?fields=' + encodeURIComponent(fields), token);
  const { sheets = [] } = await res.json();
  const tab = sheets.find(sheet => sheet.properties.title === TAB)?.properties;
  if (!tab) throw new Error('Black Fox Updates tab is missing.');
  const extra = lastRow - tab.gridProperties.rowCount;
  if (extra > 0) {
    await sheetsRequest(url + ':batchUpdate', token, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: Math.max(100, extra) } }] })
    });
  }
  return tab.sheetId;
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
      SELECT update_id FROM wip_sheet_outbox WHERE lease_until <= ?
        AND NOT EXISTS (SELECT 1 FROM wip_sheet_outbox WHERE lease_until > ?)
      ORDER BY queued_at, update_id LIMIT 30
    ) RETURNING update_id, cells, queued_at`).bind(now + 180000, now, now).all();
  if (!rows.length) return;
  rows.sort((a, b) => a.queued_at - b.queued_at || a.update_id.localeCompare(b.update_id));

  const token = await serviceToken(env.WIP_SHEETS_SERVICE_ACCOUNT);
  const base = sheetUrl(env) + '/values/';

  // Use an explicit row below the last occupied log cell. Google append's table detection
  // can mistake the wide copied WIP layout for part of this separate log.
  const res = await sheetsRequest(base + encodedRange('X6:AD'), token);
  const { values: log = [] } = await res.json();
  const existing = new Set(log.slice(1).map(cells => cells[6]).filter(Boolean));
  const pending = rows.filter(row => !existing.has(row.update_id)).map(row => JSON.parse(row.cells));
  if (pending.length) {
    const firstRow = Math.max(7, 6 + log.length);
    const lastRow = firstRow + pending.length - 1;
    const sheetId = await ensureLogCapacity(env, token, lastRow);
    const requests = await projectWeekWrites(env, token, sheetId, pending);
    requests.push(sheetCells(sheetId, firstRow - 1, 23, pending.map(cells => cells.slice(0, 7))));
    await sheetsRequest(sheetUrl(env) + ':batchUpdate', token, {
      method: 'POST',
      body: JSON.stringify({ requests })
    });
  }
  await db.prepare('DELETE FROM wip_sheet_outbox WHERE update_id IN (' + rows.map(() => '?').join(',') + ')')
    .bind(...rows.map(row => row.update_id)).run();
}
