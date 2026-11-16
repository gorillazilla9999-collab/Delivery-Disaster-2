# Delivery Disaster — Prompt 1: Player & First-Person Movement

## Run it
Browsers block model loading from `file://`, so serve the folder:

```
cd delivery-disaster
python3 -m http.server 8000      # or: npx serve
```
Open http://localhost:8000, click **Click to play**.
(Three.js r160 loads from the jsDelivr CDN, so you need an internet connection.)

## Controls
| Key | Action |
|---|---|
| Click | lock mouse / start |
| Esc | release mouse (menu has a sensitivity slider) |
| WASD | walk |
| Shift | run |
| Space | jump |
| LMB / RMB | poke with left / right hand (shoves crates) |
| Hold E | both hands reach toward what you're looking at |
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
