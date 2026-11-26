# Black Fox Center

Hybrid Advertising's team center: projects, Team WIP, calendar and rooms, training, AM Brief Studio and Kuro the fox.
Runs on Cloudflare (Worker + D1 + Access). **Start with SETUP.md.**

- `public/index.html`: the app (same page as the claude.ai version)
- `public/bridge.js`: replaces claude.ai's runtime (database, Google, Claude) with this server
- `src/worker.js`: the server: login check, database, Google connection, Claude
- `schema.sql`: database tables
- `wrangler.jsonc`: Cloudflare settings (owner, admins, Access)
- `tools/`: how index.html was made from the claude.ai page
- `desktop/`: notes for the future desktop Kuro helper
