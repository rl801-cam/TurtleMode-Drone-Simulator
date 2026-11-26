# Sponza map: flyable atrium, time trial, autopilot, HUD research (2026-11)

For whoever touches `fly/sponza/` next. [M] = measured on the Iris laptop or in the sim, [S] = sourced
(link given), [E] = estimate or design judgement. Everything else is read from the code or commits.

## What the map is

- `fly/sponza/` (WebGPU only, three r187) is the Sponza atrium flown as a 32 g ducted tiny whoop (1S,
  65 mm). Look follows the three.js `lightprobes_sponza` example: `SunLight` with a static shadow,
  `SkyMesh`, and a `LightProbeGrid` baked from the sun at load so light bounced off the sunlit
  courtyard fills the galleries. Vendored r187 `SunLight` and `MeshletDrawingPipeline` live in `vendor/`.
- Flight is the main sim's own `PhysicsEngine` and `InputHandler` (`js/physics.js`, `js/input.js`) with a
  whoop preset; collision is a `three-mesh-bvh` BVH of the whole model through the main sim's callbacks.
  Race logic reuses `js/race.js` (`RaceManager`), with two opt-in track flags added: `directional` (a gate
  counts only when flown along its normal) and `square` (frame-opening test). Both default off, so main-sim
  tracks are unchanged.
- Files: `index.html` (scene, presets, URL params, bench/flytest/autolap loops), `track.js` (course),
  `timetrial.js` (staging, gates, ghost, sounds), `controls.js` (pilot menu, bindings, rates),
  `autopilot.js` (demo flights). Menu entry: "Sponza atrium (WebGPU, tiny whoop)".
- Sponza is not in the repo (licence does not clearly allow redistribution). `tools/assets/fetch_sponza.sh`
  downloads it into a git-ignored folder, falling back to Khronos's GitHub copy.
- Curtains and banners are not solid: contact drags hard, and a fast hit or lingering tangles the whoop
  (it hangs, then resets). Plants only drag. Space resets, Enter arms, R recovers (see below).
- Recover: respawn on the floor below where the whoop last flew freely (about 1 s back), level, same
  heading, still armed, race clock keeps running. The spawn ray starts below the galleries; it once
  landed custom spawns on the roof.

## Performance on the Iris laptop

Target: Iris Plus G7, 1920x1200, headed Brave, vsync on, sustained 20 s, which is what the pilot sees.

- [M] 31 -> 58 fps on `med`. What did it, in order of use:
  - Direct render to a `scale x window` canvas and let the compositor upscale. Every full-screen pass
    costs real ms here: TRAA ~5 ms, FSR1 ~8 ms, TAAU similar. The AA modes stay in the code for comparison
    (`taa=`, `post`), not as defaults. With TRAA `med` was 31 fps.
  - Depth pre-pass. Sponza is a few huge draw calls, so the PBR shader ran on hidden pixels. Depth first,
    then shade with `<=` and no depth writes. The pre-pass matches each mesh's side and is pushed back
    slightly (otherwise z-fighting specks).
  - Static sun shadow: one directional light, map fitted round the atrium, rendered once. Per-frame CSM was
    pure cost for a static scene.
  - GPU-compressed textures: `tools/assets/dds_encode.py` (numpy BC1/BC3 with mips) plus a glTF plugin
    that swaps them in: ~50 MB instead of ~380 MB.
- [M] Presets: `q=low` 0.67 scale, no MSAA, 2048 shadow, 60 fps; `q=med` 0.8 + MSAA, 58 fps (default);
  `q=high` 1.0 + MSAA, 4096 shadow, 49 fps. `scale=`, `msaa=`, `probes=0`, `shadows=0` override.
- [M] Normal maps must load uncompressed. The "light leaking" under the arches was stray normal-map texels
  from the BC1 encode, tilting far off the surface (sky-blue and black specks). Colour maps stay compressed.
  Debug: `nrm=<scale>`, `holes=1`.
- One frame is drawn with nothing culled before flight, so every pipeline is built up front instead of
  stalling when new parts come into view. The HUD counts frames over 25 ms in the last 5 s.
- Auto-exposure under the roofs. Looks: `warm` (default, yellower sun, exposure 0.85, whites do not clip),
  `agx`, `noon` (original). G cycles and reloads, because bounce light is baked from the sun.
- Bench: `mode=bench` scripted camera with GPU timestamps (`ts`) and frame-time spike counts; publishes
  `window.benchResult`. Take absolute fps headed; headless is for A/B (see 00-decisions, benchmark notes).

## Race course

Source: `track.js` header. Designed from MultiGP track design, RotorHazard and Velocidrone conventions,
then checked with raycasts (`?mode=survey&gates=1` checks every ring and every leg of the line against
the collision mesh; `aisles=1` adds probe grids).

- History: the first course was a flat 35 m oval in the open courtyard (6 gates at 1.5 m). It was replaced
  for the first floor, which is the right
  scale: MultiGP's Universal Time Trial for micro quads is the full-size course scaled 1/4, and this
  building's first floor is about that size.
- [M] Surveyed geometry (metres): gallery floor y 3.32, ceiling 6.8; walkway z 2.0..4.6 (north) and
  -2.0..-5.1 (south); ends x 7.3..10.4 and -11.25..-8.3; courtyard opening |z| < 1.3, x -7.6..6.7 with a
  0.75 m parapet; arcade columns at x about -7.98, -4.95, -1.99, 0.96, 3.94, 6.95. Banners hang below the
  parapet so none are in the way up here. Sun comes in over the opening.
- Layout: one lap of the gallery ring, 8 gates, 3 laps, lap clock starts at the first start/finish
  crossing (holeshot = GO to that crossing, MultiGP). Along the north side the line weaves out through one
  arch window into the sunlit opening, runs about 6 m along it, and returns through another. The arcade is
  paired arches (a thin post between big columns), so each window is 1.1 m wide (sill 4.06, top 6.33);
  window gates sit in their centres, within 25 deg of square. South side is plain corridor. The only sharp
  turns are the four gallery corners (2.6 to 3 m wide).
- Gates: Start (-6.5, 4.32, 3.3); Window out (-2.77, 4.9, 1.7); Sunlit run (0.19, 4.9, 0.3); Window in
  (3.15, 4.9, 1.7); East (8.86, 4.32, 0); South (2.0, 4.32, -3.7); South 2 (-4.5, 4.32, -3.7); West
  (-9.78, 4.32, 0). Spawn on the north-west corner floor, facing along the north walkway.
- Gate size and shape: square, 1 m opening, one-way. MultiGP gates are square (483 mm for Tiny Whutt) [S],
  and real whoop gates are about 0.5 m, so 1 m is deliberately easier. Facing is the `yaw`/`pitch` given
  (tracks.js convention), else from the previous gate to the next.
- `via` points: points the flown line passes before a gate (corners). They exist so the drawn path, the
  autopilot and the clearance check follow the corridors instead of cutting across columns.
- Flow rules used: one continuous line, next gate in view at least about 1 s ahead, no blind descent,
  nothing threaded through cloth.
- Timing and audio (`timetrial.js`): RotorHazard staging, three 440 Hz ticks 1 s apart, a random 1 to 5 s
  hold, then GO at 880 Hz for 0.7 s; whoop held until GO. Gate tick 1 kHz with a pitch ladder; lap chime
  660/990 Hz plus the time spoken; best lap 1200/1800 Hz plus speech. Best lap per track is stored in
  localStorage (split per gate and flown path), replayed as a ghost with the delta flashed at each gate.
- Gate colours: next bright and pulsing, the one after dim cyan, passed grey, wrong-way flashes red with a
  buzz, an edge arrow for an off-screen next gate (Velocidrone). Path line only to the next two gates and
  fading out within 1 m of the camera.
- Removed on purpose: gate numbers and the start/finish label (user rejected them as made up, see
  Pitfalls). The side-view camera-tilt widget was added in f335594 and is also on the rejected list.

## Physics fix: friction budget

- Bug: the friction cone clamped each solver iteration on its own, so with 3 iterations a contact could
  scrub up to 3x the Coulomb limit. Landings and wall scrapes killed momentum.
- Fix (0feb4ab, `js/physics.js`): each contact and manifold tracks the friction impulse already used;
  later iterations only get what is left of the budget. Rule for any future solver change: bound friction
  over all iterations together, not per iteration.
- Whoop defaults (slower than the first pass): TWR 2.3, top speed 6.5 m/s (prop-pitch speed), rates
  center 130, max 520 deg/s (yaw 380), expo 0.45, camera uptilt 15 deg. Pilot sliders save to localStorage.

## Autopilot and offline recorder

For demo footage and for checking the course is flyable by a pilot-equivalent input. It uses only stick
commands, so it exercises the real physics.

- Control (`autopilot.js`): the closed line (via points, lead-in, gate, lead-out) as a centripetal
  Catmull-Rom curve sampled every 2 cm. Speed profile capped by lateral acceleration (default 7 m/s^2) and
  vmax 3.6 m/s, then smoothed to 4 m/s^2 along-track. Position and velocity error give a wanted
  acceleration; plus gravity that is the thrust vector, which sets attitude and throttle (inverse of the
  physics thrust curve with prop inflow loss). Attitude error gives body rates, then sticks through the
  inverse of the Betaflight-style rate curve. Nose points along the line.
- URL params:
  - `mode=autolap`: autopilot flies the time trial live. Ends 3 s after the run finishes or at
    `tEnd` (default 120 s) and publishes `window.benchResult` (laps, holeshot, maxErr, contactFrames,
    snags, fps, longFrames).
  - `mode=autolap&rec=offline`: no live loop. The recorder calls `window.recStep()` which advances the sim
    exactly 1/60 s, so frames are smooth on a slow machine. Sticks, race tones and speech are logged;
    `window.recAudio()` renders them afterwards through an `OfflineAudioContext` with the same motor-sound
    engine. Live audio is off in this mode.
  - Clean plates: `nohud=1` hides the HTML overlays, `nopath=1` hides the path line.
  - `mode=flytest` (scripted climb, hover, wall strike), `mode=survey` (raycast survey), `fakepad=1` (fake
    gamepad for screenshots), `race=0` (free flight), `cam=fpv|chase`, `uptilt`, `fov`, `sun=az,el`.
- Record: `python3 -I tools/bench/brave_cdp.py <repo> record "fly/sponza/index.html?mode=autolap&rec=offline&nohud=1" <outdir> [flags]`
  steps `recStep(i)` and screenshots each frame. Encode frames with ffmpeg; mux the `recAudio()` output.

## Testing

- Headless (default for harness runs): `--headless=new --enable-gpu --ignore-gpu-blocklist`, real iGPU,
  no presentation. Headless without GPU flags is SwiftShader: correctness screenshots only.
- `tools/bench/brave_cdp.py <repo> bench "<path?query>" [flags]` loads a page that publishes
  `window.benchResult` and prints it (`BENCH_SHOT=<png>` for a screenshot, `BENCH_MEM=1` for memory).
  Add `--disable-gpu-vsync --disable-frame-rate-limit` for uncapped rates. Example:
  `bench "fly/sponza/index.html?mode=bench&q=med&w=1920&h=1200"`.
- Headed, real pilot view: `tools/fly.sh [map] [quality]` serves the repo on 127.0.0.1:8765 and opens Brave
  with `--enable-unsafe-webgpu --enable-features=Vulkan` in a separate profile (keeps the controller map).
  `FLY_DEBUG_PORT=9333 tools/fly.sh` also opens DevTools on 127.0.0.1 so tools can check, reload and focus
  tabs; off by default because any local process could drive it.
- WebGPU only. No WebGL fallback work for this map.
- Visual checks of light: full-size crops, not downscaled screenshots; compare to a photo only if pose,
  FOV and sun are matched from EXIF.

## HUD and race UI research

Reference sims: TRYP FPV, DRL Simulator, Liftoff Micro Drones, Velocidrone, Uncrashed; plus racing
games for gate, checkpoint and countdown patterns. Source links only; do not copy their images or assets.

Sources [S]:
- TRYP FPV: https://store.steampowered.com/app/1881200 (community shots: https://steamcommunity.com/app/1881200/screenshots/);
  clips https://www.youtube.com/watch?v=AjE383_wX7w (bando race), https://www.youtube.com/watch?v=y7pJyEoOyMA
  (quarry), https://www.youtube.com/watch?v=m12dBdeXnhE (castle run, 3-2-1).
- DRL Simulator: https://store.steampowered.com/app/641780 ; https://www.youtube.com/watch?v=3-UdaoFFNy0 (time
  trial), https://www.youtube.com/watch?v=Nn8sWw0xybE (Simulator 3 time trials).
- Liftoff: https://store.steampowered.com/app/410340 ; Uncrashed: https://store.steampowered.com/app/1682970 ;
  Velocidrone manual and forum threads (stick setup, per-action binding).
- Other games for patterns: Mario Kart 8 https://www.youtube.com/watch?v=oOHCO4v5K4g (title painted on the
  road, one huge GO glyph), Forza Horizon 5 https://www.youtube.com/watch?v=t0ZBMhldMYo (distance caption
  riding the gate), Trackmania 2020 (checkpoint time appears then fades).

What the sims do:
- TRYP: next gate is a cyan glow halo about 3x the frame with a thin neon frame and a small "N m" distance
  beside it; four corner brackets appear inside ~7 m and thicken as it grows; the gate after next is a thin
  yellow outline, no halo; a passed gate loses all highlight at once and the next marker is already there
  within 0.1 to 0.2 s. Racing line is a thin (2 to 4 px) spline from the drone to the next gate and on toward
  the one after, ahead only, fading by ~25 m, recomputed within 0.1 s of a pass. Timer top-centre with
  millisecond digits. Camera angle shown as a small icon plus "15 deg", bottom-left. Delta pill bottom-centre
  (green fill for ahead, red for behind). Results: medal and time, leaderboard table.
- DRL: minimal HUD (name tag, timer top-right in hundredths), thin red line and red poles at gates, white
  ring gates with red pulses, three-light traffic-signal countdown, one saturated brand colour.
- Liftoff Micro, Uncrashed: thin green racing line, timer top-centre or bottom-left, never a big centred card.
- Velocidrone: gate navigation arrow at the screen edge, top-right text block.
- Common: timer small and not boxed; path is a 2 to 4 px line, not a ribbon; distance caption lives on the
  gate; lap counter is a corner glyph, never a bar.

Timings and motion conventions [M from video frames, 10 fps sheets, so +-0.1 s]:
- Countdown, TRYP bando: READY (0.5 s, orange small caps, ~45% down) cross-fades 0.1 s to SET (0.9 s, slight
  pulse), then GO! (0.5 s, white, ~2x size, with a ~0.15 s orange edge flash). Total 2.1 s, no numbers. Timer
  frozen at 00:00.000 until GO and starts exactly at GO; the drone is already moving.
- Countdown, TRYP run: small white "3", "2", "1" anchored at the gate, ~1 s each, then a large grey outlined
  "GO" fading in ~0.5 s while the drone launches (0 to 21 km/h in 0.6 s).
- Distance label ticks down about 1 m per 0.1 to 0.15 s at 40 to 50 km/h, ~12 px tall at 960 px wide.
- Delta pill: one persistent element, updated at each pass, holds 1.0 to 2.5 s (until the next gate). Swap is
  a blank bar for one frame (0.1 s) then the new text; first show pops in within 0.2 s; it is not scaled.
- Finish: timer freezes, HUD stays ~1.5 s with the camera live, cut to results in ~0.25 s, medal pops with a
  ring pulse (~0.25 s), time slides top-left (~0.5 s), table slides up (~0.5 s). About 2.7 s total.
- Not captured: lap counter, DRL lap and finish screens, Liftoff and Velocidrone in-race timings.

## Design principles reached

1. The pilot looks at the gate, not the HUD. Mid-flight the screen is nearly empty and the building is the
   star. Judge this on a clean plate (`nohud=1`).
2. Information design first, style second. Round 1 failed because every value was always on screen at equal
   weight with a label on each. Each element appears at the moment it answers a question, where the eyes
   already are, then leaves.
3. Moment table (BRIEF_R2): start card (track name, "3 laps", personal best) then READY/SET/GO; flying
   shows the next gate with halo, small distance and corner brackets inside ~7 m, the gate after as a thin
   outline, a hairline path to the next gate only, and a small running clock; gate pass shows one big delta
   (-0.18 green, +0.23 red) low-centre near where the gate was, fading in ~1.5 s; lap complete shows lap
   number, time and delta for ~2 s then shrinks into the clock; finish is one screen with total, lap times,
   best, delta to best and a plan-view trace. Camera angle (icon and "15 deg") and optional stick dots stay
   small in a corner.
4. World-anchored text beats screen-anchored boxes: title and countdown can live at the gate or on the floor
   (Mario Kart 8, TRYP 3-2-1), distance rides the gate (Forza).
5. One accent colour plus white; green and red only for deltas. Legibility by text shadow, not panels,
   because the stone is bright. Tabular figures for timers.
6. No decorative ticks, dots or lines that encode nothing; no tracked small-caps label over every value; no
   middle-dot separators in UI text (commas instead).
7. Anything shown must be backed by a reference. If no reference exists, leave it out.

## Pitfalls (user feedback, do not repeat)

- Gate numbers and an "S/F" start/finish label: rejected as made up with no reference. Removed in ba28068.
- A side-view camera-tilt widget: rejected. Show camera angle the way TRYP does (small icon, "15 deg").
- Looking like TRYP: the Exo 2 italic plus amber treatment was rejected as a knock-off. Borrow behaviour
  (timings, what appears when), not their typography or palette.
- Invented "personality" fonts with neon palettes: rejected as AI-looking.
- Clutter: everything at once with labels (round 1 variants B and C) was called slop. Moment-based, nearly
  empty HUD is preferred.
- Do not ask the user to refresh or reopen pages: use the DevTools port to reload or open the tab.
- Ship UI text with commas, not middle dots.

## Open items

- Final font and palette are not chosen. Constraint: not Exo 2 italic plus amber, not invented neon;
  needs a real reference and has to read on bright warm stone. Candidate OFL fonts were matched to stills in
  the reference study but none is approved.
- HUD rebuild is in progress against the moment table above. The current `#tt` overlay in `timetrial.js`
  and the `controls.js` status line still carry round-1 clutter; replace, do not add.
- Pilot menu uses a Betaflight-like look (amber tabs, rate preview); decide whether it should match the
  new race HUD.
- The autopilot flies at vmax 3.6 m/s, well under the whoop's 6.5 m/s top speed, so its laps are not a
  benchmark for pilots. Ghost and best-lap storage is per browser only.
- Not yet measured: frame cost of the rebuilt HUD.
