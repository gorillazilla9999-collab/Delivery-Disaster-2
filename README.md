# Delivery Disaster — Prompt 1: Movement + Prompt 2: Online Multiplayer

## Run it
```
npm install
npm start            # http://localhost:3000   (or double-click start.command / start.bat)
```
Open it in two or more browser windows. Create a room in one, join with the 5-character code in the others.
Single-player still works with a plain static server (`python3 -m http.server 8000`); the multiplayer badge then says it is unavailable.
Three.js r160 loads from the jsDelivr CDN, so you need an internet connection. Render deployment: see `DEPLOY_RENDER.md`.

## Multiplayer
- Esc opens the menu: name, **Create Room**, room code + **Join Room**, player list, connection status, **Leave Room**.
- 1-12 players per room, rooms are isolated (the server only relays state inside a room), unique 5-char codes.
- Everyone's position, look direction, walk/run/jump state, hand pokes (LMB/RMB) and reaching (E) are synced at 20 Hz
  and interpolated ~120 ms behind; other players are full copies of `person.glb` (head, torso, floating hands and feet).
- The body turns independently of the camera (it follows you when you move, and is dragged along beyond a neck limit).
- **Crates and barrels are synced too** (barrels are just crates with a cylinder look: same pushing, carrying, throwing and sync). Whoever sets a crate moving owns it: they simulate it and stream its state, everyone else
  follows it smoothly. The server arbitrates when two players grab the same crate, gives late joiners the current layout,
  forwards pokes to the owner, and frees a player's crates if they leave. Everyone starts from the same layout when joining a room.
- Dropped connections auto-reconnect and rejoin the same room if it still exists.

## Text chat
- Inside a room press **Enter** (or **T**) to open the chat box, type, **Enter** sends, **Esc** cancels (↑/↓ recall your last messages). While you type, movement and mouse look are paused.
- Messages go through the server: max 200 characters, at most 5 per 5 seconds, shown only to people in your room, drawn as plain text. Admins get an ADMIN tag, the host a ★.
- Recent lines fade after ~9 s and come back while you have the box open. Code: `js/chat.js`, `chat` handler in `server/server.js`, `npm test` covers the rules.

## Host controls + admin
- **Host** (the room creator, shown with ★ in the player list): the menu has *Host controls* to **lock** the room, **set a new room code** (type 5 letters/numbers) or roll a **random** one.
  Everyone inside stays in the room; the old code stops working. A **locked** room refuses everyone except admins. Players who merely lose connection can still get back in for 60 s.
- **Admin**: set the `ADMIN_CODE` environment variable (copy `.env.example`; if it is empty a random code is printed in the server log at start-up).
  Esc menu -> **Admin** -> enter the code. You then see **all rooms** with their players and can **Join** any room (locked or full too), **Kick** any player, **Lock/Unlock** a room and give it a **New code**.
  While inside a room you also get the Host controls and a Kick button next to every player, whoever the host is. Wrong codes are rate-limited (5 tries, then 30 s wait).
- A kicked player is sent back to the menu and may rejoin with the code unless the room is locked.
- Server-side logic lives in `server/rooms.js` / `server/server.js` and is covered by `npm test`.

## Punching + knockouts
- Punch another player (LMB / RMB) to shove them back. **3 hits** knock them out: they fall over and can't move or act for 5 s, then get back up
  with full health and a short moment of protection. Health refills if you are left alone for 4 s.
- The server validates every punch (range, per-player cooldown, KO / protection state) and broadcasts the hit, so the result is the same for everyone.
  Numbers live in `PUNCH` in `server/rooms.js` (damage, KO time, ...) and `combat` in `js/config.js` (reach, knockback). `npm test` covers the rules.
- You can't hit through crates or walls. Knocked-out players drop whatever they carry.
- Punching only works inside a room (you need another player).

## Extra files
```
server/server.js    Express (static + /healthz + /config.js) + Socket.IO
server/rooms.js     room manager (codes, 12-player cap, validation)  -- npm test
js/net.js           Socket.IO client, reconnect/rejoin, clock sync
js/crates-sync.js   crate ownership + sync
js/remote.js        remote avatars + snapshot interpolation + hand/feet animation
js/bodyyaw.js       camera-independent body rotation
js/combat.js        punch detection, hit handling, knockout state + HUD effects
js/chat.js          in-room text chat
js/multiplayer-ui.js menu panel, room HUD, join/leave toasts
render.yaml, DEPLOY_RENDER.md, .env.example
```

## Controls
| Key | Action |
|---|---|
| Click | lock mouse / start |
| Esc | release mouse (menu has a sensitivity slider) |
| WASD | walk |
| Shift | run |
| Space | jump |
| LMB / RMB | punch with left / right hand (shoves crates; punches other players) |
| E | pick up the crate you're looking at / put it down (hands reach while you hold one) |
| LMB / RMB while carrying | throw the crate |
| V | third-person debug view (shows head, torso, feet, hands back on the body) |

## Structure
```
index.html          page + importmap
css/style.css       overlay, crosshair, HUD
assets/person.glb   your model (unchanged)
js/config.js        every tunable number (speeds, FOV, hand positions, model yaw...)
js/main.js          renderer, game loop, wiring
js/input.js         keyboard / mouse / pointer lock
js/character.js     loads person.glb, finds the 6 parts, scales to 1.8 m, feet animation
js/hands.js         first-person hands rig (bob, lag, poke, reach, grip hooks)
js/player.js        movement, camera, head bob, landing dip, character sync
js/physics.js       AABB physics: gravity, ground, step-up, pushable boxes, raycast
js/world.js         sky, lights, ground, obstacles, crates
js/ui.js            overlay / crosshair
```

## About the model
Parts are found by node name (`Cube` torso, `Sphere` head, `Sphere.001/.002` hands,
`Sphere.003/.004` feet) and exposed as `character.parts.{head,torso,handR,handL,footR,footL}`.
If names change, a geometry-based fallback is used. In the console: `DD.character.parts`, `DD.hands`.

- The model is scaled to 1.8 m; eye height is computed from the head.
- First person hides only the head and torso. The feet stay (look down!) and step as you walk.
- The hands are the same objects from your GLB, re-parented to the camera. `V` puts them back on the body.
- Your model's front is its local +X axis; `modelYawOffset` in `config.js` fixes this if needed.

## Hooks for later prompts
- `hands.setReaching(bool)`, `hands.setGrip(side, 0..1)`, `hands.getHandWorldPosition(side, out)`,
  `hands.onImpact(side)` — grabbing/carrying will build on these.
- `physics.add(new Body({...}))` — vehicles/packages can be more bodies; `physics.raycast()` for interaction.
- `player.body`, `player.eyePos`, `player.aimDir` — position/aim state for networking later.
