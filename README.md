# Delivery Disaster — Prompt 1: Movement + Prompt 2: Online Multiplayer + Prompt 3: Drivable car

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
- Inside a room press **T** to open the chat box, type, **Enter** sends, **Esc** cancels (↑/↓ recall your last messages). While you type, movement and mouse look are paused.
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
| H | get in / out of the car (see below) |
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
js/physics.js       rigid-body physics: rotating boxes + cylinders, friction, bounce, stacking, sleeping, step-up, raycast
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


## Physics (realistic rigid bodies)

Units are metres / seconds / kilograms. Crates and barrels tumble, tip, topple, slide with Coulomb friction, bounce and
stack; barrels are real cylinders that roll. Gravity is 9.81 m/s2, the player weighs 75 kg and can only push with ~1000 N,
so a 130 kg crate barely budges while a 10 kg one flies. You can lift anything, but the heavier it is the slower you walk and the lower you jump;
thrown speed falls with weight; punches hit at the point you aim at, so off-centre hits spin crates.
Crate orientation and spin are synced between players. Tune everything in `js/config.js` (`physics`, `player`, `carry`,
`materials`, `interaction`). Tests: `npm test` (`npm run test:physics`, `npm run test:sync` run headless in Node).

## Crusher and spawn tool

- **Crusher** (`js/crusher.js`, tuned in `CONFIG.crusher`): a hydraulic press at (-11, 12). Its position is a function of synced
  time, so every player sees it in the same place with no network traffic. It is a kinematic body (it really shoves things).
  Crates and barrels still under it when it bottoms out are flattened; map crates come back at their home after 10 s, spawned
  items free up their slot. You get flung clear if you stand under it when it slams. The room host (or the crate's owner) decides
  what was crushed.
- **Spawn tool** (`CONFIG.spawner`): **Q** cycles the item (small / normal / big crate, red / blue barrel), **F** spawns it where you
  look, **X** removes the crate or barrel you look at. Spawned items come from a pre-built pool (6 per type) that exists
  parked on every client, so spawning needs no new network messages: it is just a crate that starts moving.


## The car (Prompt 3)

One drivable car, the **Courier Hatch**, parked at (6, 16). Walk up to it and press **H**.

| Key | In the car |
|---|---|
| **W** / **S** | accelerate / brake, then reverse (W while rolling backwards brakes first) |
| **A** / **D** | steer (less lock at speed) |
| **Space** | handbrake (rear tyres lose grip: handbrake turns and drifts) |
| **R** | reset: stand an overturned or stuck car back up in a clear spot |
| **H** | get out (below ~21 km/h, and only where there is room beside the car) |
| mouse | look around the car; the camera eases back behind it |

**How it works** (`js/vehicle.js`, tuned in `CONFIG.vehicle`): there is no second physics system. The chassis is one dynamic box body in
the normal `PhysicsWorld`, so it collides with walls, crates, barrels and you through the same solver. Each wheel is a ray cast against
static scenery; a spring + damper pushes the chassis up (independent per wheel: roll, pitch, bumps, ramps) and a tyre model pushes it
along and sideways. The tyre model has a slip-angle curve (peak grip, then ~90% when sliding), a friction ellipse (braking or accelerating
reduces cornering grip) and weight transfer comes for free from the suspension. Understeer, oversteer, drifts and handbrake skids are emergent,
and a small counter-steer assist keeps a slide catchable. Rough numbers: 1250 kg, 0-100 km/h in ~8 s, 100-0 in ~41 m (0.96 g),
about 1 g of cornering grip, ~150 km/h top speed.

**Files:** `vehicle.js` (dynamics, runs headless), `vehicle-model.js` (placeholder 3D model: steering + spinning wheels, lights),
`vehicle-camera.js` (follow camera), `vehicle-hud.js` (speed km/h, R/N/D, handbrake, name), `vehicle-system.js` (H / R, seat,
camera blend, reset, exit-spot search), `vehicle-sync.js` (network), `course.js` + `course-view.js` (speed bumps and a ramp at x=34..46),
`server/vehicles.js` + `server/vehicle-handlers.js` (ownership + validation).

**Multiplayer.** The server owns the driver's seat and who may stream the car's state; clients never overwrite each other's car:

- `vehicle-enter` is arbitrated by the server (one driver; you must be near, the car slow, you not knocked out). Simultaneous attempts: exactly one wins.
- Only the **owner** (the driver) streams the car's full rigid-body state (20 Hz; pose, velocity, steering angle, wheel spin, suspension, lights).
  Everyone else sees it as a kinematic body behind a 120 ms interpolation buffer, exactly like crates, so it still shoves crates and players on their screens.
  State from anybody else is dropped and they are told who owns it. Teleports are refused (a reset may move the car <=16 m or home).
- Other drivers are drawn sitting in the car using the car's own rendered pose, so driver and car can never drift apart.
- Get out of a moving car and you keep simulating it until it stops, then you release it and everybody snaps to the same final spot.
  If the driver disconnects the seat is freed at once; a moving car is handed to the host to roll to a halt. Knocked-out drivers are ejected.
- No new crate messages: the crate channel is untouched.

Audio was not requested for this step, so there is none.

**Tests:** `npm test` also runs `test:vehicle` (physics: grip, braking, drift, collisions, suspension, ramp, reset, exit), `test:vehicle-sync`
(the real server logic + several simulated clients with latency), `test:vehicle-camera` and `test:vehicle-client` (the glue, run in Node with
three.js and the DOM stubbed out; it exercises logic, it cannot render).

**Manual checklist (browser, two windows)** - these cannot run in a headless sandbox:
1. Window A creates a room, B joins. Both see the car at the same place. A: walk up, H. B sees A sitting in it.
2. A drives; B watches the wheels turn, the front wheels steer, brake lights; the driver stays in the seat.
3. B walks up and presses H: "Somebody is already driving that". Both press H at the same instant: only one gets in.
4. A drives into crates/barrels (north of the start) - they fly; try the bumps and the ramp east of the start (x 34..46).
5. A closes the tab at speed: the car coasts to a stop on the host's screen and B can drive it.
6. Flip the car (ramp at an angle), press R. Press H beside a wall on both sides: "No room to get out here".
7. Open DevTools: no console errors; `DD.vehicles` is the debug handle.
