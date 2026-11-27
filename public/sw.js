/* Black Fox Center: lets the browser install the app. Everything is loaded live from the server (no offline copy),
   so the team always sees the latest data. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') e.respondWith(fetch(e.request, { cache: 'reload' }).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><body style="background:#05070A;color:#E6F1F7;font:15px system-ui;display:grid;place-items:center;height:100vh">Black Fox Center needs an internet connection.',
    { headers: { 'content-type': 'text/html; charset=utf-8' } })));
});
