# Deploying Delivery Disaster to Render

The game files and the multiplayer server run in **one Render Web Service** (Express serves the
game, Socket.IO handles multiplayer on the same URL), so there is nothing to configure between them.

## 1. Run it locally first
```
npm install
npm start            # http://localhost:3000
```
Open it in two browser windows: create a room in one, join with the 5-character code in the other.
(`npm test` runs the room-logic unit tests.)

## 2. Push to GitHub
Put the project folder in a GitHub (or GitLab) repo. `node_modules/` and `.env` are git-ignored.

## 3. Create the service on Render
**Option A - Blueprint (easiest):** Render Dashboard -> *New* -> *Blueprint* -> pick the repo. `render.yaml` sets everything up.

**Option B - manual:** *New* -> *Web Service* -> pick the repo, then:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Instance type | Free works for testing |

Render provides `PORT` itself; the server listens on it and binds to `0.0.0.0`. Do not set PORT yourself.

## 4. Environment variables (all optional)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | set by Render | Port to listen on |
| `NODE_VERSION` | - | Set to `20` (or newer) to pin Node |
| `ADMIN_CODE` | random each start (printed in the log) | **Set this** to a long secret. Enter it under *Admin* in the menu to join/kick/lock/re-code any room |
| `MAX_PLAYERS` | `12` | Players per room (1-12; 12 is the hard cap) |
| `PUBLIC_SERVER_URL` | empty = same origin | Only if the frontend is hosted on a different domain than the server |
| `CORS_ORIGIN` | none | Only for a separately hosted frontend: allowed origin(s), comma separated |

With the default single-service setup you need **none** of these.

## 5. Play
Open `https://<your-service>.onrender.com`, enter a name, **Create Room**, and send friends the room
code (the **Copy** button copies a share link like `https://<your-service>.onrender.com/?room=ABCDE`).

## Notes for Render
- **Free tier sleeps** after ~15 minutes without traffic; the first visit afterwards takes ~30-60 s to wake up.
  Rooms live in memory, so a sleep, restart or redeploy closes all rooms.
- **Run a single instance.** Rooms are stored in the server's memory; scaling to several instances would
  split players of one room across servers. Keep the instance count at 1.
- WebSockets work on Render without extra setup. If the status badge stays on "Cannot reach server", check the service Logs.
- Health check: `GET /healthz` -> `{"status":"ok","rooms":N,"players":N}`.

## Hosting the frontend elsewhere (optional, later)
Set `CORS_ORIGIN=https://your-frontend.example` on Render, and open the frontend with
`?server=https://<your-service>.onrender.com` (or serve a `config.js` defining `window.DD_ENV = { serverUrl: "..." }`).
