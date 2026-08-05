# TurtleMode Simulator - Developer Handoff Document

Context, architecture, and the state of play for anyone — human or AI agent — picking this project
up. Read [`project_plan.md`](project_plan.md) alongside it for the feature-level view.

## Project Overview

TurtleMode Simulator is a web-based FPV drone simulator running entirely in the browser. It focuses
on realistic flight physics, Gamepad API support for real RC transmitters, and behaviour that holds
up across framerates.

It runs in two modes. **Practice** is free flight with every parameter on a slider. **Race** locks
the airframe to a fixed spec and times laps round a gated course, with a persistent leaderboard.

### Tech Stack
* **Core:** Vanilla HTML, CSS, JavaScript (ES modules). No bundler, no `npm install` — dependencies
  arrive via an `<importmap>` from unpkg.
* **Rendering:** Three.js `0.160.0`
* **Physics:** Cannon-es `0.20.0` — integration only; contacts are custom (see below)
* **Collision geometry:** three-mesh-bvh `0.7.3`
* **Audio:** Web Audio API, fully synthesised
* **Models:** GLTFLoader for `.glb` / `.gltf` maps

## Architecture & File Structure

* **`index.html`** — entry point. UI overlays (launch menu, pause menu, OSD) and the importmap.
* **`css/style.css`** — glass-panel UI, flexbox layouts, OSD.
* **`js/main.js`** — central controller. `requestAnimationFrame` loop, game state
  (`MENU` / `PLAYING` / `PAUSED`), module wiring, and the collision callbacks handed to physics.
* **`js/physics.js`** — Cannon-es world, flight model, and the contact solver.
* **`js/renderer.js`** — Three.js scene, both cameras, map loading, and the BVH collision queries
  the physics engine calls into.
* **`js/input.js`** — Gamepad API, axis mapping, deadband, reversing, arm switch.
* **`js/ui.js`** — DOM bindings, menus, slider-to-physics wiring, custom map upload, mode switch,
  leaderboard rendering and the race HUD.
* **`js/audio.js`** — synthesised motor and prop noise.
* **`js/latency.js`** — artificial video-link delay. Pure and DOM-free, so it tests directly.
* **`js/race.js`** — gate meshes, crossing detection, the lap clock, and the `localStorage`
  leaderboard.
* **`js/tracks.js`** — course data (gate positions, radii, spawn) and the fixed racing spec.

### Default configuration
Mass `0.5 kg` · Max thrust `25 N` (~5:1 TWR, hover near 20% throttle) · Air drag `0.5` ·
Restitution `0.2` · Surface grip `0.2` · Wind `0.1` on all three axes · Video latency `0 ms` ·
Camera uptilt `10°` · Default map `Bando`.

Defaults live in **three places that must agree**: `params` in `physics.js`, the `value=`
attributes plus readout spans in `index.html`, and `RACE_SPEC` in `tracks.js` — which is also
printed as a spec sheet in the launch menu, in a fourth place, by hand.

### What persists
`localStorage` holds camera mode, LOS zoom, camera uptilt, speed readout, audio, game mode,
selected track, pilot name and the per-track leaderboards. **Rates, physics parameters and axis
mappings do not** — they come from the HTML defaults on every load.

## How the physics actually works

Cannon-es integrates the rigid body, but **its narrowphase is not used**. There is no floor plane
and no `Trimesh`; map geometry is merged into a single BVH and contacts are resolved by hand in a
`postStep` listener. The flow per sub-step (fixed 120 Hz):

1. `preStep` — thrust, rate-controller torque, and wind are applied. This is what makes flight
   framerate-independent: forces go in immediately before each internal integration step rather
   than once per rendered frame.
2. Cannon integrates.
3. `postStep` — `resolveCollisions()` runs continuous collision detection, gathers contacts,
   corrects penetration, and applies impulses.

## How racing works

`race.js` owns the gates, the clock and the board; `tracks.js` is data only. Starting a race loads
the track's own map (the gates were surveyed against that geometry and mean nothing anywhere else),
overwrites the physics config with `RACE_SPEC`, and moves both the drone's spawn and the Line of
Sight viewpoint to the start grid.

**A gate is a plane with a radius.** Every frame, `RaceManager.update()` takes the segment from last
frame's position to this one and asks `testGate()` whether it passed through the disc. The two ends
of the segment only have to land on *opposite* sides of the plane: **a gate counts from either
side**, so a line that arrives at a ring the other way round is a line and not a fault. The normal
is now purely the ring's orientation — what the disc is perpendicular to — and no longer picks a
side, which also means a gate lying flat in a floor opening (`pitch: ±90`) counts on the way up and
on the way down alike.

**Only the gate the run is waiting on is ever armed.** That single fact is what keeps two-sided
crossings honest: the first crossing advances `nextGate`, the ring behind you goes cold, and a drone
bouncing about in a ring cannot machine-gun it. The order of the gates is still the whole of the
course — it is the *direction through each ring* that has stopped mattering, not the sequence.

**The clock is trimmed to the crossing, not the frame.** `testGate()` returns the fraction along the
segment at which the plane was crossed, and both the start gate and each lap boundary subtract the
unused remainder of that frame. Without it, times quantise to the frame interval and a 144 Hz
machine posts systematically different laps from a 60 Hz one.

**Events, not callbacks.** `update()` queues `start` / `gate` / `lap` events and `main.js` drains
them with `consumeEvents()` each frame, turning them into HUD toasts and a leaderboard re-render.
`race.js` therefore never touches the menus.

**The leaderboard is `localStorage`**, one key per track (`turtlemode.leaderboard.<trackId>`),
one row per pilot holding their fastest lap, 25 stored and 10 shown. It is read defensively — a
hand-edited or half-written store is filtered rather than trusted. It is also per-browser, so
"track record" means this browser's record.

`clearTrack()` disposes the ring geometry, the ring material, and both the sprite material and its
canvas texture. Labels are canvas textures, so dropping the group without disposing them leaks a
texture per gate on every track change.

## Invariants — break these and the sim misbehaves in non-obvious ways

Each of these was found the hard way. They are load-bearing.

1. **Contact points must stay coplanar with the centre of mass (`y = 0`).** Offsetting them
   vertically gives every head-on wall strike a lever arm about the CoM, and the drone tumbles
   backwards off flat walls it should bounce squarely off.
2. **Contacts are solved per *manifold*, not per contact point.** Five contacts over-constrain
   three degrees of freedom; Gauss-Seidel cannot settle that between sub-steps, so every landing
   jitters (~0.5 rad/s, and more iterations do not help). The asymmetric friction ordering also
   tumbles square-on impacts. Group contacts by surface normal and solve one equivalent contact at
   each manifold's centroid.
3. **…but a manifold solved at its centroid cannot resist rotation about an axis through that
   point.** Without the rolling-resistance pass, a drone left lying tilted rocks on its edge
   forever (it was 1.76 rad/s indefinitely, disarmed). The flight controller masks this when
   armed, so *always test crash behaviour disarmed*.
4. **Restitution is applied once per manifold, after the approach has been stopped.** Feeding a
   separating target into the iterative solver lets contacts separate early and freezes whatever
   spin has accumulated into the result — square-on impacts came out at 13.7 rad/s.
5. **`ccdThreshold` must never exceed the smallest contact radius.** A contact sphere further than
   its radius from a surface is invisible to the sphere check, so a longer sub-step can start
   outside the check and land on the *far side* of a surface, where the closest-point normal flips
   and the solver pushes the drone further through. It is derived from the contact radii for this
   reason — do not hard-code it.
6. **`loadMap()` must return the in-flight promise for a map already loading.** Nothing else holds
   the drone up; if `start()` stops awaiting a ready BVH, the drone falls through the world.
7. **`renderer.checkCollision()` returns shared scratch state**, invalidated by the next call. Copy
   what you need before querying again.
8. **`updateConfig()` merges nested objects.** `{ wind: { roll: true } }` leaves pitch and yaw
   untouched — correct for the per-axis checkboxes, but a trap in tests and callers that assume a
   full replacement.
9. **Audio has three independent drivers.** Motor noise comes from the stick inputs and is gated
    on arming; wind noise comes from `droneBody.velocity` and deliberately is not, since a
    disarmed drone still falls through air; distance attenuation comes from
    `renderer.getListenerDistance()`, which is zero in FPV because the listener rides the
    airframe. Do not collapse them onto one input. Attenuation sits on the master output so it
    applies to every layer — adding a new layer means routing it through `master`, not to
    `destination`.
10. **The AudioContext must be created from a user gesture.** It is started inside
   `Simulator.start()`, which is reached synchronously from the Start button's click handler. Move
   it and audio silently never plays.
11. **Video latency delays the view only, and only in FPV.** `physics.setInputs()` takes the live
    sticks and the solver runs live — the drone is genuinely where the physics says, the pilot
    just finds out late, which is the whole point. The delay is applied to the pose handed to
    `renderer.updateDrone()`, and in FPV the camera is a child of the drone mesh, so delaying the
    mesh delays the picture exactly. In Line of Sight the mesh must stay live: the pilot is
    watching the real airframe with their own eyes and there is no feed to lag. Audio stays live
    for the same reason. Two further traps: `VideoDelay.push()` copies the components out because
    the physics body mutates its position and quaternion in place — holding the object would make
    every stored frame the current one and the delay would silently do nothing; and attitude is
    interpolated with shortest-arc slerp, since componentwise blending of quaternions leaves an
    unnormalised one that shears the whole picture. The buffer is cleared on reset, or the view
    replays the old flight after the teleport.
12. **Camera uptilt is a positive rotation about the camera's local X.** The camera looks down its
    own −Z, so a positive angle lifts the forward vector to `(0, sin, −cos)` — get the sign wrong
    and the "uptilt" points at the ground. It is applied in exactly one place,
    `renderer.applyFpvUptilt()`, called from construction, `resetCamera()` and `setFpvUptilt()`;
    do not reintroduce a hardcoded angle in `resetCamera`. `setFpvUptilt()` returns the clamped
    value and the UI stores *that*, so the slider can never drift outside the range. One trap in
    `ui.js`: the stored angle is read with `Number.isFinite`, not `|| 10` — 0° is a legitimate
    setting that `||` would silently overwrite.
13. **Turbulence wind is suppressed while the drone is touching a surface**, with a short grace
    period so contact flicker on uneven map geometry does not let it back in. Note the naming: the
    *wind* in `physics.js` is a disturbance torque, while `air*` in `audio.js` is the sound of
    moving through air. They are unrelated.
14. **Gates are parented to `renderer.scene`, never to `environmentGroup`.** The collision BVH is
    built by merging everything under `environmentGroup`, so a gate placed there becomes solid and
    a racing line turns into a lottery. Parenting to the scene also keeps the rings clear of the
    map teardown, which empties `environmentGroup` on every load.
15. **The lap clock times the drone, not the picture.** `race.update()` is handed
    `physics.droneBody.position`, never the delayed pose out of `latency.js`. Feed it the video
    feed and a lap time starts depending on the latency slider.
16. **A crossing counts from either side, but only inside the radius, and only on the armed gate.**
    Two-sided detection is safe *because* just one gate is live at a time and taking it advances the
    run past it — that is what used to be bought by the direction test, and if a future change ever
    arms more than one gate at once (sector splits, missed-gate recovery), the machine-gunning it
    used to prevent comes straight back and needs a cooldown or a re-arm rule of its own. The radial
    test is untouched and non-negotiable: drop it and the entire infinite plane counts as a gate.
17. **`RACE_SPEC` clobbers the physics config, so practice has to put it back.** A practice start
    calls `ui.applyPracticeConfig()`, which pushes every practice control's current DOM value into
    the engine. Skip it and a pilot who has raced once flies the spec drone while the sliders read
    like their own settings.
18. **Gate coordinates in `tracks.js` are survey data.** They were measured against the `bando.glb`
    collision mesh, several sit inside openings a metre or two across, and the smallest rings
    (`radius: 0.62`, under the solar array) have centimetres to spare. Moving a gate half a metre
    is likely to bury it in a wall, a panel or the first-floor slab. Re-measure before editing.
19. **One yaw convention, shared by gates and spawn.** 0° faces −Z (the way the airframe points
    with an identity quaternion) and +90° faces +X. `tracks.js` builds a gate normal as
    `(sin y·cos p, sin p, −cos y·cos p)`; `physics.setSpawn()` matches it with a rotation of
    *minus* yaw about +Y. Change one and the drone spawns facing away from the first gate.

## Caching — read this before debugging "my change did nothing"

`index.html` and the imports in `main.js` carry a `?v=N` tag, and the build is logged to the
console and shown under the Start button. **`index.html` itself is not versioned**, so a browser
holding a stale copy keeps requesting the old module versions and none of the tags help. If the
build stamp does not match, hard-reload (`Ctrl+Shift+R`) before investigating anything else. Bump
every tag and `BUILD` together after editing any module.

**Current build: `v24`** — the tags live in `index.html` (stylesheet and the `main.js` script), the
import list at the top of `main.js`, the `tracks.js` import in `ui.js`, and the `BUILD` constant in
`main.js`. All of them must read the same number.

## Key Milestones & Solved Problems

1. **Framerate-independent physics.** Thrust was originally tied to the visual framerate — no lift
   at 60 fps, launching at 144 fps. Solved by injecting inputs into Cannon-es's internal sub-step
   cycle via `preStep`.
2. **Custom map loading.** Local `.glb`/`.gltf` upload straight into the map selector via
   `URL.createObjectURL(file)`, no backend.
3. **Lighting overhaul.** `HemisphereLight` plus tuned directional shadow bounds, eliminating
   pitch-black shadows and clipping on large maps.
4. **Environment collision.** Previously the top open item. Map geometry is merged and built into a
   BVH (in a Web Worker, with a main-thread fallback), and the drone collides with everything.
5. **Crash physics.** Five contact spheres, manifold grouping, Coulomb friction, rolling
   resistance, restitution, and swept CCD — corner strikes spin the drone, flat strikes bounce
   square, and landed drones settle. See the invariants above.
6. **Line of Sight camera.** Fixed viewpoint near spawn that tracks the drone, with a visible
   airframe, distance readout, and `C` to toggle in flight.
7. **Wind.** Low-pass filtered per-axis disturbance torque, suppressed on the ground.
8. **Audio.** Synthesised chopped prop noise driven by the stick inputs, an airspeed-driven wind
   layer so speed is audible on its own, and distance attenuation in Line of Sight.
9. **Video latency.** Adjustable 0–200 ms FPV feed delay. The view lags; the controls and the
   physics do not.
10. **Camera uptilt.** 0–60°, default 10°, from the menu slider or the ↑/↓ arrow keys in flight.
11. **Spawn points.** `physics.setSpawn()` and `renderer.setSpawnPoint()` place the drone and the
    Line of Sight viewpoint anywhere, with a heading. Practice still starts at the origin; a race
    starts on the track's grid, lined up with the first gate.
12. **Race mode.** Gated courses with sub-frame lap timing, a fixed spec class, a persistent
    per-track leaderboard, and a HUD with a timer, next-gate readout and an off-screen gate
    pointer. One track so far: *Bando Gauntlet*, 17 gates, about 304 m a lap.
13. **Two-sided gates.** A gate is taken from whichever side the drone arrives on. Directional
    crossings had been rejecting perfectly good lines — overshoot a ring, swing back through it and
    the run would sit there refusing to count it until you had gone round and re-taken it the "right"
    way. Arming one gate at a time already prevents the repeat crossings the direction test was
    there to stop, so the test bought nothing but frustration.

## Verification

`physics.js`, `audio.js` and `latency.js` are deliberately free of DOM dependencies so they can be
driven headlessly under Node — against synthetic collision callbacks and a stubbed Web Audio API
respectively. Seven harnesses, **165 checks**, covering landing and settling, wall and corner
strikes, restitution accuracy, friction, wedged contacts, tunnelling at racing speed, wind gating,
the audio mapping, video-link delay, and the camera uptilt convention. All passed when they were
written.

Every harness reads the **shipped** file and none keeps a copy — a stale copy asserts against code
that no longer exists, and one here produced four false results before it was caught. Two details
make that work: `physics.js` reaches `cannon-es` through the browser's import map, so its shipped
source is rewritten next to `node_modules` on every run rather than imported in place; and
`renderer.js`/`ui.js` cannot be imported at all under Node, so the method under test is lifted out
of the shipped source and executed — a rename breaks the extraction and fails the test instead of
quietly passing.

**They are not committed to this repository**, so nothing above can be re-run as it stands, and
they predate race mode: `race.js` and `tracks.js` have no coverage at all. `race.js` cannot be
imported under Node either (canvas labels, `localStorage`), so `testGate()` and the lap-clock
arithmetic would need the same lift-the-method-out treatment as `renderer.js` — worth doing, since
gate detection is pure geometry and exactly the kind of thing that is silently wrong.

Committing these under `tests/` remains the single cheapest way to protect the invariants above.

## Known Limitations & Next Steps

1. **Persistent storage.** Camera mode, LOS zoom, camera uptilt, speed readout, audio, game mode,
   track, pilot name and the leaderboards persist. Rates, physics parameters and axis mappings
   still reset on reload — the most disruptive gap, since a pilot's rates and radio mapping are
   precisely what should be remembered. `localStorage` in `ui.js` and `input.js`.
2. **Commit the test harnesses**, and write one for `race.js` (see Verification).
3. **Per-motor thrust.** Thrust is a single force at the centre of mass. Four forces at the arm
   positions would unlock motor spool-up lag (thrust is instantaneous today), differential yaw
   authority, and prop wash.
4. **Turtle mode.** Flipping an inverted drone by reversing two motors — the feature the project is
   named for, and still absent. Depends on per-motor thrust.
5. **Spawn and crash flow.** Spawn points exist, but practice is still hard-coded to `(0, 1, 0)` in
   `main.js`, and the LOS viewpoint is still 5 m above `y = 0` and 3 m along +Z regardless of which
   way the drone is facing — a map whose floor sits elsewhere leaves the pilot floating or buried,
   and a grid facing +X puts them off to one side. Per-map spawn data and a spawn-relative LOS
   offset fix both. There is still no crash detection or auto-reset.
6. **Angle / horizon mode.** Acro only; a self-levelling mode makes day one possible.
7. **Doppler and propagation delay.** Distance attenuation is in; a delay line whose length
   tracks range would add both the travel delay and the Doppler shift on a fast flyby.
8. **Race depth.** One track, and no sector splits, no missed-gate handling (skip a gate and the run
   simply waits for you to come back and take it, from whichever side you reach it), and no ghost or
   replay — the obvious next rung of the training loop. There is deliberately no wrong-way rule left
   to implement at the gate itself, since a gate no longer has a right way through; any future
   wrong-way detection would have to work off the drone's progress round the course instead. The
   board is per-browser `localStorage`, so "track record" means this browser's record.
9. **Gate detection samples once per rendered frame**, off a straight segment between positions,
   rather than per physics sub-step. It cannot miss a plane, but the straight-line approximation
   coarsens on a tight arc through a 0.62 m ring at a low frame rate. Related: the off-screen gate
   pointer is computed in `updateRace()` *before* `renderer.updateDrone()`, so it trails the
   rendered picture by exactly one frame.

---
*End of Handoff Document*
