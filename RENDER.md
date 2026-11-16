# Deploying Delivery Disaster to Render

One Render **Web Service** serves the game files (Express) *and* the multiplayer backend (Socket.IO),
so there is nothing else to host and no URLs to configure.

## 1. Put the project on GitHub (folder structure matters!)
The repo root must contain exactly this:

```
index.html   package.json   render.yaml   README.md   RENDER.md   .gitignore
css/   js/   assets/   server/   test/
```
When uploading through github.com, **drag the folders themselves** (css, js, assets, server, test) into the upload box,
not the files inside them, or GitHub flattens them and the game breaks.
Don't upload `node_modules/` (it is in `.gitignore`).

## 2. Create the service

### Option A - Blueprint (fastest)
1. Render dashboard -> **New +** -> **Blueprint**.
2. Pick your repo. Render reads `render.yaml` and fills everything in.
3. Click **Apply**.

### Option B - manual
1. Render dashboard -> **New +** -> **Web Service** -> connect your GitHub repo.
2. Fill in:

| Setting | Value |
|---|---|
| Runtime | **Node** |
| Branch | `main` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free (fine for testing) |
| Health Check Path | `/health` |

3. Add the environment variables below, then **Create Web Service**.

## 3. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | **set by Render - don't add it** | 3000 locally | Port the server listens on (it binds to `0.0.0.0`). |
| `NODE_VERSION` | recommended | Render's default | Use `20` (Node 18+ works). |
| `NODE_ENV` | optional | - | `production` enables 5-minute caching of game files. |
| `MAX_PLAYERS_PER_ROOM` | optional | `12` | Lower it if you want smaller rooms. It can never exceed 12. |
| `CORS_ORIGIN` | optional | `*` | Only needed if the *page* is hosted somewhere else (e.g. GitHub Pages). Comma-separated list of allowed origins. |

## 4. Check that it works
1. When the deploy says **Live**, open `https://YOUR-SERVICE.onrender.com/health` - you should see `{"status":"ok",...}`.
2. Open `https://YOUR-SERVICE.onrender.com/` - the status dot in the menu should turn green ("Connected").
3. Click **Create Room**, copy the 5-letter code.
4. Open the same URL in a second window (or on your phone/another computer), enter the code, **Join Room**.
5. Click to play in both - you should see each other's characters, with name tags, walking and poking.

## 5. Free-tier behaviour you should know about
- **Sleeping:** free services sleep after ~15 minutes without traffic. The first visit afterwards takes about a minute
  to wake up; the menu shows "Server may be waking up" until it connects. A paid instance stays awake.
- **Rooms live in memory.** If the service restarts, redeploys or sleeps, all rooms are gone and connected players are
  sent back to the menu.
- **Run exactly one instance.** Rooms are stored in that process's memory, so do not scale to multiple instances.

## 6. Keeping the page on GitHub Pages instead (optional)
Not recommended (two things to maintain), but possible:
1. Deploy to Render as above (it hosts the backend).
2. In `js/server-config.js` set `export const SERVER_URL = 'https://YOUR-SERVICE.onrender.com';` and push.
3. Set `CORS_ORIGIN` on Render to `https://YOUR-USERNAME.github.io`.

You can also test any server without editing code: `https://your-page/?server=https://YOUR-SERVICE.onrender.com`.

## 7. Troubleshooting
| Symptom | Fix |
|---|---|
| Red dot / "Cannot reach server" for more than ~90 s | Check the Render **Logs** tab; confirm Start Command is `npm start` and the deploy is Live. |
| Build fails | Make sure `package.json` is in the repo **root** (not inside a subfolder). |
| Page loads unstyled / blank | Folders were flattened on upload (see step 1). |
| "Multiplayer unavailable" | The browser couldn't load `socket.io-client` from jsDelivr (offline/blocked). Solo still works. |
| Works locally, not when page is on another domain | Set `SERVER_URL` and `CORS_ORIGIN` (step 6). |
| Everyone gets kicked to the menu at once | The service restarted/slept (free tier). Rejoin with a new room. |

## Running locally
```
npm install
npm start          # http://localhost:3000
npm test           # unit tests (rooms, server logic, interpolation)
npm run test:integration   # starts the real server and connects real clients
```
Open two browser windows at http://localhost:3000 to test multiplayer on one computer.
