# 🏠 HouseCart

A single-page household shopping & maintenance tracker. Pure HTML + CSS +
vanilla JS — **no build step, no backend, no dependencies**. Installable as a
PWA on iOS/Android.

## What it does

Track everything your household needs to buy, replace, or pay for — and turn
it into focused shopping trips.

### Core use cases

- **Recurring bills & subscriptions** — Netflix, dog food, lawn service.
  Auto-resurface near the due date; mark auto-paid ones to keep them quiet.
- **Active shopping list** — groceries, household items, project parts. Type
  naturally: `garden hose washer $5 at Home Depot maintenance`.
- **Long-term goals** — bigger / saved-up purchases. Track progress.
- **Suggestions** — based on history + related-item rules ("you bought
  printer ink 3× at this cadence, refill soon?").
- **Trip queue + Shop Mode** — pick items → preview the trip → enter a
  full-screen, finger-friendly **Shop Mode** with wake-lock so the screen
  stays on while you walk the aisles.
- **Receipt paste** — paste a receipt to bulk-add items with prices.
- **Voice add** — `🎤` button uses Web Speech API.
- **History & undo** — every bought item retains a history; most destructive
  actions surface an undo toast.

### Keyboard shortcuts

`N` quick-add · `/` or `F` global search · `G` generate trip ·
`V` voice add · `1`–`7` switch tabs · `?` help · `Esc` close

## Files

```
index.html               markup + tabs + modals
app.js                   ~2500 lines: state, parsing, rendering, sync
styles.css               dark theme, responsive (mobile-first @600px / @380px)
sw.js                    service worker (offline cache, network-first HTML)
manifest.webmanifest     PWA manifest
icon.svg, icon-*.png     app icons (incl. apple-touch-icon)
```

## Deployment

Any static-file host works. The app needs **HTTPS** for the service worker,
Wake Lock API, and "Add to Home Screen" on iOS.

### Option A — Drag-and-drop (fastest)

1. Go to [app.netlify.com](https://app.netlify.com) or
   [pages.cloudflare.com](https://pages.cloudflare.com)
2. **Add new site → Deploy manually**
3. Drag this folder onto the page
4. Open the `https://…` URL on your phone

### Option B — GitHub Pages (permanent + version-controlled)

```powershell
cd "C:\Users\Robert Kang\source\repos\aiWorkshop\housecart"
git init && git add . && git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/RobKangProShop/houseCart.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: `main` / root → Save**.
URL: `https://robkangproshop.github.io/houseCart/`.

### Local testing

A service worker won't register from `file://`. Use any static server:

```powershell
# Node
npx serve .
# Python (if installed)
python -m http.server 8000
```

Open `http://localhost:8000`.

### Install on iPhone

1. Open the deployed URL in **Safari** (not Chrome — iOS PWAs only install
   from Safari)
2. Share → **Add to Home Screen**
3. Launches chromeless, with durable storage

### Updating

When you change a file:

1. Push / re-upload
2. Bump `CACHE_VERSION` in [sw.js](sw.js) (`housecart-vN` → `housecart-v(N+1)`)
3. Open the app — it detects the new service worker and reloads automatically

## Data persistence

Three layers, each independent and optional. All free, no API:

| Layer                   | What                                                                                                                                                                                                   | Where to enable                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **1. IndexedDB**        | Primary durable store with a localStorage mirror for sync writes & cross-tab sync. Survives Safari's 7-day eviction better than localStorage alone.                                                    | Automatic                                          |
| **2. Backups**          | Periodic JSON backup via native share sheet (phone) or download (desktop). Stash in iCloud Drive / Files / Dropbox. Banner nags when overdue.                                                          | Settings → Backup                                  |
| **3. GitHub Gist sync** | Real cross-device sync via a **secret Gist**. Every save auto-pushes (debounced 4s); every launch auto-pulls. Each push is a git commit = free version history. Last-write-wins with conflict prompts. | Settings → Cloud sync (one-time PAT setup, ~2 min) |

The Export/Import JSON buttons in Settings remain your manual escape hatch.

## Security notes

- Stored locally: shopping data, optional OpenAI API key, optional GitHub
  Gist token. **All three live unencrypted in this browser's localStorage.**
  Anyone with access to this browser profile (or a malicious extension) can
  read them.
- Use a GitHub **classic** PAT with **only the `gist` scope** checked
  (GitHub's fine-grained PATs cannot access the Gist API). Rotate every
  ~90 days.
- No data ever leaves the browser unless you (a) enable Gist sync or (b)
  enable the optional LLM API key for parsing.

## Browser support

- **iOS Safari 16.4+** — full PWA, Wake Lock, Web Share
- **Android Chrome** — full feature set
- **Desktop Chrome/Edge/Firefox/Safari** — full feature set
- Older iOS — works, but Shop Mode screen-on and PWA install limits apply
