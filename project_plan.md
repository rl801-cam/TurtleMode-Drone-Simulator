# Project Plan: TurtleMode Simulator (Web-Based FPV Drone Simulator)

A lightweight, browser-based FPV drone simulator focused on realistic flight physics, real RC
transmitter support, and pilot training. Runs entirely client-side with no build step and is
hosted on GitHub Pages. Two modes: **Practice**, free flight with every parameter on a slider, and
**Race**, timed laps round a gated course on a fixed spec.

## 1. Technical Stack

| Concern | Choice |
| --- | --- |
| Rendering | Three.js `0.160.0` |
| Physics | Cannon-es `0.20.0` (rigid body integration; contacts are custom) |
| Collision geometry | three-mesh-bvh `0.7.3` |
| Audio | Web Audio API (synthesised, no sample files) |
| Input | Gamepad API |
| Modules | Vanilla ES modules via `<importmap>` from unpkg — no bundler, no `npm install` |
| Map tools | Plain Node under `tools/`, zero dependencies — glTF, PNG and previews written by hand |
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
| `js/ui.js` | DOM bindings, menus, slider-to-physics wiring, map upload, leaderboard, race HUD |
| `js/audio.js` | Motor tone synthesis |
| `js/latency.js` | Artificial video-link delay |
| `js/race.js` | Gate meshes, crossing detection, lap clock, persistent leaderboard |
| `js/tracks.js` | Course data (gates, radii, spawn) and the fixed racing spec |
| `tools/` | Offline map generation and inspection. Not loaded by the page |

**Module caching:** `index.html` and the imports in `main.js` and `ui.js` carry a `?v=N`
cache-busting tag, and the running build is logged to the console and shown in the launch menu.
Bump every tag and the `BUILD` constant together after editing any module — **the current build is
`v27`**. `index.html` itself is not versioned, so a browser holding a stale copy of it will keep
requesting the old module versions — check the build stamp before debugging anything that looks
like an unapplied change.

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
Map geometry is merged into a single BVH on the main thread, and contacts are resolved by a custom
impulse solver rather than Cannon-es's narrowphase:

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
- Procedural placeholder map, `bando.glb`, `rift-quarry.glb`, and user-uploaded `.glb`/`.gltf` via
  `URL.createObjectURL` — no backend needed.
- Collision geometry is generated automatically for whichever map is loaded.
- Adjustable surface grip and restitution.
- **Sky colour and fog are per map.** The original 20–100 m fog suits the bando, which is a
  building you fly around inside, and would bury a 300 m quarry in haze; anything without an entry
  in `MAP_ENV` keeps the old values, uploads included.
- **Rift Quarry** — a generated map, 300 m across: a terraced quarry basin ringed by hills, with a
  graded plant yard, a shed open at both ends, silos and an inclined conveyor, four benches
  spiralling 22 m down to the pit floor, an adit bored through a rock plug, and a 93 m ravine
  climbing back to the yard beneath a natural stone arch. 49.6 MB, 762k triangles, 139 meshes,
  seven embedded procedural textures. Built by `tools/generate-rift-quarry.mjs` (§4).
- **Load cost.** `bando.glb` is 43.6 MB — 852 meshes, 868k triangles, uncompressed, no textures;
  `rift-quarry.glb` is 49.6 MB, of which 23.8 MB is texture. Everything after the download is cheap
  by comparison: measured end to end on the bando, GLTF parse, clone and transform, merge and BVH
  come to about 490 ms, of which the tree is about 260 ms. So the wait on a first visit is very
  nearly all transfer, and on later visits the browser cache makes it disappear. Draco or meshopt
  compression is the one change that would move it; both need a build step and a decoder, so
  neither is in yet.

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
  continuously, as a pilot watching from the ground does; it moves with the spawn, so a race is
  watched from beside the start grid. Adjustable zoom (FOV), a distance readout on the OSD, and a
  visible airframe with red front props and white rear props so orientation stays readable at
  range.
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

### 3.8 Race Mode
Timed laps round a gated course. Selecting Race loads the track's own map — the gates were surveyed
against that geometry and mean nothing anywhere else — moves the drone and the Line of Sight
viewpoint to the start grid, and locks the airframe to a fixed spec.

- **Spec class.** Mass, thrust, drag, restitution, grip, rates and video latency are all overridden,
  and wind is switched off entirely: a drifting breeze would make two laps incomparable. Camera,
  controller mapping and display settings stay the pilot's own. The sheet is printed in the launch
  menu so it is clear what is being flown. Returning to Practice restores the pilot's own numbers
  from the sliders.
- **Gates** are a plane with a radius, and **count from either side**. A crossing registers whenever
  the flown segment passes through the disc, whichever way it was going: overshoot a ring and swing
  back through it and the gate is taken, rather than the run sitting there waiting for you to go
  round and approach it the "right" way. Only the gate the run has reached is armed, so a ring
  already behind you still cannot be re-triggered, and no gate can be machine-gunned by a drone
  bouncing about inside it. `yaw` and `pitch` therefore set how a ring hangs in the air — square
  across the opening it is threaded through — and no longer which way it has to be flown; one lying
  flat in a floor opening counts on the way up and on the way down alike. Per-gate radius overrides
  let a ring be threaded through a hole in a wall.
- **Timing** is trimmed to the crossing rather than the frame: the fraction along the segment where
  the plane was cut is subtracted from both the start and the lap boundary, so a 144 Hz machine and
  a 60 Hz one post the same times. The clock runs off the live physics position, never the delayed
  video feed.
- **Leaderboard**, per track, in `localStorage`. One row per pilot holding their fastest lap, 25
  stored and 10 shown, with the board readable from the launch menu and the pause menu. A lap that
  beats the stored record, the session best, or neither, gets a different toast.
- **HUD:** running lap time, lap number, next gate with its name and range, a pointer that swings to
  the next gate once it leaves the middle of the view, and last / best / record times. The next
  gate is lit and pulsing, gates already taken this lap fade back.
- **Track: Bando Gauntlet** — 17 gates, about 304 m a lap. In through a 2 m hole in the ground-floor
  wall, west down the pillar hall, vertically up the service shaft, out through the matching hole
  7.8 m up, back down through the deck, then flat out under a solar array with a 1.6 m ceiling.
- **Track: Rift Run** — 17 gates, about 422 m a lap, on Rift Quarry. Down the apron and straight
  through the shed, out along the haul road under the conveyor belt, over the quarry rim and four
  turns down the benches — the last of them a 30° dive — across the floor and through the adit, then
  the long climb up the ravine and out under the arch, and back across the yard through the
  container alley, round the tank and under the pipe rack. Longer and faster than the Gauntlet,
  with the altitude change doing the work the bando does with tight walls.

### 3.9 Interface
- **Mode switch:** Practice / Race, remembered between sessions. The launch and pause menus show
  only what applies to the current mode.
- **Launch menu:** controller status and stick check, axis mapping, map selection, flight view,
  drone config (mass, thrust, drag, restitution, grip), wind; in Race, track selection, pilot name,
  the spec sheet and the leaderboard.
- **Pause menu:** per-axis rates tuning, FPS limiter, speed readout, motor audio; in Race, lap
  count, session best, track record and the board.
- **OSD:** arm state, throttle, optional speed, LOS distance, and the race HUD.
- Fullscreen, FPS counter, `R` to reset (back to the grid in a race, which discards the lap in
  progress), `Escape` to pause.

### 3.10 Default Configuration
Mass `0.5 kg` · Max thrust `25 N` (~5:1 TWR, hover near 20% throttle) · Air drag `0.5` ·
Restitution `0.2` · Surface grip `0.2` · Wind `0.1` on all three axes · Video latency `0 ms` ·
Camera uptilt `10°` · Default map `Bando`.

Racing uses the same numbers with wind off and latency pinned at zero.

**What persists:** camera mode, LOS zoom, camera uptilt, speed readout, audio, game mode, track,
pilot name and the leaderboards. Rates, physics parameters and axis mappings do not.

## 4. Verification

`physics.js` and `audio.js` are deliberately free of DOM dependencies, so they can be driven
headlessly under Node — against synthetic collision callbacks and a stubbed Web Audio API
respectively; `latency.js` needs no stubbing at all. Seven harnesses, **165 checks**, covering
landing and settling, wall and corner strikes, restitution accuracy, friction, wedged contacts,
tunnelling at racing speed, wind gating, the audio mapping, video-link delay, and the camera
uptilt convention. All passed when they were written.

Every harness imports the **shipped** file — none keeps its own copy, and none falls back to one.
A stale copy asserts against code that no longer exists, which is worse than not testing at all;
it has already produced false results here once. `renderer.js` and `ui.js` cannot be imported
under Node (they need the browser's import map for the Three.js addons), so their behaviour is
checked by lifting the method under test out of the shipped source and executing it — if it is
renamed or reshaped, the extraction fails and the test fails with it rather than quietly passing.

**These harnesses are not committed**, so none of the above can be re-run as the repository stands,
and they predate race mode — `race.js` and `tracks.js` have no coverage at all. Gate crossing is
pure geometry: a sign-change test across the ring plane, an in-plane radius test and a sub-frame
interpolation, which is precisely the sort of thing that can be quietly wrong. Two-sided crossings
make it worth covering sooner rather than later, since both approach directions and the sub-frame
fraction each now have a second case to get right. It needs the same lift-the-method-out treatment,
since `race.js` cannot be imported under Node either.

Adding all of this under `tests/` is the cheapest way to protect the invariants documented in
[`handoff.md`](handoff.md) — several of them are the kind of assumption a reasonable-looking
refactor silently breaks.

### 4.1 Map generation and course survey

`tools/generate-rift-quarry.mjs` is the exception: its checks are committed and run on every build.

```
node tools/generate-rift-quarry.mjs                 # rift-quarry.glb + tools/rift-quarry-survey.json
node tools/generate-rift-quarry.mjs --preview out   # ...and six rendered viewpoints
node tools/inspect-glb.mjs rift-quarry.glb          # read any .glb back and report what is in it
```

A generated map can be surveyed the other way round from a downloaded one. The racing line is
defined in the same layout constants the geometry is built from, so each gate's yaw and pitch is
the **tangent of the flown line** at that point rather than a guess, and the lap length is measured
along the line rather than gate to gate. Then, with every triangle still in memory, the generator
samples each gate ring round its circumference and walks each leg of the line at 0.4 m intervals
against a spatial hash of the geometry, and **fails the build** if a ring falls below 0.35 m of
clearance or a leg below 1.0 m. It has already caught four gates buried in geometry and a line that
went through a spoil heap and a pipe-rack leg. It is a straight-line test between waypoints: it
proves the corridor is there, not that every line through it is clean.

Three further checks run alongside it: `selfTest()` asserts that the box, cylinder and tube
primitives face outwards, `verifyArch()` that the one piece of geometry whose winding is not
obvious does too, and `verifyGLB()` re-reads the finished file and validates chunk lengths,
buffer-view alignment and index ranges. `lib/preview.mjs` is a z-buffered software rasteriser over
the same triangles — it caught an arch wound inside out and a pipe run that came out as vertical
poles, neither of which any structural check would have noticed.

The whole toolchain has no dependencies: the glTF container, the PNG encoder (`zlib` only), the
noise, the textures and the rasteriser are all written out longhand, which keeps the "no
`npm install`" rule true of the tools as well as the page. Everything is seeded, so the same
source always produces the same map — necessary, since `tracks.js` holds coordinates surveyed
against those exact triangles.

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
- Video-link latency and camera uptilt.
- **Gates, lap timing and a persistent leaderboard** — previously the last item on this list.
- Spawn points with a heading, for the drone and the Line of Sight viewpoint.
- Two-sided gates: a checkpoint is taken from whichever side the drone reaches it.
- **A second map and a second track**, both generated — Rift Quarry and Rift Run — along with the
  toolchain that builds and verifies them, and per-map sky and fog.

### Next
1. **Persistent settings.** Camera, audio, mode, track, pilot name and the leaderboards persist;
   rates, physics parameters and axis mappings still reset on reload — the most disruptive
   remaining gap, since a pilot's rates and radio mapping are exactly what should be remembered.
2. **Commit the test harnesses**, and cover `race.js`, so the invariants stop relying on memory.
3. **Per-motor thrust.** Thrust is currently a single force at the centre of mass. Four forces at
   the arm positions would unlock motor spool-up lag (thrust is instantaneous today), differential
   yaw authority, and prop wash.
4. **Turtle mode.** Flipping an inverted drone by reversing two motors — the feature the project is
   named for. Depends on per-motor thrust.
5. **Race depth.** Two tracks. Sector splits, a ghost or replay to chase, and something to do about
   a skipped gate (today the run simply waits until you go back and take it, from whichever side
   you get there). The board is per-browser `localStorage`, so a shared one would need a backend.
   Now that a map can be generated to fit a course, laying out a third is a layout block and a
   rerun rather than an afternoon of measuring.
6. **Per-map spawn data.** Practice still starts at `(0, 1, 0)`, and the LOS viewpoint is fixed 5 m
   above `y = 0` and 3 m along +Z whichever way the drone faces. Both should come from the map.
   Crash detection and auto-reset belong here too.
7. **Angle / horizon mode.** Acro only at present; a self-levelling mode makes day one possible.
8. **Doppler and propagation delay.** Distance attenuation is in; a delay line whose length
   tracks range would add both the travel delay and Doppler shift on a fast flyby.
