/* Black Fox Center bridge.
 * The app was first built for claude.ai, where window.claude gave it a database, Google connectors and Claude.
 * This file provides the same window.claude.use('db' | 'user' | 'mcp' | 'sample') on top of our own Cloudflare server,
 * so the app page itself barely changes.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- server calls */
  function err(code, message, extra) { var e = { code: code, message: message || code }; if (extra) Object.assign(e, extra); return e; }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    if (opts.signal) init.signal = opts.signal;
    return fetch('/api' + path, init).then(function (r) {
      if (opts.raw && r.ok) return r;
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : {}; } catch (e) { /* not JSON: probably the Access login page */ }
        if (r.ok && j) return j;
        if (!j || (r.status === 401 && (!j.code || j.code === 'session_expired'))) throw err('session_expired', 'Your sign-in expired. Reload the page.');
        throw err(j.code || 'upstream_error', j.message, { status: r.status, retryable: r.status >= 500 || r.status === 429 });
      });
    }, function (e) {
      if (e && e.name === 'AbortError') throw err('cancelled');
      throw err('server_unavailable', 'No connection.', { retryable: true });
    });
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  var meP = null;
  function getMe() { return meP || (meP = api('/me')); }

  /* ---------------------------------------------------------------- db: documents + live updates (polling) */
  var store = {};            /* path -> { coll, id, data, ts, deleted } */
  var docL = {}, collL = {}; /* path/coll -> [fn] */
  var since = 0, loaded = false, polling = false, pollT = 0, readyCbs = [];

  function snapDoc(path) {
    var r = store[path], ok = !!(r && !r.deleted);
    return { id: path.split('/').pop(), exists: ok, data: function () { return ok ? clone(r.data) : undefined; } };
  }
  function snapColl(coll) {
    var docs = Object.keys(store).filter(function (p) { var r = store[p]; return r.coll === coll && !r.deleted; })
      .map(function (p) { var r = store[p]; return { id: r.id, exists: true, data: function () { return clone(r.data); } }; });
    return { docs: docs, size: docs.length, empty: !docs.length };
  }
  function fire(list, arg) { (list || []).slice().forEach(function (f) { try { f(arg); } catch (e) { console.error(e); } }); }
  function apply(rows) {
    var paths = {}, colls = {};
    rows.forEach(function (x) {
      var cur = store[x.path];
      if (cur && cur.ts >= x.ts) return;
      store[x.path] = { coll: x.coll, id: x.id, data: x.data, ts: x.ts, deleted: x.deleted };
      if (x.ts > since) since = x.ts;
      paths[x.path] = 1; colls[x.coll] = 1;
    });
    if (!loaded) return;
    Object.keys(paths).forEach(function (p) { fire(docL[p], snapDoc(p)); });
    Object.keys(colls).forEach(function (c) { fire(collL[c], snapColl(c)); });
  }
  function poll() {
    clearTimeout(pollT);
    /* look back 5 s each time, so two saves in the same moment are never missed */
    return api('/db/changes?since=' + Math.max(0, since - 5000)).then(function (r) {
      apply(r.rows || []);
      if (r.more) return poll();
      if (!loaded) { loaded = true; readyCbs.splice(0).forEach(function (f) { f(); }); }
    }, function (e) { if (!loaded && e.code === 'session_expired') { readyCbs.splice(0).forEach(function (f) { f(e); }); } })
      .then(function () { pollT = setTimeout(poll, document.hidden ? 30000 : 4000); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && polling) poll(); });
  function whenLoaded(f) { if (loaded) f(); else readyCbs.push(f); }

  function write(op, path, data) {
    return api('/db/write', { method: 'POST', body: { op: op, path: path, data: data } }).then(function (row) {
      var wasLoaded = loaded; apply([row]); if (!wasLoaded) { /* first load still running */ }
      return row;
    });
  }
  function on(map, key, cb, snap, onErr) {
    (map[key] = map[key] || []).push(cb);
    whenLoaded(function (e) { if (e) { if (onErr) onErr(e); return; } if ((map[key] || []).indexOf(cb) >= 0) { try { cb(snap(key)); } catch (x) { console.error(x); } } });
    return function () { var l = map[key] || []; var i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); };
  }
  var db = {
    doc: function (path) {
      return {
        id: path.split('/').pop(),
        set: function (d) { return write('set', path, d).then(function () {}); },
        update: function (d) { return write('update', path, d).then(function () {}); },
        delete: function () { return write('delete', path).then(function () {}); },
        get: function () { return new Promise(function (res) { whenLoaded(function () { res(snapDoc(path)); }); }); },
        onSnapshot: function (cb, onErr) { return on(docL, path, cb, snapDoc, onErr); }
      };
    },
    collection: function (coll) {
      return {
        add: function (d) { return write('add', coll, d).then(function (row) { return { id: row.id }; }); },
        doc: function (id) { return db.doc(coll + '/' + id); },
        get: function () { return new Promise(function (res) { whenLoaded(function () { res(snapColl(coll)); }); }); },
        onSnapshot: function (cb, onErr) { return on(collL, coll, cb, snapColl, onErr); }
      };
    }
  };

  /* ---------------------------------------------------------------- user */
  var nameCache = {};
  var user = {
    me: function () { return getMe().then(function (m) { var nm = m.name || (function (l) { return l ? l.charAt(0).toUpperCase() + l.slice(1) : ''; })(String(m.email || '').split('@')[0].split(/[._-]/)[0]);
      return { id: m.id, name: nm, email: m.email, isOwner: !!m.isOwner, canEdit: !!m.canEdit, googleReady: !!m.googleReady, ai: !!m.ai }; }); },
    profiles: function (ids) {
      var want = (ids || []).filter(function (i) { return i && !(i in nameCache); });
      var p = want.length ? api('/users?ids=' + encodeURIComponent(want.join(','))).then(function (r) { want.forEach(function (i) { nameCache[i] = (r[i] && r[i].name) || ''; }); }) : Promise.resolve();
      return p.then(function () {
        var out = {};
        var legacy = (store['settings/legacyNames'] && store['settings/legacyNames'].data && store['settings/legacyNames'].data.names) || {}; /* names behind old claude.ai user ids */
        (ids || []).forEach(function (i) { var n = nameCache[i] || legacy[i]; if (!n && /@/.test(i)) { var l = i.split('@')[0].split(/[._-]/)[0]; n = l.charAt(0).toUpperCase() + l.slice(1); } out[i] = { name: n || '' }; });
        return out;
      });
    }
  };

  /* ---------------------------------------------------------------- Google (Gmail, Calendar, Drive, Sheets) */
  var tok = { value: '', exp: 0, p: null };
  function token(force) {
    if (!force && tok.value && Date.now() < tok.exp) return Promise.resolve(tok.value);
    if (tok.p) return tok.p;
    tok.p = api('/google/token', { method: 'POST' }).then(function (t) {
      tok.value = t.access_token; tok.exp = Date.now() + (Number(t.expires_in) || 3000) * 1000 - 120000; tok.p = null; return tok.value;
    }, function (e) { tok.p = null; if (e.code === 'needs_reauth' || e.code === 'server_not_connected') showConnect(e.code); throw e; });
    return tok.p;
  }
  function g(url, opts, retried) {
    opts = opts || {};
    return token().then(function (t) {
      var h = Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {});
      if (opts.json !== undefined) { h['content-type'] = 'application/json'; }
      return fetch(url, { method: opts.method || 'GET', headers: h, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
    }).then(function (r) {
      if (r.status === 401 && !retried) { tok.value = ''; return g(url, opts, true); }
      if (opts.text && r.ok) return r.text();
      if (r.status === 204) return {};
      return r.text().then(function (t) {
        var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { /* not JSON */ }
        if (r.ok) return j;
        var msg = (j.error && (j.error.message || j.error)) || ('Google error ' + r.status);
        var reason = String((j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || (j.error && j.error.status) || '');
        if (r.status === 401) { showConnect('needs_reauth'); throw err('needs_reauth', msg); }
        if (r.status === 403 && /insufficient|scope/i.test(msg + reason)) { showConnect('needs_reauth'); throw err('needs_reauth', msg); }
        if (r.status === 429 || r.status >= 500 || /rateLimit/i.test(reason)) throw err('server_unavailable', msg, { retryable: true, retryAfterMs: 2000 });
        throw err('tool_error', msg);
      });
    }, function (e) { if (e && e.code) throw e; throw err('server_unavailable', 'No connection.', { retryable: true }); });
  }
  function pool(items, n, fn) {
    var out = new Array(items.length), i = 0;
    function next() { var k = i++; if (k >= items.length) return Promise.resolve(); return fn(items[k], k).then(function (v) { out[k] = v; }, function () { out[k] = null; }).then(next); }
    var w = []; for (var j = 0; j < Math.min(n, items.length); j++) w.push(next());
    return Promise.all(w).then(function () { return out.filter(Boolean); });
  }
  var enc = encodeURIComponent;
  function isoOf(s) { s = String(s || ''); if (!s) return s; if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s).toISOString(); return new Date(s).toISOString(); }
  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'UTC'; } }
  function emails(v) { return String(v || '').match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []; }
  function unent(s) { var t = document.createElement('textarea'); t.innerHTML = String(s || ''); return t.value; }
  function b64ToBytes(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

  var GOOGLE_TYPES = {
    folder: 'application/vnd.google-apps.folder', doc: 'application/vnd.google-apps.document',
    sheet: 'application/vnd.google-apps.spreadsheet', slides: 'application/vnd.google-apps.presentation'
  };
  var CONVERT = {
    'text/html': GOOGLE_TYPES.doc, 'text/plain': GOOGLE_TYPES.doc, 'text/csv': GOOGLE_TYPES.sheet,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': GOOGLE_TYPES.doc, 'application/msword': GOOGLE_TYPES.doc,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': GOOGLE_TYPES.slides, 'application/vnd.ms-powerpoint': GOOGLE_TYPES.slides,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': GOOGLE_TYPES.sheet, 'application/vnd.ms-excel': GOOGLE_TYPES.sheet
  };
  var GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/', CAL = 'https://www.googleapis.com/calendar/v3/',
    DRIVE = 'https://www.googleapis.com/drive/v3/', UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files',
    SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink';
  var ALL = 'supportsAllDrives=true';
  function fileOut(f) { return { id: f.id, title: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, viewUrl: f.webViewLink || '' }; }

  /* Drive search queries were written for the claude.ai connector: "title contains" and "'X' in ancestors". */
  function outsideQuotes(q, fn) { return String(q).split(/('(?:[^'\\]|\\.)*')/).map(function (part, i) { return i % 2 ? part : fn(part); }).join(''); }
  function subfolders(root) {
    var all = [root], frontier = [root], depth = 0;
    function step() {
      if (!frontier.length || depth >= 4 || all.length >= 120) return Promise.resolve(all);
      depth++;
      var chunks = []; for (var i = 0; i < frontier.length; i += 20) chunks.push(frontier.slice(i, i + 20));
      frontier = [];
      return Promise.all(chunks.map(function (c) {
        var q = '(' + c.map(function (id) { return "'" + id + "' in parents"; }).join(' or ') + ") and mimeType = '" + GOOGLE_TYPES.folder + "' and trashed = false";
        return g(DRIVE + 'files?' + ALL + '&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=200&fields=files(id)&q=' + enc(q)).then(function (r) {
          (r.files || []).forEach(function (f) { if (all.indexOf(f.id) < 0) { all.push(f.id); frontier.push(f.id); } });
        });
      })).then(step);
    }
    return step();
  }
  function driveQuery(q) {
    q = outsideQuotes(q, function (s) { return s.replace(/\btitle\b/g, 'name'); });
    var m = q.match(/'([^']+)'\s+in\s+ancestors/);
    if (!m) return Promise.resolve(q);
    return subfolders(m[1]).then(function (ids) { return q.replace(m[0], '(' + ids.map(function (id) { return "'" + id + "' in parents"; }).join(' or ') + ')'); });
  }
  function readText(fileId) {
    return g(DRIVE + 'files/' + enc(fileId) + '?' + ALL + '&fields=id,name,mimeType').then(function (f) {
      var t = f.mimeType;
      var exportAs = t === GOOGLE_TYPES.doc ? 'text/plain' : t === GOOGLE_TYPES.sheet ? 'text/csv' : t === GOOGLE_TYPES.slides ? 'text/plain' : '';
      if (exportAs) return g(DRIVE + 'files/' + enc(f.id) + '/export?mimeType=' + enc(exportAs), { text: true });
      if (/^text\/|json|csv/.test(t)) return g(DRIVE + 'files/' + enc(f.id) + '?alt=media&' + ALL, { text: true });
      var target = CONVERT[t] || (t === 'application/pdf' || /^image\//.test(t) ? GOOGLE_TYPES.doc : '');
      if (!target) throw err('tool_error', 'This file type cannot be read.');
      /* PDFs, Word, PowerPoint, Excel and images: make a temporary Google copy, read it, then delete the copy */
      return g(DRIVE + 'files/' + enc(f.id) + '/copy?' + ALL + '&fields=id', { method: 'POST', json: { name: 'tmp - Black Fox Center reading - ' + f.name, mimeType: target } }).then(function (c) {
        var ex = target === GOOGLE_TYPES.sheet ? 'text/csv' : 'text/plain';
        return g(DRIVE + 'files/' + enc(c.id) + '/export?mimeType=' + enc(ex), { text: true }).then(function (txt) {
          return g(DRIVE + 'files/' + enc(c.id) + '?' + ALL, { method: 'DELETE' }).then(function () { return txt; }, function () { return txt; });
        });
      });
    });
  }
  function createFile(i) {
    var meta = { name: i.title || 'Untitled' };
    if (i.parentId) meta.parents = [i.parentId];
    var ret = '&fields=' + FILE_FIELDS;
    if (i.contentMimeType === GOOGLE_TYPES.folder || (!i.textContent && !i.base64Content)) {
      meta.mimeType = i.contentMimeType || GOOGLE_TYPES.folder;
      return g(DRIVE + 'files?' + ALL + ret, { method: 'POST', json: meta }).then(fileOut);
    }
    var type = i.contentMimeType || 'application/octet-stream';
    if (!i.disableConversionToGoogleType && CONVERT[type]) meta.mimeType = CONVERT[type];
    var body = i.base64Content ? b64ToBytes(i.base64Content) : new Blob([String(i.textContent)], { type: type + (/^text\//.test(type) ? ';charset=utf-8' : '') });
    var B = 'bfc' + Math.random().toString(36).slice(2);
    var blob = new Blob(['--' + B + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + B + '\r\nContent-Type: ' + type + '\r\n\r\n', body, '\r\n--' + B + '--'], { type: 'multipart/related; boundary=' + B });
    return g(UPLOAD + '?uploadType=multipart&' + ALL + ret, { method: 'POST', body: blob, headers: { 'content-type': 'multipart/related; boundary=' + B } }).then(fileOut);
  }
  function header(m, n) { var h = ((m.payload && m.payload.headers) || []).find(function (x) { return x.name.toLowerCase() === n; }); return h ? h.value : ''; }
  function gmailMsg(m) {
    var from = header(m, 'from');
    return { id: m.id, threadId: m.threadId, subject: header(m, 'subject'), sender: emails(from)[0] || from, senderName: from.replace(/<.*>/, '').replace(/"/g, '').trim(),
      snippet: unent(m.snippet), date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, 'date'), labelIds: m.labelIds || [],
      toRecipients: emails(header(m, 'to')), ccRecipients: emails(header(m, 'cc')) };
  }

  var TOOLS = {
    'Gmail/search_threads': function (i, me) {
      var max = Math.max(1, Math.min(Number(i.pageSize) || 20, 50));
      return g(GMAIL + 'threads?maxResults=' + max + '&q=' + enc(i.query || '')).then(function (r) {
        var ts = r.threads || [];
        if (i.view === 'THREAD_VIEW_IDS_ONLY') return { threads: ts.map(function (t) { return { id: t.id }; }) };
        var hs = ['Subject', 'From', 'To', 'Cc', 'Date'].map(function (h) { return '&metadataHeaders=' + h; }).join('');
        return pool(ts, 8, function (t) {
          return g(GMAIL + 'threads/' + t.id + '?format=metadata' + hs).then(function (d) {
            return { id: d.id, viewUrl: 'https://mail.google.com/mail/?authuser=' + enc(me.email) + '#all/' + d.id, messages: (d.messages || []).map(gmailMsg) };
          });
        }).then(function (threads) { return { threads: threads }; });
      });
    },
    'Google Calendar/list_events': function (i) {
      var q = 'singleEvents=true&orderBy=startTime&maxResults=' + Math.min(Number(i.pageSize) || 100, 250) + '&timeMin=' + enc(isoOf(i.startTime)) + '&timeMax=' + enc(isoOf(i.endTime));
      return g(CAL + 'calendars/' + enc(i.calendarId || 'primary') + '/events?' + q).then(function (r) { return { events: r.items || [] }; });
    },
    'Google Calendar/create_event': function (i) {
      var zone = tz();
      var ev = { summary: i.summary, description: i.description || '', location: i.location || undefined,
        start: { dateTime: isoOf(i.startTime), timeZone: zone }, end: { dateTime: isoOf(i.endTime), timeZone: zone },
        attendees: (i.attendees || []).map(function (a) { return a.resource ? { email: a.email, resource: true } : { email: a.email }; }) };
      if (i.addGoogleMeetUrl) ev.conferenceData = { createRequest: { requestId: 'bfc' + Date.now().toString(36), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      return g(CAL + 'calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', { method: 'POST', json: ev });
    },
    'Google Sheets/get_values': function (i) {
      return g(SHEETS + enc(i.spreadsheetId) + '/values/' + enc(i.range) + '?valueRenderOption=FORMATTED_VALUE').then(function (r) { return { values: r.values || [], range: r.range }; });
    },
    'Google Drive/search_files': function (i) {
      return driveQuery(i.query || 'trashed = false').then(function (q) {
        var u = DRIVE + 'files?' + ALL + '&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=' + Math.min(Number(i.pageSize) || 20, 100) +
          '&fields=' + enc('files(' + FILE_FIELDS + ')') + '&q=' + enc(q) + (i.orderBy ? '&orderBy=' + enc(i.orderBy) : '');
        return g(u).then(function (r) { return { files: (r.files || []).map(fileOut) }; });
      });
    },
    'Google Drive/read_file_content': function (i) { return readText(i.fileId).then(function (t) { return { fileContent: t }; }); },
    'Google Drive/create_file': createFile
  };

  /* Kuro desktop companion (optional, see desktop/README.md): a tiny helper on the PC listening on localhost. */
  var KURO_PORT = 47321;
  function kuro(tool, input) {
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, tool === 'install_sprites' ? 30000 : 2500);
    return fetch('http://127.0.0.1:' + KURO_PORT + '/' + tool, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input || {}), signal: ctl.signal })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw err('tool_error', 'Kuro helper said no.'); return r.json(); },
        function () { clearTimeout(t); throw err('server_not_connected', 'Desktop Kuro is not running.'); });
  }

  var cache = {};
  var mcp = {
    callTool: function (server, tool, input, opts) {
      opts = opts || {};
      if (server === 'host:kuro') return kuro(tool, input).then(function (p) { return { payload: p }; });
      var fn = TOOLS[server + '/' + tool];
      if (!fn) return Promise.reject(err('not_in_manifest', server + ' ' + tool + ' is not available.'));
      var key = server + '/' + tool + '/' + JSON.stringify(input || {});
      var c = opts.cache, stale = c && c.staleTime;
      var hit = cache[key];
      if (stale && !(c && c.refresh) && hit && Date.now() - hit.at < stale) return hit.p;
      var p = getMe().then(function (me) {
        if (!me.googleReady) throw err('server_not_connected', 'Google is not set up for this app yet.');
        if (!me.google) { showConnect('server_not_connected'); throw err('server_not_connected', 'Connect Google first.'); }
        return fn(input || {}, me);
      }).then(function (payload) { return { payload: payload }; });
      if (stale) { cache[key] = { at: Date.now(), p: p }; p.catch(function () { if (cache[key] && cache[key].p === p) delete cache[key]; }); }
      return p;
    },
    invalidate: function (server, tool) {
      var pre = server + '/' + (tool ? tool + '/' : '');
      Object.keys(cache).forEach(function (k) { if (k.indexOf(pre) === 0) delete cache[k]; });
      return Promise.resolve();
    }
  };

  /* ---------------------------------------------------------------- Claude (AM Brief) */
  function parseJson(t) {
    t = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* try the outermost object or array */ }
    var a = t.search(/[\[{]/), close = t.charAt(a) === '[' ? ']' : '}', b = t.lastIndexOf(close);
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* fall through */ } }
    throw err('invalid_json', 'Claude\'s answer was not complete JSON.');
  }
  var sample = {
    text: function (prompt, o) { return run(prompt, o || {}); },
    json: function (prompt, o) { return run(prompt, o || {}).then(parseJson); }
  };
  function run(prompt, o) {
    return api('/sample', { method: 'POST', body: { prompt: prompt, modelTier: o.modelTier || 'default' }, signal: o.signal, raw: true }).then(function (r) {
      var reader = r.body.getReader(), dec = new TextDecoder(), text = '';
      function read() {
        return reader.read().then(function (x) {
          if (x.done) {
            if (text.indexOf('\u0000REFUSED') >= 0) throw err('refused');
            if (text.indexOf('\u0000ERROR') >= 0) throw err('upstream_error');
            if (!text.trim()) throw err('empty_completion');
            return text;
          }
          text += dec.decode(x.value, { stream: true });
          if (o.onText) { try { o.onText({ text: text }); } catch (e) { /* page callback */ } }
          return read();
        });
      }
      return read();
    }).catch(function (e) { if (e && e.name === 'AbortError') throw err('cancelled'); throw e && e.code ? e : err('upstream_error'); });
  }

  /* ---------------------------------------------------------------- "Connect Google" bar */
  var connectShown = false;
  function showConnect(why) {
    if (connectShown) return; connectShown = true;
    function put() {
      var head = document.querySelector('.topbar'); if (!head) return setTimeout(put, 200);
      var bar = document.createElement('div');
      bar.className = 'bfc-connect';
      bar.innerHTML = '<span>' + (why === 'needs_reauth' ? 'Your Google connection expired. Reconnect so Black Fox Center can read your Gmail, Calendar and Drive.'
        : 'Connect your Google account so Black Fox Center can read your Gmail, Calendar, Drive and Sheets.') + '</span>' +
        '<a class="btn sm primary" href="/api/google/start">Connect Google</a><button type="button" class="btn sm ghost" aria-label="Hide">Later</button>';
      bar.querySelector('button').onclick = function () { bar.remove(); };
      head.insertAdjacentElement('afterend', bar);
    }
    put();
  }
  var st = document.createElement('style');
  st.textContent = '.bfc-connect{position:sticky;top:calc(var(--top,64px) + env(safe-area-inset-top,0px));z-index:19;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px max(16px,env(safe-area-inset-left,0px));background:#0E1B23;border-bottom:1px solid rgba(79,216,255,.35);color:#B5F3FF;font-size:13px}.bfc-connect span{flex:1;min-width:200px}';
  document.head.appendChild(st);

  /* ---------------------------------------------------------------- window.claude */
  window.claude = {
    bfc: true,
    use: function (name) {
      if (name === 'db') { if (!polling) { polling = true; poll(); } return Promise.resolve(db); }
      if (name === 'user') return Promise.resolve(user);
      if (name === 'mcp') return getMe().then(function (m) { if (m.googleReady && !m.google) showConnect('server_not_connected'); return mcp; }, function () { return mcp; });
      if (name === 'sample') return getMe().then(function (m) { if (!m.ai) throw err('not_granted'); return sample; });
      return Promise.reject(err('not_declared', name));
    },
    google: { connect: function () { location.href = '/api/google/start'; }, disconnect: function () { return api('/google/disconnect', { method: 'POST' }).then(function () { location.reload(); }); } }
  };
  if (/google=connected/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);

  /* installable app */
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
})();
