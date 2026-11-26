/* Black Fox Center: Cloudflare Worker
 * - Serves the app (public/) as static assets.
 * - /api/* : who-am-I, the shared database (D1), the Google connection, and Claude for AM Brief.
 * Login is done by Cloudflare Access in front of the whole site; this Worker verifies Access's signed token
 * on every API call, so nobody reaches the data without passing Access.
 */

import { ensureWipOutbox, prepareWipSheetUpdate, readWipProjectWeeks, syncWipSheet, wipSheetEnabled } from './wip-sheet.js';

const GOOGLE_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
].join(' ');

const MAX_DOC_BYTES = 900 * 1024;
const PATH_RE = /^[A-Za-z0-9_.-]{1,120}(\/[A-Za-z0-9_.-]{1,120}){0,7}$/;

export default {
  async scheduled(_controller, env) {
    await syncWipSheet(env);
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (url.pathname.startsWith('/api/auth/') && req.method === 'POST') return await auth(req, env, url);
      const user = await currentUser(req, env, url);
      if (!user) return json({ code: 'session_expired', message: 'Not signed in.' }, 401);
      const p = url.pathname;
      if (p === '/api/me' && req.method === 'GET') return await me(env, user);
      if (p === '/api/users' && req.method === 'GET') return await users(env, url);
      if (p === '/api/db/changes' && req.method === 'GET') return await dbChanges(env, user, url);
      if (p === '/api/db/write' && req.method === 'POST') return await dbWrite(env, user, await readJson(req), ctx);
      if (p === '/api/wip/project-weeks' && req.method === 'GET') {
        const id = url.searchParams.get('projectId') || '';
        if (!PATH_RE.test(id) || id.includes('/')) throw new HttpError(400, 'invalid_argument', 'Bad project ID.');
        if (!wipSheetEnabled(env)) return json({ status: 'unavailable' });
        return json(await readWipProjectWeeks(env, id));
      }
      if (p === '/api/google/start' && req.method === 'GET') return await googleStart(env, user, url);
      if (p === '/api/google/callback' && req.method === 'GET') return await googleCallback(env, user, url);
      if (p === '/api/google/token' && req.method === 'POST') return await googleToken(env, user);
      if (p === '/api/google/disconnect' && req.method === 'POST') return await googleDisconnect(env, user);
      if (p === '/api/sample' && req.method === 'POST') return await sample(env, user, await readJson(req));
      return json({ code: 'not_found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ code: e.code, message: e.message }, e.status);
      console.error(e && e.stack || e);
      return json({ code: 'internal', message: 'Something went wrong on the server.' }, 500);
    }
  }
};

class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
function json(o, status = 200, headers = {}) { return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } }); }
async function readJson(req) {
  const t = await req.text();
  if (t.length > 25 * 1024 * 1024) throw new HttpError(413, 'quota_exceeded', 'Too large.');
  try { return JSON.parse(t || '{}'); } catch (e) { throw new HttpError(400, 'invalid_argument', 'Bad JSON.'); }
}
const low = (s) => String(s || '').trim().toLowerCase();

/* ------------------------------------------------------------------ who is calling */
let certCache = { at: 0, keys: null };
async function accessKeys(env) {
  if (certCache.keys && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new HttpError(503, 'server_unavailable', 'Could not reach Cloudflare Access.');
  const { keys } = await r.json();
  const out = {};
  for (const k of keys) out[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  certCache = { at: Date.now(), keys: out };
  return out;
}
function b64urlBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function b64urlJson(s) { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }
function cookie(req, name) { const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : ''; }

async function currentUser(req, env, url) {
  let email = '';
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (env.DEV_USER && local) email = low(req.headers.get('x-dev-user') || env.DEV_USER);
  else if (env.AUTH_MODE === 'accounts') email = await sessionEmail(req, env);
  else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(500, 'not_configured', 'Cloudflare Access is not set up for this app yet (ACCESS_TEAM_DOMAIN / ACCESS_AUD).');
    const token = req.headers.get('cf-access-jwt-assertion') || cookie(req, 'CF_Authorization');
    if (!token) return null;
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const head = b64urlJson(h), claims = b64urlJson(p);
    const keys = await accessKeys(env);
    let key = keys[head.kid];
    if (!key) { certCache.at = 0; key = (await accessKeys(env))[head.kid]; }
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(h + '.' + p));
    if (!ok) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    if (claims.iss && claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    email = low(claims.email);
  }
  if (!email) return null;
  const domain = low(env.ALLOWED_DOMAIN);
  if (domain && !email.endsWith('@' + domain)) throw new HttpError(403, 'forbidden', 'This app is only for @' + domain + ' accounts.');
  const owner = String(env.OWNER_EMAIL || '').split(',').map(low).filter(Boolean).includes(email); /* one or more owners, comma-separated */
  const admins = String(env.ADMIN_EMAILS || '').split(',').map(low).filter(Boolean);
  return { email, owner, admin: owner || admins.includes(email) };
}

async function me(env, user) {
  const row = await env.DB.prepare('SELECT name FROM users WHERE email = ?').bind(user.email).first();
  await env.DB.prepare('INSERT INTO users (email, name, seen_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET seen_at = excluded.seen_at')
    .bind(user.email, row ? row.name : '', Date.now()).run();
  const g = await env.DB.prepare('SELECT email FROM google_tokens WHERE email = ?').bind(user.email).first();
  return json({
    id: user.email, email: user.email, name: (row && row.name) || '', isOwner: user.owner, canEdit: user.admin,
    google: !!g, googleReady: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    ai: !!env.ANTHROPIC_API_KEY && user.admin, domain: low(env.ALLOWED_DOMAIN)
  });
}
async function users(env, url) {
  const ids = String(url.searchParams.get('ids') || '').split(',').map(low).filter(Boolean).slice(0, 50);
  const out = {};
  if (ids.length) {
    const r = await env.DB.prepare(`SELECT email, name FROM users WHERE email IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    for (const u of r.results || []) out[u.email] = { name: u.name || '' };
  }
  return json(out);
}

/* ------------------------------------------------------------------ database (same rules the claude.ai app had) */
function canRead(path, u) {
  const top = path.split('/')[0];
  if (top === 'owner') return u.owner;
  if (top === 'budgets') return u.admin;
  return true;
}
function canWrite(path, u) {
  const top = path.split('/')[0];
  if (top === 'owner' || top === 'settings') return u.owner;
  if (top === 'budgets' || top === 'training') return u.admin;
  return true;
}
function readFilter(u) {
  const parts = [];
  if (!u.owner) parts.push("path NOT LIKE 'owner/%'");
  if (!u.admin) parts.push("path NOT LIKE 'budgets/%'");
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}
async function dbChanges(env, user, url) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const limit = 500;
  const r = await env.DB.prepare(`SELECT path, coll, id, data, updated_at, deleted FROM docs WHERE updated_at > ?${readFilter(user)} ORDER BY updated_at LIMIT ${limit}`).bind(since).all();
  const rows = (r.results || []).map((x) => ({ path: x.path, coll: x.coll, id: x.id, ts: x.updated_at, deleted: !!x.deleted, data: x.deleted ? null : JSON.parse(x.data) }));
  return json({ now: Date.now(), rows, more: rows.length === limit });
}
let lastTs = 0;
function stamp() { const t = Math.max(Date.now(), lastTs + 1); lastTs = t; return t; }
async function dbWrite(env, user, b, ctx) {
  const op = b.op;
  let path = String(b.path || '');
  if (op === 'add') path = path + '/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  if (!PATH_RE.test(path) || !path.includes('/')) throw new HttpError(400, 'invalid_argument', 'Bad path.');
  if (!canWrite(path, user) || !canRead(path, user)) throw new HttpError(403, 'invalid_argument', 'You do not have permission to change this.');
  const i = path.lastIndexOf('/'), coll = path.slice(0, i), id = path.slice(i + 1);
  const ts = stamp();
  if (op === 'delete') {
    await env.DB.prepare('UPDATE docs SET data = NULL, deleted = 1, updated_at = ? WHERE path = ?').bind(ts, path).run();
    return json({ path, coll, id, ts, deleted: true, data: null });
  }
  if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw new HttpError(400, 'invalid_argument', 'Bad data.');
  let data = b.data;
  if (op === 'update') {
    const cur = await env.DB.prepare('SELECT data, deleted FROM docs WHERE path = ?').bind(path).first();
    if (!cur || cur.deleted) throw new HttpError(404, 'not_found', 'That item no longer exists.');
    data = Object.assign(JSON.parse(cur.data), b.data);
  } else if (op !== 'set' && op !== 'add') throw new HttpError(400, 'invalid_argument', 'Bad op.');
  const text = JSON.stringify(data);
  if (text.length > MAX_DOC_BYTES) throw new HttpError(413, 'quota_exceeded', 'This item is too big to save.');
  const save = env.DB.prepare('INSERT INTO docs (path, coll, id, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0')
    .bind(path, coll, id, text, ts);
  const wipUpdate = op === 'add' && coll === 'updates' && wipSheetEnabled(env)
    ? prepareWipSheetUpdate(env.DB, id, data, user.email, ts) : null;
  let wipSync;
  if (wipUpdate) {
    await ensureWipOutbox(env.DB);
    const [, queued] = await env.DB.batch([save, wipUpdate]);
    wipSync = queued.meta.changes ? 'queued' : 'not_queued';
    if (wipSync === 'queued') {
      // The saved outbox entry remains available to cron if this attempt fails or times out.
      ctx.waitUntil(syncWipSheet(env).catch(error => console.error('Immediate WIP sync failed:', error.message)));
    }
  } else {
    await save.run();
    if (op === 'add' && coll === 'updates') wipSync = 'not_queued';
  }
  return json({ path, coll, id, ts, deleted: false, data, wipSync });
}

/* ------------------------------------------------------------------ secrets helpers */
/* The key that locks Google connections: the TOKEN_KEY secret if one is set, otherwise a random key
   the server makes once and keeps in the database (which only this Worker can read). */
let autoKey = '';
async function tokenKey(env) {
  if (env.TOKEN_KEY) return env.TOKEN_KEY;
  if (autoKey) return autoKey;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  const fresh = toB64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('token_key', fresh).run();
  const row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind('token_key').first();
  autoKey = row.v;
  return autoKey;
}
async function keyFrom(env, purpose) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(purpose + ':' + await tokenKey(env)));
  return purpose === 'enc' ? crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    : crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(env, 'enc'), new TextEncoder().encode(text)));
  return toB64(iv) + '.' + toB64(ct);
}
async function decrypt(env, s) {
  const [iv, ct] = String(s).split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlBytes(iv) }, await keyFrom(env, 'enc'), b64urlBytes(ct)));
}
async function sign(env, text) { return toB64(new Uint8Array(await crypto.subtle.sign('HMAC', await keyFrom(env, 'mac'), new TextEncoder().encode(text)))); }

/* ------------------------------------------------------------------ Google: each person connects their own account once */
function needGoogle(env) { if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(500, 'not_configured', 'Google is not set up for this app yet.'); }
async function googleStart(env, user, url) {
  needGoogle(env);
  const body = user.email + '|' + Date.now();
  const state = toB64(new TextEncoder().encode(body)) + '.' + await sign(env, body);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/google/callback', response_type: 'code', scope: GOOGLE_SCOPES,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: user.email, state
  });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}
function page(title, text, back = '/#my-day') {
  const h = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#05070A;color:#E6F1F7;font:15px system-ui,sans-serif">
<div style="max-width:440px;padding:24px;text-align:center"><h1 style="font-size:20px">${h(title)}</h1><p style="color:#9AABB8">${h(text)}</p>
<a href="${h(back)}" style="display:inline-block;margin-top:8px;padding:10px 18px;border-radius:999px;background:#4FD8FF;color:#041016;font-weight:700;text-decoration:none">Back to Black Fox Center</a></div>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
async function googleCallback(env, user, url) {
  needGoogle(env);
  if (url.searchParams.get('error')) return page('Google was not connected', 'You closed or declined the Google screen. You can try again any time.');
  const [b, mac] = String(url.searchParams.get('state') || '').split('.');
  let body = '';
  try { body = new TextDecoder().decode(b64urlBytes(b)); } catch (e) { /* bad state */ }
  const [email, at] = body.split('|');
  if (!body || mac !== await sign(env, body) || email !== user.email || Date.now() - Number(at) > 15 * 60e3)
    return page('Please try again', 'That Google sign-in link expired. Press Connect Google again.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/api/google/callback', grant_type: 'authorization_code' })
  });
  const t = await r.json();
  if (!r.ok || !t.refresh_token) return page('Google was not connected', 'Google did not give access. Press Connect Google and tick every box on the Google screen.');
  const id = t.id_token ? b64urlJson(t.id_token.split('.')[1]) : {};
  if (low(id.email) !== user.email)
    return page('Use your own work account', `You signed in to Google as ${id.email || 'another account'}. Connect ${user.email} instead.`);
  const missing = ['gmail.readonly', 'calendar', 'drive', 'auth/spreadsheets'].filter((s) => !String(t.scope || '').includes(s));
  await env.DB.prepare('INSERT INTO google_tokens (email, refresh_enc, scope, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET refresh_enc = excluded.refresh_enc, scope = excluded.scope, updated_at = excluded.updated_at')
    .bind(user.email, await encrypt(env, t.refresh_token), t.scope || '', Date.now()).run();
  if (id.name) await env.DB.prepare('INSERT INTO users (email, name, seen_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name').bind(user.email, id.name, Date.now()).run();
  if (missing.length) return page('Almost there', 'Google is connected, but some boxes were not ticked, so parts of the app will not work. Press Connect Google again and tick every box.');
  return new Response(null, { status: 302, headers: { location: '/?google=connected#my-day' } });
}
async function googleToken(env, user) {
  needGoogle(env);
  const row = await env.DB.prepare('SELECT refresh_enc FROM google_tokens WHERE email = ?').bind(user.email).first();
  if (!row) throw new HttpError(404, 'server_not_connected', 'Google is not connected yet.');
  let refresh;
  try { refresh = await decrypt(env, row.refresh_enc); } catch (e) {
    /* TOKEN_KEY changed or the row is damaged: ask the person to connect again */
    await env.DB.prepare('DELETE FROM google_tokens WHERE email = ?').bind(user.email).run();
    throw new HttpError(401, 'needs_reauth', 'Please connect Google again.');
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' })
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (t.error === 'invalid_grant') { await env.DB.prepare('DELETE FROM google_tokens WHERE email = ?').bind(user.email).run(); throw new HttpError(401, 'needs_reauth', 'Google sign-in expired.'); }
    throw new HttpError(503, 'server_unavailable', 'Google did not answer.');
  }
  return json({ access_token: t.access_token, expires_in: t.expires_in, scope: t.scope });
}
async function googleDisconnect(env, user) {
  const row = await env.DB.prepare('SELECT refresh_enc FROM google_tokens WHERE email = ?').bind(user.email).first();
  if (row) {
    try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(await decrypt(env, row.refresh_enc)), { method: 'POST' }); } catch (e) { /* best effort */ }
    await env.DB.prepare('DELETE FROM google_tokens WHERE email = ?').bind(user.email).run();
  }
  return json({ ok: true });
}

/* ------------------------------------------------------------------ Claude for AM Brief (Heng and admins only, to keep the bill in check) */
async function sample(env, user, b) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'sampling_disabled', 'Claude is not set up yet.');
  if (!user.admin) throw new HttpError(403, 'not_granted', 'Claude writing is only on for Heng and admins.');
  const prompt = String(b.prompt || '');
  if (!prompt) throw new HttpError(400, 'invalid_argument', 'Empty prompt.');
  const model = (b.modelTier === 'fast' && env.CLAUDE_FAST_MODEL) || env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const r = await fetch((env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: Number(env.CLAUDE_MAX_TOKENS) || 16000, stream: true,
      system: 'You return exactly what the user asks for. When asked for JSON, reply with only valid JSON and nothing else.',
      messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) {
    const t = await r.text();
    const code = r.status === 429 || r.status === 529 ? 'rate_limited' : /too long|too many tokens|prompt is too long/i.test(t) ? 'prompt_too_large' : r.status === 401 ? 'sampling_disabled' : 'upstream_error';
    console.error('anthropic', r.status, t.slice(0, 500));
    throw new HttpError(r.status === 401 ? 503 : 502, code, 'Claude could not answer.');
  }
  /* Turn Anthropic's event stream into plain text chunks for the page. */
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '';
  const ts = new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') ctl.enqueue(enc.encode(ev.delta.text));
          else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'refusal') ctl.enqueue(enc.encode('\u0000REFUSED'));
          else if (ev.type === 'error') ctl.enqueue(enc.encode('\u0000ERROR'));
        } catch (e) { /* partial line */ }
      }
    }
  });
  return new Response(r.body.pipeThrough(ts), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ------------------------------------------------------------------ own accounts (AUTH_MODE = "accounts")
   Anyone with the link can create an account with name, email and password. Passwords are stored as
   PBKDF2 hashes; the browser keeps a random session token in an HttpOnly cookie for 30 days. */
const SESSION_DAYS = 30;
let authReady = false;
async function authTables(env) {
  if (authReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS login_fails (email TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL)')
  ]);
  authReady = true;
}
async function sha256(text) { return toB64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))); }
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64urlBytes(salt), iterations: 100000 }, key, 256);
  return toB64(new Uint8Array(bits));
}
function sessionCookie(token, url, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `bfc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function newSession(env, email, url, body) {
  const token = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), email, now + SESSION_DAYS * 864e5).run();
  return json(body || { ok: true }, 200, { 'set-cookie': sessionCookie(token, url, SESSION_DAYS * 86400) });
}
async function sessionEmail(req, env) {
  const token = cookie(req, 'bfc_session');
  if (!token) return '';
  await authTables(env);
  const row = await env.DB.prepare('SELECT email FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await sha256(token), Date.now()).first();
  return row ? row.email : '';
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
async function auth(req, env, url) {
  if (env.AUTH_MODE !== 'accounts') throw new HttpError(404, 'not_found', 'Accounts are not switched on.');
  if (!/application\/json/.test(req.headers.get('content-type') || '')) throw new HttpError(400, 'invalid_argument', 'Bad request.');
  await authTables(env);
  const b = await readJson(req);
  const email = low(b.email), password = String(b.password || '');
  if (url.pathname === '/api/auth/logout') {
    const token = cookie(req, 'bfc_session');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', url, 0) });
  }
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'invalid_argument', 'Type a valid email address.');
  const domain = low(env.ALLOWED_DOMAIN);
  if (domain && !email.endsWith('@' + domain)) throw new HttpError(403, 'forbidden', 'This app is only for @' + domain + ' accounts.');
  if (url.pathname === '/api/auth/signup') {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'invalid_argument', 'Type your name.');
    if (password.length < 8) throw new HttpError(400, 'invalid_argument', 'Use a password of at least 8 characters.');
    const exists = await env.DB.prepare('SELECT email FROM accounts WHERE email = ?').bind(email).first();
    if (exists) throw new HttpError(409, 'account_exists', 'There is already an account for this email. Sign in instead.');
    const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare('INSERT INTO accounts (email, name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)').bind(email, name, await hashPassword(password, salt), salt, Date.now()).run();
    await env.DB.prepare('INSERT INTO users (email, name, seen_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name').bind(email, name, Date.now()).run();
    return newSession(env, email, url);
  }
  if (url.pathname === '/api/auth/login') {
    const now = Date.now();
    const f = await env.DB.prepare('SELECT count, first_at FROM login_fails WHERE email = ?').bind(email).first();
    if (f && now - f.first_at < 15 * 60e3 && f.count >= 8) throw new HttpError(429, 'rate_limited', 'Too many wrong passwords. Wait 15 minutes and try again.');
    const a = await env.DB.prepare('SELECT pass_hash, salt FROM accounts WHERE email = ?').bind(email).first();
    const ok = a && (await hashPassword(password, a.salt)) === a.pass_hash;
    if (!ok) {
      if (!f || now - f.first_at >= 15 * 60e3) await env.DB.prepare('INSERT INTO login_fails (email, count, first_at) VALUES (?, 1, ?) ON CONFLICT(email) DO UPDATE SET count = 1, first_at = excluded.first_at').bind(email, now).run();
      else await env.DB.prepare('UPDATE login_fails SET count = count + 1 WHERE email = ?').bind(email).run();
      throw new HttpError(401, 'wrong_password', a ? 'Wrong password.' : 'No account for this email yet. Create one first.');
    }
    await env.DB.prepare('DELETE FROM login_fails WHERE email = ?').bind(email).run();
    return newSession(env, email, url);
  }
  throw new HttpError(404, 'not_found');
}