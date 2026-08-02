# TurtleMode Simulator - Developer Handoff Document

Context, architecture, and the state of play for anyone — human or AI agent — picking this project
up. Read [`project_plan.md`](project_plan.md) alongside it for the feature-level view.

## Project Overview

TurtleMode Simulator is a web-based FPV drone simulator running entirely in the browser. It focuses
on realistic flight physics, Gamepad API support for real RC transmitters, and behaviour that holds
up across framerates.

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
* **`js/ui.js`** — DOM bindings, menus, slider-to-physics wiring, custom map upload.
* **`js/audio.js`** — synthesised motor and prop noise.
* **`js/latency.js`** — artificial video-link delay. Pure and DOM-free, so it tests directly.

### Default configuration
Mass `0.5 kg` · Max thrust `25 N` (~5:1 TWR, hover near 20% throttle) · Air drag `0.5` ·
Restitution `0.2` · Surface grip `0.2` · Wind `0.1` on all three axes · Video latency `0 ms`.

Defaults live in **two places that must agree**: `params` in `physics.js` and the `value=`
attributes plus readout spans in `index.html`. There is no persistence layer, so these are what
every session starts with.

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
12. **Turbulence wind is suppressed while the drone is touching a surface**, with a short grace
    period so contact flicker on uneven map geometry does not let it back in. Note the naming: the
    *wind* in `physics.js` is a disturbance torque, while `air*` in `audio.js` is the sound of
    moving through air. They are unrelated.

## Caching — read this before debugging "my change did nothing"

`index.html` and the imports in `main.js` carry a `?v=N` tag, and the build is logged to the
console and shown under the Start button. **`index.html` itself is not versioned**, so a browser
holding a stale copy keeps requesting the old module versions and none of the tags help. If the
build stamp does not match, hard-reload (`Ctrl+Shift+R`) before investigating anything else. Bump
every tag and `BUILD` together after editing any module.

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

## Verification

`physics.js` and `audio.js` are deliberately free of DOM dependencies so they can be driven
headlessly under Node — against synthetic collision callbacks and a stubbed Web Audio API
respectively. Harnesses covering landing and settling, wall and corner strikes, restitution
accuracy, friction, wedged contacts, tunnelling at racing speed, wind gating, and the audio
mapping were used throughout development and all pass.

**They are not currently committed to this repository.** Re-creating them, or committing the
existing ones under `tests/`, is the single cheapest way to protect the invariants listed above —
most of them are exactly the kind of thing a well-meaning refactor quietly breaks.

## Known Limitations & Next Steps

1. **Persistent storage.** Only camera mode, LOS zoom, speed readout and audio persist. Rates,
   physics parameters and axis mappings reset on reload — the most disruptive gap, since a pilot's
   rates and radio mapping are precisely what should be remembered. `localStorage` in `ui.js` and
   `input.js`.
2. **Commit the test harnesses** (see Verification).
3. **Per-motor thrust.** Thrust is a single force at the centre of mass. Four forces at the arm
   positions would unlock motor spool-up lag (thrust is instantaneous today), differential yaw
   authority, and prop wash.
4. **Turtle mode.** Flipping an inverted drone by reversing two motors — the feature the project is
   named for, and still absent. Depends on per-motor thrust.
5. **Spawn points and crash flow.** Spawn is hard-coded to `(0, 1, 0)` in `physics.js`, and the LOS
   camera assumes ground at `y = 0`; a map whose floor sits elsewhere would leave the viewpoint
   floating or buried. Per-map spawn points fix both. No crash detection or auto-reset yet.
6. **Angle / horizon mode.** Acro only; a self-levelling mode makes day one possible.
7. **Doppler and propagation delay.** Distance attenuation is in; a delay line whose length
   tracks range would add both the travel delay and the Doppler shift on a fast flyby.
8. **Gates and lap timing**, then replay/ghost — the training loop the simulator is ultimately for.

---
*End of Handoff Document*
