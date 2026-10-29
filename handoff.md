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
  are **committed under `vendor/`** and resolved by the `<importmap>` in `index.html`. They used to
  be fetched from unpkg, which meant the simulator could not run offline and went dark whenever
  unpkg did. Refresh them with `node tools/vendor-deps.mjs --force`; the pinned versions live in
  that script.
* **Rendering:** Three.js `0.160.0`
* **Physics:** Cannon-es `0.20.0` — integration only; contacts are custom (see below)
* **Collision geometry:** three-mesh-bvh `0.7.3`
* **Audio:** Web Audio API, fully synthesised
* **Models:** GLTFLoader for `.glb` / `.gltf` maps
* **Map tools:** plain Node under `tools/`, no dependencies at all — the glTF container, the PNG
  textures and the previews are all written by hand. They run offline and ship nothing to the
  browser.

## Architecture & File Structure

* **`index.html`** — entry point. UI overlays (launch menu, pause menu, OSD) and the importmap.
* **`vendor/`** — the committed browser dependencies the importmap points at. Not hand-edited;
  written by `tools/vendor-deps.mjs`.
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
* **`tools/`** — offline map generation, plus two maintenance scripts: `bump-version.mjs` advances
  the cache-busting tags (see *Caching*) and `vendor-deps.mjs` refreshes `vendor/`.
  `generate-rift-quarry.mjs` builds `rift-quarry.glb` and
  the survey the *Rift Run* gates come from; `inspect-glb.mjs` reads any `.glb` back; `lib/` holds
  the glTF writer, the noise, the procedural textures, the clearance checker and a software
  rasteriser for previews. Nothing here is loaded by the page.

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

## The generated map

`bando.glb` was downloaded and the *Bando Gauntlet* gates were then measured against it by eye.
`rift-quarry.glb` works the other way round: it is produced by `tools/generate-rift-quarry.mjs`,
and the racing line is defined in the same constants the geometry is built from.

```
node tools/generate-rift-quarry.mjs                 # writes rift-quarry.glb + the survey
node tools/generate-rift-quarry.mjs --preview out   # ...and renders it from six viewpoints
node tools/inspect-glb.mjs rift-quarry.glb          # reads any .glb back and says what is in it
```

Everything is seeded, so the same source always produces the same map — which matters, because
the gate coordinates in `tracks.js` are surveyed against these triangles. **Do not hand-edit the
`rift-run` gates.** Change the layout block at the top of the generator and regenerate both.

**The generator surveys the course before it writes the file.** All the geometry is in memory, so
every gate ring is sampled round its circumference and every leg of the flown line is walked at
0.4 m intervals, each measured against the nearest triangle by a spatial hash (`lib/clearance.mjs`).
The result is printed as a table and written to `tools/rift-quarry-survey.json`, and the build
*fails* if a ring drops below 0.35 m of clearance or a leg below 1.0 m. That check has already
caught four gates buried in geometry and a racing line that went through a spoil heap and a
pipe-rack leg. It is a straight-line test between waypoints, so it proves the corridor exists —
not that every possible line through it is clean.

**The previews are not decoration either.** `lib/preview.mjs` is a z-buffered software rasteriser
over the same triangle arrays. It found two bugs nothing else would have: the rock arch was wound
inside out — invisible in a single-sided material — and the pipe run was two 26 m vertical poles,
because `addCylinder` builds along +Y and its `yaw` rotates about Y, so no value of it can lay a
cylinder on its side. Both now have self-tests that fail the build.

As shipped: **49.6 MB, 762k triangles, 139 meshes**, of which 23.8 MB is seven embedded PNG
textures. The triangle count is a little under bando's 868k; the file is a little larger because
bando carries no textures at all. Rebuilding takes about 15 s.

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
   Equally, **every path through `generateCollisionBVH()` has to settle that promise.** This is not
   hypothetical: the collider build used to try three-mesh-bvh's `GenerateMeshBVHWorker` first and
   called `worker.terminate()` on all three outcomes, but the wrapper exposes `dispose()` and has no
   `terminate()` — so a `TypeError` fired before `resolve()`, the trailing `.catch()` re-threw on the
   same missing method, and the promise stayed pending for ever. `start()` never got past the
   `await`, so the launch menu sat on "Loading Map..." and the race never began. Browsers that refuse
   to construct a cross-origin worker fell into the outer `catch` and worked fine, which is what made
   it look like an intermittent hang rather than a bug. It is a plain synchronous build now.
7. **The BVH worker cannot be reinstated as-is.** `generateMeshBVH.worker.js` imports the bare
   specifier `three`, and import maps are document-scoped — a worker has no way to resolve it in a
   project with no bundler. It would need a worker with its own absolute-URL imports. There is
   little to gain: the tree takes ~260 ms on the 868k-triangle bando map, against a 45 MB download.
   Note also that `worker.generate()` *transfers* the position and index buffers, so any future
   fallback must re-merge rather than reuse the geometry it handed over — the arrays come back
   detached, and a BVH built on them is silently empty.
8. **Nothing may enter the `PLAYING` state before the map is ready.** `animate()` steps physics on
   that state alone and `checkCollision()` returns null until the BVH exists, so setting it before
   the `await` left the drone free-falling through an empty world for the length of the download and
   starting the race somewhere under the map.
9. **`renderer.resetCamera()` must be the last thing before the flip to `PLAYING`, with no `await`
   between the two.** The menu's orbiting shot in `animate()` runs on every `MENU` frame and writes
   straight into the camera — and in FPV the camera is a child of the drone mesh, so what it writes
   is a *local* transform. Resetting before `await loadMap()` therefore handed every loading frame
   (a 45 MB download plus ~500 ms of collider build) the chance to undo it, and the first flying
   frame looked out from a metre or two off the airframe pointing nowhere near the nose — which
   reads as the drone having spawned in the wrong place, not as a camera fault. Pressing R appeared
   to "fix the spawn" only because by then `MENU` was over and `reset()` re-aimed the camera for
   good. `exit()` has the mirror-image trap: `animate()` syncs the drone mesh only while `PLAYING`,
   so the mesh must be moved back to the origin explicitly or the menu shot orbits the origin while
   the camera hangs off a mesh still sitting at the last crash site.
10. **`renderer.checkCollision()` returns shared scratch state**, invalidated by the next call. Copy
    what you need before querying again.
11. **`updateConfig()` merges nested objects.** `{ wind: { roll: true } }` leaves pitch and yaw
    untouched — correct for the per-axis checkboxes, but a trap in tests and callers that assume a
    full replacement.
12. **Audio has three independent drivers.** Motor noise comes from the stick inputs and is gated
    on arming; wind noise comes from `droneBody.velocity` and deliberately is not, since a
    disarmed drone still falls through air; distance attenuation comes from
    `renderer.getListenerDistance()`, which is zero in FPV because the listener rides the
    airframe. Do not collapse them onto one input. Attenuation sits on the master output so it
    applies to every layer — adding a new layer means routing it through `master`, not to
    `destination`.
13. **The AudioContext must be created from a user gesture.** It is started inside
    `Simulator.start()`, which is reached synchronously from the Start button's click handler. Move
    it and audio silently never plays.
14. **Video latency delays the view only, and only in FPV.** `physics.setInputs()` takes the live
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
15. **Camera uptilt is a positive rotation about the camera's local X.** The camera looks down its
    own −Z, so a positive angle lifts the forward vector to `(0, sin, −cos)` — get the sign wrong
    and the "uptilt" points at the ground. It is applied in exactly one place,
    `renderer.applyFpvUptilt()`, called from construction, `resetCamera()` and `setFpvUptilt()`;
    do not reintroduce a hardcoded angle in `resetCamera`. `setFpvUptilt()` returns the clamped
    value and the UI stores *that*, so the slider can never drift outside the range. One trap in
    `ui.js`: the stored angle is read with `Number.isFinite`, not `|| 10` — 0° is a legitimate
    setting that `||` would silently overwrite.
16. **Turbulence wind is suppressed while the drone is touching a surface**, with a short grace
    period so contact flicker on uneven map geometry does not let it back in. Note the naming: the
    *wind* in `physics.js` is a disturbance torque, while `air*` in `audio.js` is the sound of
    moving through air. They are unrelated.
17. **Gates are parented to `renderer.scene`, never to `environmentGroup`.** The collision BVH is
    built by merging everything under `environmentGroup`, so a gate placed there becomes solid and
    a racing line turns into a lottery. Parenting to the scene also keeps the rings clear of the
    map teardown, which empties `environmentGroup` on every load.
18. **The lap clock times the drone, not the picture.** `race.update()` is handed
    `physics.droneBody.position`, never the delayed pose out of `latency.js`. Feed it the video
    feed and a lap time starts depending on the latency slider.
19. **A crossing counts from either side, but only inside the radius, and only on the armed gate.**
    Two-sided detection is safe *because* just one gate is live at a time and taking it advances the
    run past it — that is what used to be bought by the direction test, and if a future change ever
    arms more than one gate at once (sector splits, missed-gate recovery), the machine-gunning it
    used to prevent comes straight back and needs a cooldown or a re-arm rule of its own. The radial
    test is untouched and non-negotiable: drop it and the entire infinite plane counts as a gate.
20. **`RACE_SPEC` clobbers the physics config, so practice has to put it back.** A practice start
    calls `ui.applyPracticeConfig()`, which pushes every practice control's current DOM value into
    the engine. Skip it and a pilot who has raced once flies the spec drone while the sliders read
    like their own settings.
21. **Gate coordinates in `tracks.js` are survey data.** They were measured against the `bando.glb`
    collision mesh, several sit inside openings a metre or two across, and the smallest rings
    (`radius: 0.62`, under the solar array) have centimetres to spare. Moving a gate half a metre
    is likely to bury it in a wall, a panel or the first-floor slab. Re-measure before editing.
22. **One yaw convention, shared by gates and spawn.** 0° faces −Z (the way the airframe points
    with an identity quaternion) and +90° faces +X. `tracks.js` builds a gate normal as
    `(sin y·cos p, sin p, −cos y·cos p)`; `physics.setSpawn()` matches it with a rotation of
    *minus* yaw about +Y. Change one and the drone spawns facing away from the first gate.
23. **Sky colour and fog are per map, in `MAP_ENV` in `renderer.js`.** Anything without an entry
    keeps the original 20–100 m fog, which is right for the bando — a building you fly around
    inside — and wrong for a 300 m quarry, where it hides the far wall, the ravine and the whole
    basin rim behind a hundred metres of haze. Practice still starts at `(0, 1, 0)` whatever map is
    loaded, so a new map has to have solid ground just under the origin or the drone starts by
    falling; the quarry's apron is flat `y = 0` there for exactly that reason.
24. **Terrain quads must be split along the diagonal joining the closer pair of heights.**
    Alternating the diagonal in a checker pattern — the obvious way to avoid a directional grain —
    corrugates every steep face, because one orientation lays a ridge across the slope and the
    other a groove. On the quarry's 62° bench walls that came out as a row of sawtooth teeth about
    a metre apart, in the silhouette as well as the shading.
25. **A single-sided material makes winding load-bearing.** Terrain, rock, ground, concrete and the
    yard are single-sided, so a face wound the wrong way is not merely mis-lit, it is *gone*. The
    arch band is the one piece whose winding is not obvious from the code — its faces are built
    about the ring's own (span, up, dir) frame and the intuitive order faces into the stone — so it
    has its own check, `verifyArch()`. Add geometry of that shape and check it the same way.
26. **Nothing scattered may land in the racing corridor.** Boulders, spoil heaps, light masts and
    the rim berm are all filtered against the racing line before placement. The line is built first
    for that reason, and `LINE_XZ` has to be set before any of them run.
27. **Every map swap must dispose the map it replaces.** Three.js does not reference-count GPU
    resources: removing a mesh from the scene graph leaves its buffers and textures allocated until
    something calls `dispose()`. `buildMap()` used only to detach the children, so each swap through
    the launch menu stranded an entire map's worth of VRAM — at bando's 43.6 MB over 848 meshes, a
    few swaps was enough to lose the WebGL context. `disposeEnvironment()` and `disposeCollider()`
    now run before anything new is built. The collider matters as much as the scene: it is a second
    full copy of the geometry merged into one buffer, and its BVH is a large typed-array structure
    that `geometry.dispose()` does not touch — `disposeBoundsTree()` is a separate call.
28. **Anything that binds a key must check whether the user is typing.** `input.js`'s keyboard
    fallback had no such guard, so entering a pilot name flew the drone: the W, A, S and D in a name
    drove throttle and yaw and the space bar toggled the arm switch. Both `main.js` and `input.js`
    now bail out when `document.activeElement` is a form control.
29. **The arrow keys belong to the camera.** Uptilt on ↑/↓ is documented in the launch menu *and*
    the OSD. The keyboard flight fallback used to bind the same keys to pitch and roll, so an arrow
    press did both at once; pitch and roll are on **I/K** and **J/L** now. Anything new wanting the
    arrows has to take them from the camera first, and update both strings in `index.html`.

## Caching — read this before debugging "my change did nothing"

`index.html` and the imports in `main.js` carry a `?v=N` tag, and the build is logged to the
console and shown under the Start button. **`index.html` itself is not versioned**, so a browser
holding a stale copy keeps requesting the old module versions and none of the tags help. If the
build stamp does not match, hard-reload (`Ctrl+Shift+R`) before investigating anything else.

**Do not bump the tags by hand.** There are twelve of them across three files and they must all
read the same number; missing one produces the worst failure this project has — a page running a
mixture of old and new modules, which looks exactly like a bug in whatever you just changed.

```bash
node tools/bump-version.mjs           # advance to the next version
node tools/bump-version.mjs 42        # set an explicit version
node tools/bump-version.mjs --check   # print the current version, or exit 1 if files disagree
```

**Current build: `v30`** — the tags live in `index.html` (stylesheet and the `main.js` script), the
import list at the top of `main.js`, the `tracks.js` import in `ui.js`, and the `BUILD` constant in
`main.js`. `--check` exits non-zero if they have drifted apart, which is worth running before
committing.

`vendor/` is deliberately **not** versioned this way. Those files change only when a dependency is
deliberately updated, and their URLs change with it.

## Key Milestones & Solved Problems

1. **Framerate-independent physics.** Thrust was originally tied to the visual framerate — no lift
   at 60 fps, launching at 144 fps. Solved by injecting inputs into Cannon-es's internal sub-step
   cycle via `preStep`.
2. **Custom map loading.** Local `.glb`/`.gltf` upload straight into the map selector via
   `URL.createObjectURL(file)`, no backend.
3. **Lighting overhaul.** `HemisphereLight` plus tuned directional shadow bounds, eliminating
   pitch-black shadows and clipping on large maps.
4. **Environment collision.** Previously the top open item. Map geometry is merged and built into a
   BVH on the main thread, and the drone collides with everything.
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
14. **A generated map and a second track.** *Rift Quarry* — a 300 m terraced quarry basin with a
    plant yard, a shed you fly through end to end, a conveyor to duck under, four benches spiralling
    22 m down to the pit floor, a bored adit through a rock plug, and a 93 m ravine climbing back to
    the yard under a natural arch. The course on it, **Rift Run**, is 17 gates and about 422 m a lap.
    Both come out of `tools/generate-rift-quarry.mjs` (see *The generated map*), which is also the
    first thing in this project that verifies a course automatically rather than by flying it.
15. **Dependencies vendored, and the version bump automated.** `vendor/` now holds the five files
    the importmap resolves — three.js `r160`, its `GLTFLoader` and `BufferGeometryUtils` addons,
    cannon-es and three-mesh-bvh — so the sim runs offline and no longer depends on unpkg being up.
    The import graph closes on itself; adding a new addon means vendoring whatever it imports too,
    or the page dies on a bare specifier the importmap cannot resolve. Alongside it,
    `tools/bump-version.mjs` replaced the twelve-tags-by-hand ritual.
16. **Map disposal, frame pacing, render scale and load feedback.** Four independent defects, all
    fixed together (see invariant 27 and *Caching*):
    * Map swaps leaked every previous map's GPU memory.
    * The FPS limiter compared elapsed time against a whole frame interval, which discards any
      frame arriving fractionally early — with the cap set to the monitor's own refresh rate, vsync
      jitter tripped that test roughly every other frame and a 60 fps cap ran at **30**. It now
      tracks a deadline and allows half a *display* frame of slack, measured live.
    * `setPixelRatio()` took the raw device ratio, so a 3× panel rendered nine times the pixels of
      a 1× one. Capped at 2.
    * `GLTFLoader`'s `onProgress` argument was `undefined`, so tens of megabytes downloaded with no
      feedback whatsoever. The Start button now shows a percentage, then `Building Collision...`
      during the BVH build — which needs two `requestAnimationFrame`s before it, or the message
      never reaches the glass ahead of the blocking work it is announcing.

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

**Checking map disposal (invariant 27).** GPU leaks are invisible to source review, so this one is
measured rather than argued. `WebGLRenderer.info.memory.geometries` only ever decrements on an
explicit `dispose()`, so loading maps in turn and reading the count after each is a direct test:
serve the project, drive `renderer.loadMap()` from a page that iframes `index.html` (the running sim
is on `window.simulator` for exactly this reason), and watch the counter across a swap. Fixed, it
returns to the same number for the same map; leaking, it can only climb:

```
placeholder=22  ->  bando=852  ->  quarry=137  ->  bando=852     clean
placeholder=22  ->  bando=874  ->  quarry=1011 ->  bando=1863    leaking
```

The same page verifies the load-progress callback, which reports `download` then `collision` for
each map. This harness is not committed either.

The map generator is the exception: its checks *are* committed and run every time it builds.
`selfTest()` asserts that boxes, cylinders and tubes come out facing outwards, `verifyArch()` that
the arch does, `verifyGLB()` re-reads the finished file and validates the container, and the course
survey fails the build if a gate no longer fits. None of that covers `race.js`, which is still the
gap that matters most.

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
8. **Race depth.** Two tracks, but no sector splits, no missed-gate handling (skip a gate and the
   run simply waits for you to come back and take it, from whichever side you reach it), and no
   ghost or replay — the obvious next rung of the training loop. There is deliberately no wrong-way
   rule left to implement at the gate itself, since a gate no longer has a right way through; any
   future wrong-way detection would have to work off the drone's progress round the course instead.
   The board is per-browser `localStorage`, so "track record" means this browser's record.
10. **Map download size and draw load.** `rift-quarry.glb` is 49.6 MB against bando's 43.6 MB, and
    both are uncompressed on disk — but **that is not what goes over the wire**. GitHub Pages
    gzips them at the edge, measured at 43.6 MB → 7.5 MB for bando (`Content-Encoding: gzip`,
    `Content-Length: 7472165`). These files are mostly float32 vertex attributes and compress
    extremely well, so transfer size is already close to what Draco or meshopt would achieve, and
    neither is worth a build step and a decoder for the download alone. Note the compression is the
    *host's* doing and cannot be configured from the repo; a different host may not do it.

    **Draw load is now the bigger problem, and it is untouched.** bando is 848 meshes sharing 8
    materials — roughly 852 draw calls a frame, and again for the shadow map — which merging by
    material would cut to 8. That, not file size, is the next real win on these maps. Two things
    about the quarry are worth knowing: 23.8 MB of it is embedded PNG,
    which is the single easiest thing to trade away (the sizes are one line at the top of the
    generator), and the terrain is split into 8×8 tiles per material specifically so Three.js can
    frustum-cull it. Left as one sheet the ground was submitted whole every frame, and again for
    the shadow map. There is no LOD and no occlusion culling on either map.
9. **Gate detection samples once per rendered frame**, off a straight segment between positions,
   rather than per physics sub-step. It cannot miss a plane, but the straight-line approximation
   coarsens on a tight arc through a 0.62 m ring at a low frame rate. Related: the off-screen gate
   pointer is computed in `updateRace()` *before* `renderer.updateDrone()`, so it trails the
   rendered picture by exactly one frame.

---
*End of Handoff Document*
