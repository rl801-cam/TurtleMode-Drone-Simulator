# Project Plan: TurtleMode Simulator (Web-Based FPV Drone Simulator)

A lightweight, browser-based FPV drone simulator focused on realistic flight physics, real RC
transmitter support, and pilot training. Runs entirely client-side with no build step and is
hosted on GitHub Pages.

## 1. Technical Stack

| Concern | Choice |
| --- | --- |
| Rendering | Three.js `0.160.0` |
| Physics | Cannon-es `0.20.0` (rigid body integration; contacts are custom) |
| Collision geometry | three-mesh-bvh `0.7.3` |
| Audio | Web Audio API (synthesised, no sample files) |
| Input | Gamepad API |
| Modules | Vanilla ES modules via `<importmap>` from unpkg — no bundler, no `npm install` |
| Hosting | GitHub Pages |

## 2. Architecture

| File | Responsibility |
| --- | --- |
| `index.html` | UI overlays (launch menu, pause menu, OSD) and the importmap |
| `css/style.css` | Glass-panel menus and OSD styling |
| `js/main.js` | Frame loop, game state (`MENU` / `PLAYING` / `PAUSED`), module wiring |
| `js/physics.js` | Cannon-es world, flight model, and the contact solver |
| `js/renderer.js` | Three.js scene, both cameras, map loading, BVH collision queries |
| `js/input.js` | Gamepad polling, axis mapping, deadband, arm switch |
| `js/ui.js` | DOM bindings, menus, slider-to-physics wiring, map upload |
| `js/audio.js` | Motor tone synthesis |

**Module caching:** `index.html` and the imports in `main.js` carry a `?v=N` cache-busting tag, and
the running build is logged to the console and shown in the launch menu. Bump every tag together
after editing any module. `index.html` itself is not versioned, so a browser holding a stale copy
of it will keep requesting the old module versions — check the build stamp before debugging
anything that looks like an unapplied change.

## 3. Implemented Features

### 3.1 Controller Input
- Raw, low-latency Gamepad API polling aimed at RC radios (TBS Tango, Radiomaster, FrSky).
- Per-axis index mapping and reversing for throttle, yaw, pitch and roll, with a live stick
  visualiser and axis bars for verification.
- Configurable arm button; a disarmed drone receives no thrust and makes no sound.
- 5% deadband, rescaled so the usable stick range stays full.

### 3.2 Flight Model
- Fixed 120 Hz physics sub-step. Thrust and control torque are injected through Cannon-es's
  `preStep` event so forces apply on every internal sub-step, making flight fully
  framerate-independent.
- Betaflight-style "actual rates": centre sensitivity, max rate and expo, tunable per axis.
- Angular rate held by a P-controller against the commanded rate, as a flight controller does.
- Adjustable mass, max thrust and air drag.

### 3.3 Collision & Crash Physics
Map geometry is merged into a single BVH (built in a Web Worker, with a main-thread fallback), and
contacts are resolved by a custom impulse solver rather than Cannon-es's narrowphase:

- **Five contact spheres** — one per motor plus the airframe centre, kept coplanar with the centre
  of mass so a square-on wall strike has no lever arm and does not tumble.
- **Manifold grouping** — contacts sharing a surface normal are solved as one equivalent contact at
  their centroid. A symmetric patch has no lever arm; a lopsided one (a single motor catching a
  corner) does, which is what makes corner strikes spin the drone.
- **Coulomb friction** clamped to the friction cone, so a scraped wall converts momentum into a
  tumble rather than only scrubbing speed.
- **Rolling resistance** bounded by contact force and the spread of the contact patch, so a drone
  left lying tilted settles instead of rocking on its edge indefinitely.
- **Restitution** applied once per surface after the approach is stopped, and disabled below a
  0.6 m/s closing speed so a landed drone settles rather than buzzing.
- **Continuous collision detection** — sub-steps longer than the contact radius are swept with a
  raycast, since at racing speeds a discrete check can step clean over a surface. The threshold is
  derived from the contact radius and must never exceed it.

### 3.4 Environment & Maps
- Procedural placeholder map, `bando.glb`, and user-uploaded `.glb`/`.gltf` via
  `URL.createObjectURL` — no backend needed.
- Collision geometry is generated automatically for whichever map is loaded.
- Adjustable surface grip and restitution.

### 3.5 Cameras
- **FPV** — 90° FOV, mounted on the airframe with a 20° uptilt.
- **Line of Sight** — the camera stands 5 m up and 3 m behind the spawn point and tracks the drone
  continuously, as a pilot watching from the ground does. Adjustable zoom (FOV), a distance readout
  on the OSD, and a visible airframe with red front props and white rear props so orientation stays
  readable at range.
- `C` switches view in flight; the choice persists across sessions.

### 3.6 Wind
Per-axis (roll / pitch / yaw) random disturbance torque, on by default. White noise is passed
through a first-order low-pass so gusts drift over about a second rather than buzzing, with the
amplitude loss from filtering compensated analytically. Torque scales with mass so the strength
slider feels the same on any airframe. Suppressed entirely while the drone is touching a surface —
a parked drone is held by the ground, not blown around.

### 3.7 Audio
A single sine oscillator whose **pitch and amplitude both track thrust** — 80 Hz to 450 Hz, and
silent up to a modest ceiling, both linear in the throttle command. Real motors are a stack of
harmonics, but a clean tone is enough to fly by ear. Silent when disarmed or paused, smoothed to
avoid clicks on stick movement, and toggleable from the pause menu. The context is created on the
Start button's click, which is the user gesture browsers require before audio may play.

### 3.8 Interface
- **Launch menu:** controller status and stick check, axis mapping, map selection, flight view,
  drone config (mass, thrust, drag, restitution, grip), wind.
- **Pause menu:** per-axis rates tuning, FPS limiter, speed readout, motor audio.
- **OSD:** arm state, throttle, optional speed, LOS distance.
- Fullscreen, FPS counter, `R` to reset, `Escape` to pause.

### 3.9 Default Configuration
Mass `0.5 kg` · Max thrust `25 N` (~5:1 TWR, hover near 20% throttle) · Air drag `0.5` ·
Restitution `0.2` · Surface grip `0.2` · Wind `0.1` on all three axes.

## 4. Verification

`physics.js` and `audio.js` are pure ES modules with no DOM dependencies, so they can be driven
directly under Node — against synthetic geometry and a stubbed Web Audio API respectively. The
suites cover landing and settling, wall and corner strikes, restitution accuracy, friction, wedged
contacts, tunnelling at racing speed, wind behaviour and its suppression on the ground, and the
audio mapping. They also assert invariants such as *the CCD threshold never exceeds the smallest
contact radius*, which encode assumptions that are easy to break by accident.

## 5. Roadmap

### Complete
- Gamepad input, axis mapping, arming.
- Framerate-independent thrust and rates.
- Three.js rendering, GLTF map loading, custom map upload.
- **Environment collision for all maps** — previously the top open item; the drone no longer passes
  through walls.
- Crash physics: bounce, corner-induced rotation, friction, rolling resistance, CCD.
- FPV and Line of Sight cameras.
- Wind / turbulence.
- Motor audio.

### Next
1. **Persistent settings.** Only camera mode, LOS zoom, speed readout and audio persist. Rates,
   physics parameters and axis mappings reset on reload — the most disruptive remaining gap, since
   a pilot's rates and radio mapping are exactly what should be remembered.
2. **Per-motor thrust.** Thrust is currently a single force at the centre of mass. Four forces at
   the arm positions would unlock motor spool-up lag (thrust is instantaneous today), differential
   yaw authority, and prop wash.
3. **Turtle mode.** Flipping an inverted drone by reversing two motors — the feature the project is
   named for. Depends on per-motor thrust.
4. **Spawn points.** Spawn is hard-coded to `(0, 1, 0)`, and the LOS camera assumes ground at
   `y = 0`. Per-map spawn points would fix both.
5. **Angle / horizon mode.** Acro only at present; a self-levelling mode makes day one possible.
6. **Gates and lap timing**, then replay/ghost — the training loop the simulator is ultimately for.
