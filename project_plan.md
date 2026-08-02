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
| `js/latency.js` | Artificial video-link delay |

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
- **FPV** — 90° FOV, mounted on the airframe.
- **Camera uptilt**, 0–60°, default 10°. Real quads mount the camera tilted up because the
  airframe has to pitch forward to move, so the tilt is what buys back the horizon: at 10° the
  drone can lean 10° forward and still be looking straight ahead. Racers run 30–45° because the
  faster you fly the further ahead you need to see. Adjustable from the menu slider or with the
  **↑/↓** arrow keys in flight, in 1° steps, with the angle shown briefly on the OSD since the
  menu is closed while flying. The setting persists, and Line of Sight ignores the arrow keys —
  there is no onboard camera to tilt.
- **Line of Sight** — the camera stands 5 m up and 3 m behind the spawn point and tracks the drone
  continuously, as a pilot watching from the ground does. Adjustable zoom (FOV), a distance readout
  on the OSD, and a visible airframe with red front props and white rear props so orientation stays
  readable at range.
- `C` switches view in flight; the choice persists across sessions.
- **Video latency**, 0–200 ms. The FPV feed is buffered and shown late, so the picture trails the
  drone the way a real video link does — analog about 20–30 ms glass to glass, digital 30–40, and
  past 100 ms is a link in trouble. Only the *view* lags: the sticks reach the flight model at
  once and the physics runs live, so the drone really is where the solver says it is and you crash
  into things that were already there. The delayed pose is interpolated between frames rather than
  snapped to the nearest one, position by lerp and attitude by shortest-arc slerp. Line of Sight
  ignores the setting entirely — the pilot is watching the airframe itself, not a feed — and audio
  is never delayed either, since a quad carries no microphone and the sound reaches the pilot
  through the air.

### 3.6 Wind
Per-axis (roll / pitch / yaw) random disturbance torque, on by default. White noise is passed
through a first-order low-pass so gusts drift over about a second rather than buzzing, with the
amplitude loss from filtering compensated analytically. Torque scales with mass so the strength
slider feels the same on any airframe. Suppressed entirely while the drone is touching a surface —
a parked drone is held by the ground, not blown around.

### 3.7 Audio
Synthesised prop noise, entirely driven by the stick inputs — no samples to load. A quad is mostly
*noise*, and that noise is not steady: each blade passing fires a pulse of air, so the sound is
chopped at blade-passage rate. Four layers:

- **Chopped broadband noise** carries the sound. Bandpassed air noise amplitude-modulated at blade
  rate by a pair of slightly detuned modulators, swinging between silence and full. The deep
  modulation throws ring-mod sidebands either side of the blade tone, which is the hard edge of a
  small prop.
- **Blade harmonics** sit underneath, on a custom periodic wave weighted toward the blade-pass
  harmonic and its multiples rather than the rotation fundamental.
- **Four independent motors**, each running its own RPM through a quad-X mixer, so rolling,
  pitching or yawing spreads them apart and the sound audibly works through a manoeuvre. A small
  fixed spread keeps them beating at a steady hover.
- **Brightness tracking RPM** — a lowpass opening from 500 Hz to 5.5 kHz.
- **Wind noise** — air rushing over the airframe, driven by *airspeed* rather than by the motors,
  so speed is audible independently of throttle. It fades in above a walking pace, climbs faster
  than linear, saturates around 30 m/s, and its spectrum shifts from 400 Hz to 2.2 kHz. Unlike the
  motors it is not gated on arming: a disarmed drone falling out of the sky still moves through
  air. Distinct from the turbulence *Wind* in the launch menu, which is a disturbance torque.

Everything then passes through a **distance stage** before the output, so Line of Sight sounds
like watching from the ground rather than riding along. Volume follows the inverse-distance law
(−6 dB per doubling) past a 4 m reference, and an air-absorption lowpass halves its cutoff every
25 m — a distant drone goes dull as well as quiet, which is most of what makes range audible.
Both floor out rather than reaching silence. In FPV the listener rides the airframe, so the stage
is bypassed entirely.

Prop rotation runs 55–260 Hz, putting the blade tone near 165–780 Hz and the chop at the same rate.
Amplitude and frequency remain linear in the throttle command. Silent when disarmed or paused,
smoothed to avoid clicks on stick movement, and toggleable from the pause menu. The context is
created on the Start button's click, the user gesture browsers require before audio may play.

### 3.8 Interface
- **Launch menu:** controller status and stick check, axis mapping, map selection, flight view,
  drone config (mass, thrust, drag, restitution, grip), wind.
- **Pause menu:** per-axis rates tuning, FPS limiter, speed readout, motor audio.
- **OSD:** arm state, throttle, optional speed, LOS distance.
- Fullscreen, FPS counter, `R` to reset, `Escape` to pause.

### 3.9 Default Configuration
Mass `0.5 kg` · Max thrust `25 N` (~5:1 TWR, hover near 20% throttle) · Air drag `0.5` ·
Restitution `0.2` · Surface grip `0.2` · Wind `0.1` on all three axes · Video latency `0 ms` ·
Camera uptilt `10°` · Default map `Bando`.

## 4. Verification

`physics.js` and `audio.js` are deliberately free of DOM dependencies, so they can be driven
headlessly under Node — against synthetic collision callbacks and a stubbed Web Audio API
respectively; `latency.js` needs no stubbing at all. Seven harnesses, **165 checks**, covering
landing and settling, wall and corner strikes, restitution accuracy, friction, wedged contacts,
tunnelling at racing speed, wind gating, the audio mapping, video-link delay, and the camera
uptilt convention. All pass.

Every harness imports the **shipped** file — none keeps its own copy, and none falls back to one.
A stale copy asserts against code that no longer exists, which is worse than not testing at all;
it has already produced false results here once. `renderer.js` and `ui.js` cannot be imported
under Node (they need the browser's import map for the Three.js addons), so their behaviour is
checked by lifting the method under test out of the shipped source and executing it — if it is
renamed or reshaped, the extraction fails and the test fails with it rather than quietly passing.

**These harnesses are not currently committed.** Adding them under `tests/` is the cheapest way to
protect the physics invariants documented in [`handoff.md`](handoff.md) — several of them are the
kind of assumption a reasonable-looking refactor silently breaks.

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
2. **Commit the test harnesses**, so the physics invariants stop relying on memory.
3. **Per-motor thrust.** Thrust is currently a single force at the centre of mass. Four forces at
   the arm positions would unlock motor spool-up lag (thrust is instantaneous today), differential
   yaw authority, and prop wash.
4. **Turtle mode.** Flipping an inverted drone by reversing two motors — the feature the project is
   named for. Depends on per-motor thrust.
5. **Spawn points.** Spawn is hard-coded to `(0, 1, 0)`, and the LOS camera assumes ground at
   `y = 0`. Per-map spawn points would fix both.
6. **Angle / horizon mode.** Acro only at present; a self-levelling mode makes day one possible.
7. **Doppler and propagation delay.** Distance attenuation is in; a delay line whose length
   tracks range would add both the travel delay and Doppler shift on a fast flyby.
8. **Gates and lap timing**, then replay/ghost — the training loop the simulator is ultimately for.
