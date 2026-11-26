# Black Fox Center on Cloudflare: setup guide

This puts Black Fox Center on its own web address. The team logs in with their @hybrid-ad.biz email and can install it as an app on PC or phone, with your fox icon.

Plan for about **1 to 1.5 hours** the first time. You only do this once.

**What it costs**
- Cloudflare (hosting, database, login for up to 50 people): **free** for a small team.
- Google Cloud (Gmail, Calendar, Drive and Sheets connection): **free**.
- Anthropic (Claude writing in AM Brief): pay per use, usually a few cents per brief. Only you and the admins can use it.
- A custom web address such as `center.hybrid-ad.biz` is optional. Without one, you get a free address like `black-fox-center.yourname.workers.dev`.

**What you need**
- A Windows PC, signed in to your @hybrid-ad.biz Google account in Chrome or Edge.
- This folder, unzipped, for example in `Documents\black-fox-center`.
- About 20 minutes with the Google Workspace admin. That's you, if you manage hybrid-ad.biz.

---

## Step 1: Install Node.js (5 min)

1. Go to **nodejs.org** and download the **LTS** version for Windows.
2. Run the installer and keep pressing **Next**. All the defaults are fine.
3. Open the `black-fox-center` folder in File Explorer. Click the address bar, type `cmd` and press **Enter**. A black terminal window opens inside the folder.
4. Type the line below and press **Enter**. It downloads the tools this project uses.

```
npm install
```

You'll type the rest of the commands in this same black window.

## Step 2: Create a Cloudflare account and sign in (5 min)

1. Go to **dash.cloudflare.com**, sign up with your work email and verify it.
2. In the black window, type:

```
npx wrangler login
```

A browser tab opens. Press **Allow**, then go back to the black window.

## Step 3: Set yourself as the owner (2 min)

Open `wrangler.jsonc` in Notepad and check these lines:

- `"OWNER_EMAIL"`: **your** exact work email. I guessed `heng@hybrid-ad.biz`, so fix it if that's wrong. The owner sees the private inbox, the team calendar, AM Brief and Kuro reminders.
- `"ADMIN_EMAILS"`: people who may see budgets, edit Training and use Claude writing, separated by commas. For example: `"kuuz@hybrid-ad.biz,dara@hybrid-ad.biz"`. You can leave it empty.

Save the file.

## Step 4: Create the database (3 min)

In the black window:

```
npx wrangler d1 create black-fox-center
```

It prints a few lines, including one like `"database_id": "1a2b3c4d-..."`. Copy that ID. Paste it into `wrangler.jsonc` in place of `PASTE-YOUR-DATABASE-ID-HERE`, then save.

Then create the tables:

```
npx wrangler d1 execute black-fox-center --remote --file=schema.sql
```

## Step 5: First deploy (2 min)

```
(optional) npx wrangler secret put TOKEN_KEY
```

It asks for a value. Type a long random password of 30 or more letters and numbers, and keep it somewhere safe. It locks everyone's Google connection. If you ever change it, everyone just presses **Connect Google** once more.

```
npx wrangler deploy
```

At the end it prints your app's address, such as `https://black-fox-center.yourname.workers.dev`. Write it down. **Don't share it yet.** The login wall comes next.

## Step 6: Login wall with Cloudflare Access (10 min)

This makes sure only @hybrid-ad.biz people can open the app.

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, it asks you to pick a **team name**, such as `hybrid`. Choose the **Free** plan. It may ask for a card but doesn't charge for up to 50 users.
2. Note your **team domain**, which looks like `hybrid.cloudflareaccess.com`. You'll find it under **Settings → Custom Pages**, or at the top of **Settings**.
3. Go back to the main dashboard, then **Workers & Pages → black-fox-center → Settings → Domains & Routes**. Next to **workers.dev**, turn on **Cloudflare Access**. Also turn **Preview URLs** off.
4. Go to **Zero Trust → Access → Applications** and open the new application for black-fox-center.
   - **Policies:** edit the policy so it reads **Include → Emails ending in → `@hybrid-ad.biz`**. Remove any rule that lets other people in.
   - **Login methods:** **One-time PIN** is on by default. People type their email and get a 6-digit code. That's all you need. You can add Google login later if you like.
   - Copy the **Application Audience (AUD) Tag** from the application's **Overview** tab.
5. Open `wrangler.jsonc` and fill in:
   - `"ACCESS_TEAM_DOMAIN": "hybrid.cloudflareaccess.com"` (yours)
   - `"ACCESS_AUD": "the long AUD tag"`
6. Save, then run `npx wrangler deploy` again.

Now open your app's address. You should see the Cloudflare login page. Log in with your work email and the code, and Black Fox Center opens.

## Step 7: Connect Google (20 min, needs the Google Workspace admin)

1. Go to **console.cloud.google.com** and sign in with your @hybrid-ad.biz account. Create a project named **Black Fox Center**.
2. **APIs & Services → Library:** search for and **Enable** each of these: **Gmail API**, **Google Calendar API**, **Google Drive API** and **Google Sheets API**.
3. **Google Auth Platform**, also called **OAuth consent screen**: press **Get started**.
   - App name: `Black Fox Center`. Support email: yours.
   - **Audience: Internal.** This is important. Internal means only hybrid-ad.biz accounts can use it, and you skip Google's long app review.
   - Contact email: yours. Then **Create**.
4. **Clients → Create client.**
   - Type: **Web application**. Name: `Black Fox Center`.
   - **Authorized redirect URIs → Add URI:** your app address plus `/api/google/callback`. For example: `https://black-fox-center.yourname.workers.dev/api/google/callback`
   - Press **Create**, then copy the **Client ID** and **Client secret**.
5. In the black window, run these two commands. Paste the matching value when each one asks:

```
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

6. Open the app. A bar appears at the top saying **Connect your Google account**. Press **Connect Google**, sign in with your work account and tick **every box** on the Google screen. Each team member does this once for their own account.

## Step 8: Switch on Claude for AM Brief (5 min)

1. Go to **console.anthropic.com**, create an account, add a payment method and set a monthly **spend limit**, such as $20.
2. **API Keys → Create Key.** Copy it.
3. In the black window:

```
npx wrangler secret put ANTHROPIC_API_KEY
```

AM Brief and "Tidy up notes" now work for you and the admins. Everyone else never triggers Claude, so they can't add to the bill.

## Step 9: Move your data from claude.ai (5 min)

1. Open the **old** Black Fox Center on claude.ai. Click your initials at the top right to open **Settings**, then **Export data**. Save the file.
2. Open the **new** app and go to **Settings → Import from claude.ai**. Pick that file.
3. Check **Clients** and **Team WIP**. You can also press **Sync WIP sheet** to pull the latest from the WIP Google Sheet.

Team WIP needs your WIP Sheet link in **Settings**. It was imported with the rest.

## Step 10: Invite the team and install the app

- Send the team the address. They log in with their work email, then press **Connect Google** once.
- **Install on a PC:** in Edge, open the menu (…) → **Apps → Install this site as an app**. In Chrome, open the menu (⋮) → **Cast, save and share → Install page as app**. It appears in the Start menu and taskbar with the **fox icon**.
- **Install on a phone:** in Safari, press **Share → Add to Home Screen**. In Chrome on Android, press **Install app**.

---

## Later

- **Change who is an admin:** edit `ADMIN_EMAILS` in `wrangler.jsonc`, then run `npx wrangler deploy`.
- **Use your own web address** such as `center.hybrid-ad.biz`: your domain's DNS has to be on Cloudflare. Then go to **Workers & Pages → black-fox-center → Settings → Domains & Routes → Add → Custom domain**. Add the new address to the Cloudflare Access application, and add the new `/api/google/callback` link to the Google client.
- **Update the app** after changes: run `npx wrangler deploy` from this folder.
- **Back up the data:** run `npx wrangler d1 export black-fox-center --remote --output=backup.sql`.
- **Desktop Kuro:** the app is ready to talk to a small desktop helper on `127.0.0.1:47321`. That helper is the next piece to build. See `desktop/README.md`.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Cloudflare Access is not set up for this app yet" | Step 6: fill in `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, then deploy again. |
| "This app is only for @hybrid-ad.biz accounts" | The person logged in with a different email. |
| The Google screen says "Access blocked" or "redirect_uri_mismatch" | The redirect link in Step 7.4 must exactly match your app address plus `/api/google/callback`. |
| "Use your own work account" after Connect Google | Pick the same @hybrid-ad.biz account in Google that you used to log in. |
| The inbox or calendar says "Connect your Google account" | Press **Connect Google** at the top and tick every box. |
| AM Brief says Claude is not switched on | Step 8. Also check that the person is the owner or in `ADMIN_EMAILS`. |
| Anything else | Run `npx wrangler tail` in the black window, reload the app and read the error it prints. |

## Optional: export Team WIP updates to Google Sheets

1. Enable the Google Sheets API in a Google Cloud project and create a dedicated service account.
2. Share the destination workbook with that service account as Editor. Copy the Heng’s Team tab to **Black Fox Updates** and reserve X6:AD for the app’s update log. Set these headings in X6:AD6: Date, Project, Team member, Work done, Next actions, Link, Update ID. Keep the Update ID column available so retries can identify updates that already reached Sheets.
3. In the Cloudflare Worker settings, add two Worker secrets: `WIP_SHEET_ID` for the destination spreadsheet ID and `WIP_SHEETS_SERVICE_ACCOUNT` for the service account JSON. Keep the JSON out of Git and chat. Deploy the updated Worker with its Cron Trigger and confirm the two bindings are present.
4. Post a Team WIP update and allow about one minute for its row to appear. If it does not appear, check the Worker’s scheduled invocation logs. Failed batches retry after their lease expires.

The export starts when both bindings are present. It sends newly posted Team WIP updates only. Existing updates and imports stay in the app. The Worker saves each app update and its pending export in the same D1 transaction. Users can post updates without individually connecting Google.
