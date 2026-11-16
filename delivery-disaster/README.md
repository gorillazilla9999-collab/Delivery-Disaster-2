# Delivery Disaster

Chaotic physics-based multiplayer browser game (1-12 players per room).
Stage 1: first-person movement. **Stage 2 (this version): online multiplayer on Node + Express + Socket.IO.**
No vehicles or delivery mechanics yet.

## Run it
```
npm install
npm start            # open http://localhost:3000   (or double-click start.command / start.bat)
```
Open a second browser window to test multiplayer. Deploying online: see **RENDER.md**.

## Playing
1. **Create Room** -> share the 5-letter code, or **Join Room** with a friend's code, or **Play Solo**.
2. Click **Click to play** to lock the mouse.

| Key | Action |
|---|---|
| WASD / Shift / Space | walk / run / jump |
| Mouse | look |
| LMB / RMB | poke with left / right hand (other players see it) |
| Hold E | reach with both hands |
| V | third-person debug view |
| Esc | release mouse + open the room menu (player list, room code, Leave Room) |

## Structure
```
index.html, css/style.css       page + styling
assets/person.glb               your model (unchanged)
server/server.js                Express (static files, /health) + Socket.IO startup, Render-ready
server/game-server.js           all socket events: rooms, state relay, snapshots, rate limits
server/rooms.js                 pure room logic: codes, 12-player cap, host, slots, validation
js/main.js                      game loop + wiring (menu <-> solo/room)
js/network.js                   Socket.IO client wrapper, status, request timeouts
js/server-config.js             SERVER_URL ('' = same origin)
js/remote-players.js            other players: full characters, name tags, interpolation
js/interp.js                    snapshot interpolation + clock sync (unit-tested)
js/character.js                 person.glb loader; local + remote copies; feet/hand/head animation
js/player.js, hands.js          first-person movement, camera, viewmodel hands
js/physics.js, world.js         AABB physics, test environment
js/ui.js, input.js, config.js   lobby UI, input, tunables
test/                           unit tests + fake Socket.IO + real-server integration test
```

## How multiplayer works
- Clients send their state 20x/s (4x/s when idle): position, camera yaw/pitch, **separate body yaw**, velocity, grounded/running/reaching flags.
- The server validates/clamps it, timestamps it, and every 50 ms sends each room **one batched snapshot** - only to that room.
- Remote players are drawn ~110 ms in the past and interpolated between timestamped snapshots (brief extrapolation, teleport-safe).
- Walk/run/jump animation is derived from the synced velocity + grounded flag; pokes and reaching are synced too.
- Rooms: unique 5-character codes, max 12 (server-enforced, `MAX_PLAYERS_PER_ROOM` can lower it), host migrates when the host leaves, empty rooms are deleted, join/leave notifications, rate limiting on room operations.

## Known limitations (Stage 2)
- **Crates and other physics objects are not synced** - each player simulates their own. (Planned together with delivery mechanics.)
- Players walk through each other (no player-vs-player collision yet).
- If your connection drops you are removed from the room and must rejoin (no session resume yet).
- Rooms are in server memory: a restart/sleep ends them.
- The unit tests run without Socket.IO installed; `npm run test:integration` needs `npm install` first.
