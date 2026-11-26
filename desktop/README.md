# Desktop Kuro (next step)

The web app already looks for a small Kuro helper running on the same PC at http://127.0.0.1:47321
(see `kuro()` in public/bridge.js). When it answers, every reminder (meetings, water, deadlines,
urgent emails, play visits) also pops up as Kuro on top of any app, just like the claude.ai version.

The helper must answer these POST requests with JSON:
- /ping              -> { "sprites": <number of Kuro pictures installed> }
- /install_sprites   { sprites: [{ name, png (base64) }] } -> { "saved": n }
- /show_reminder     { title, text, face, badge, url, urgent } -> { "ok": true }
and send `Access-Control-Allow-Origin: <your app address>` and `Access-Control-Allow-Private-Network: true`.

It is not built yet. Ask Claude to build it as a small Windows tray app (Electron or Tauri).
