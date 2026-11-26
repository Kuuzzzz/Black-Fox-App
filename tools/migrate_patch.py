"""Adds 'Export data' (claude.ai app) and 'Import from claude.ai' (Cloudflare app) to the Settings sheet.
The same page code runs in both places; window.claude.bfc tells which one it is."""
import sys
p, out = sys.argv[1], sys.argv[2]
h = open(p, encoding='utf-8').read()
def rep(a, b, n=1):
    global h
    assert h.count(a) == n, (h.count(a), a[:90])
    h = h.replace(a, b)

# Settings sheet: budget wording for the new app, and the move/export section
rep("""    (S.isOwner ? '<hr><div class="label" style="margin-bottom:8px">Budget access</div><p>Budgets show only to people you give <b>edit</b> access to this app (Share → Can edit). Everyone else sees a lock.</p>' +""",
"""    (S.isOwner ? '<hr><div class="label" style="margin-bottom:8px">Budget access</div><p>' + (BFC ? 'Budgets show only to you and the admins listed in Cloudflare (ADMIN_EMAILS). Everyone else sees a lock.' : 'Budgets show only to people you give <b>edit</b> access to this app (Share → Can edit). Everyone else sees a lock.') + '</p>' +""")
rep("""    '<hr><p class="small">Gmail, Calendar, Drive and Sheets are read live with your own sign-in. Heng\\'s inbox and team calendar only ever show to Heng.</p>');
}""",
"""    (S.isOwner ? '<hr><div class="label" style="margin-bottom:8px">' + (BFC ? 'Bring data from claude.ai' : 'Move to the Cloudflare app') + '</div>' +
      (BFC ? '<p>In the old claude.ai app, press <b>Export data</b> in Settings. Then pick that file here. Items with the same name are replaced.</p>' +
        '<label class="btn">' + I.upload + 'Import from claude.ai<input class="sr" type="file" accept=".json,application/json" data-change="bfcImport"></label>'
      : '<p>Saves every project, update, brand, training item, budget, setting, AM brief and Kuro setting into one file for the new app.</p>' +
        '<button type="button" class="btn" data-act="bfcExport">' + I.copy + 'Export data</button>') : '') +
    (BFC ? '<hr><div class="label" style="margin-bottom:8px">Google account</div><p class="small">Gmail, Calendar, Drive and Sheets are read live with your own Google sign-in.</p><div class="row wrap"><a class="btn sm" href="/api/google/start">Reconnect Google</a><button type="button" class="btn sm ghost" data-act="bfcGoogleOff">Disconnect</button></div>'
      : '<hr><p class="small">Gmail, Calendar, Drive and Sheets are read live with your own sign-in. Heng\\'s inbox and team calendar only ever show to Heng.</p>'));
}
var BFC = !!(window.claude && window.claude.bfc);
/* Export: everything this owner can see, as one JSON file, plus the names behind claude.ai user ids */
function bfcExport(btn) {
  if (!S.isOwner) return;
  var done = busy(btn, 'Preparing…'), docs = {};
  var strip = function (o) { var c = JSON.parse(JSON.stringify(o)); delete c.id; return c; };
  S.projects.forEach(function (x) { docs['projects/' + x.id] = strip(x); });
  S.brands.forEach(function (x) { docs['brands/' + x.id] = strip(x); });
  S.updates.forEach(function (x) { docs['updates/' + x.id] = strip(x); });
  S.training.forEach(function (x) { docs['training/' + x.id] = strip(x); });
  Object.keys(S.budgets || {}).forEach(function (k) { docs['budgets/' + k] = S.budgets[k]; });
  if (S.settings && Object.keys(S.settings).length) docs['settings/app'] = S.settings;
  if (S.people && S.people.length) docs['owner/people'] = { list: S.people, updatedAt: todayIso() };
  if (S.kuroCfg) docs['owner/kuro'] = S.kuroCfg;
  if (S.bs && S.bs.cfg) docs['owner/briefs'] = S.bs.cfg;
  ((S.bs && S.bs.list) || []).forEach(function (x) { docs['owner/briefs/sessions/' + x.id] = strip(x); });
  var ids = []; S.updates.forEach(function (u) { if (u.author && ids.indexOf(u.author) < 0) ids.push(u.author); });
  var names = S.user && ids.length ? S.user.profiles(ids).catch(function () { return {}; }) : Promise.resolve({});
  names.then(function (ps) {
    var nm = {}; ids.forEach(function (i) { if (ps[i] && ps[i].name) nm[i] = ps[i].name; });
    if (S.me.id && S.me.name) nm[S.me.id] = S.me.name;
    docs['settings/legacyNames'] = { names: nm, ownerId: S.me.id || '' };
    var text = JSON.stringify({ app: 'black-fox-center', version: 1, exportedAt: new Date().toISOString(), docs: docs });
    var n = Object.keys(docs).length, file = 'black-fox-center-export-' + todayIso() + '.json';
    done();
    /* on claude.ai the page may only hand over files through the downloads capability */
    var dlP = !BFC && window.claude && window.claude.use ? Promise.resolve(window.claude.use('downloads')).catch(function () { return null; }) : Promise.resolve(null);
    dlP.then(function (dl) {
      if (dl) return dl.save({ filename: file, data: new Blob([text], { type: 'application/json' }) }).then(function () { return 'saved'; }, function (e) { return e && e.code === 'declined' ? 'declined' : 'failed'; });
      if (!BFC) return 'failed';
      try { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = file; document.body.appendChild(a); a.click(); a.remove(); return 'saved'; } catch (e) { return 'failed'; }
    }).then(function (st) {
      var msg = st === 'saved' ? 'Saved <b>' + esc(file) + '</b> to your downloads. If you cannot find it, copy the text below and save it in Notepad as a .json file.'
        : st === 'declined' ? 'The file was not saved. Press Export data again, or copy the text below and save it in Notepad as <b>' + esc(file) + '</b>.'
        : 'Copy the text below and save it in Notepad as <b>' + esc(file) + '</b>.';
      openSheet(sheetHead('Export ready', n + ' items') + '<p>' + msg + '</p>' +
        '<textarea class="input" id="bfcExportText" style="min-height:220px" readonly>' + esc(text) + '</textarea>' +
        '<div class="sheet-foot"><button type="button" class="btn" data-act="bfcCopy">' + I.copy + 'Copy all</button><button type="button" class="btn primary" data-act="closeSheet">Done</button></div>');
    });
  });
}
function bfcImport(file) {
  if (!S.isOwner || !file || !needDb()) return;
  file.text().then(function (t) {
    var j = JSON.parse(t);
    if (!j || j.app !== 'black-fox-center' || !j.docs) throw new Error('bad');
    var keys = Object.keys(j.docs), i = 0, ok = 0, failed = 0;
    toast('Importing ' + keys.length + ' items…');
    function next() {
      if (i >= keys.length) { toast('Imported ' + ok + ' items' + (failed ? ', ' + failed + ' could not be saved.' : '.'), !!failed); return; }
      var k = keys[i++];
      return S.db.doc(k).set(j.docs[k]).then(function () { ok++; }, function () { failed++; }).then(function () { if (i % 25 === 0) toast('Imported ' + i + ' of ' + keys.length + '…'); return next(); });
    }
    return next();
  }).catch(function () { toast('That file is not a Black Fox Center export.', true); });
}""")

# actions
rep("  roamTap: function () {", """  bfcExport: function (el) { bfcExport(el); },
  bfcCopy: function () { var t = $('#bfcExportText'); if (!t) return; t.focus(); t.select(); try { navigator.clipboard.writeText(t.value).then(function () { toast('Copied. Paste it into Notepad and save as a .json file.'); }, function () { toast('Press Ctrl+C to copy.'); }); } catch (e) { toast('Press Ctrl+C to copy.'); } },
  bfcGoogleOff: function () { if (window.claude && window.claude.google) window.claude.google.disconnect(); },
  roamTap: function () {""")
rep("  if (k === 'bsUpload') {", "  if (k === 'bfcImport') { bfcImport(el.files && el.files[0]); el.value = ''; return; }\n  if (k === 'bsUpload') {")
open(out, 'w', encoding='utf-8').write(h)
print('ok')
