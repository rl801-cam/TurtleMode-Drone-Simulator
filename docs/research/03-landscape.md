# FPV sim landscape and low-footprint web 3D (research, 2026-11-25)

Sub-agent web research, condensed. Tags: [P] primary source read, [S] secondary, [M] model
memory, unverified. Star counts and last-push dates are from the GitHub API on the day.

## Verdict

- Stay in the browser. Native's measurable advantages are about one frame of input latency and
  CPU headroom, not GPU speed or RAM. No same-app native-vs-WebGPU RAM comparison exists anywhere.
- The niche is open but filling: at least three browser sims now run real Betaflight compiled
  to wasm, one on WebGPU. All are small and weeks to months old.
- A light footprint is a real differentiator: Liftoff requires an RTX 2060 and excludes iGPUs;
  Velocidrone's reputation is "runs on anything, physics first".
- Nobody publishes RAM figures - neither commercial sims nor web demos.

## Commercial sims

| Sim | Engine | Min spec | Install | iGPU | Pilots say |
| --- | --- | --- | --- | --- | --- |
| Liftoff | Unity [M] | 8 GB, RTX 2060; "Intel integrated not supported" [P] | 25 GB | poor | slightly floaty; low fps reads as floaty physics [S] |
| Velocidrone | Unity [S] | 4 GB, Intel HD 4000 [P] | 11 GB | best | most realistic for racing, cartoonish visuals [S] |
| TrypFPV | Unreal | 8 GB, GTX 960 [P] | 25 GB | poor | best visuals, huge maps, slightly heavy, "poor optimisation" [S] |
| Uncrashed | Unity/Unreal (conflicting) | 4 GB, GTX 770 [P] | 30 GB | poor | average physics [S] |
| DRL | Unity [M] | 8 GB, GTX 650 [P] | 15-20 GB | medium | dated; servers shut [S] |
| FPV.SkyDive | Unity [M] | 8 GB, GTX 650 [P] | 2 GB | good | mediocre physics [S] |
| FPV Freerider | Unity [M] | - | small | very good | good physics, small maps [S] |
| WebFPV (Steam, 27 Nov) | browser, Betaflight 4.5.1 wasm | 4 GB, WebGL2 iGPU [P] | 1-4 GB | very good | physics WIP [S] |

What makes the feel, as far as sources go: a stable high frame rate (low fps is perceived as
floaty physics); correct momentum and drag; real Betaflight rates and pasting your own tune;
low latency.

## Open-source / browser sims worth borrowing from

| Project | Stars / last push | Tech | Borrow |
| --- | --- | --- | --- |
| https://github.com/hammerill/libfpv | 73 / 2026-11-24 | C, real Betaflight via SimITL at 1 kHz, wasm-capable; GPL-3 core, MIT header | Betaflight embedding, analog video-link model, Configurator over WebSocket |
| https://github.com/panpi-loska/browser-fpv-simulator | 0 / 2026-11-17 | WebGPU + real Betaflight (libfpv), ~0.8 MB first load | proof WebGPU + BF fits in < 1 MB |
| https://github.com/Mathew-Harvey/WebFPVSimulator | 47 / 2026-11-25 | Betaflight 4.5.1 wasm, 1 kHz, GPL-3 | committed `sim.wasm`, memory lint CI |
| https://github.com/cheesejaguar/fpv-sim | 1 / 2026-11-16 | Betaflight 4.5.5 wasm, 8 kHz physics, SAB, GPL-3 | BEM props, DC motor back-EMF, Thevenin battery, Dryden turbulence, Hunt-Crossley contacts, fisheye + rolling shutter |
| https://github.com/AndriiShramko/ShramkoGSFPV | 23 / 2026-11-21 | WebGPU + PlayCanvas splats, MIT | clean-room Betaflight rates/PID (claims 0 deg/s error vs BF 4.5.1), deterministic replay, WebHID radio |
| https://github.com/rachmataditiya/fpv-web | 1 / 2026-07-24 | three.js, 240 Hz, MIT | WebHID parser for DJI FPV RC 3 |

These claims are from READMEs and have not been tested. Most repos are days to weeks old with
near-zero adoption: read the source before trusting a number or running anything.

Research sims (AirSim archived, Colosseum, Flightmare, Aerial Gym, Pegasus) are not usable as
pilot sims.

## Low-footprint high-quality web 3D

| Demo | Technique | Measured |
| --- | --- | --- |
| https://github.com/VictorZakharov/threejs-nanites | WebGPU, cluster DAG LOD, compute culling, HZB, impostors, TAA | 1M trees + 1.5M bushes, 3.1-10.1 ms on RTX 4070 Ti |
| https://github.com/vvanghelue/webgpu-landscape-rendering | CDLOD, hashed trees, compute cull + indirect, mesh -> card -> 1-tri LOD, baked heightmap shadows | 16 km, ~2M trees, 3-6 ms on Apple M4 |
| https://github.com/Scthe/nanite-webgpu | meshlets + software raster | 0.6-1.7B tris |
| threejs-forest-park devlog (counter-example) | conventional batching/LOD, PBR assets | 16-21 fps large forest on RTX 5060 laptop |

The pattern that wins is GPU-driven: procedural placement as a function of cell, culling,
indirect draws, impostors and a frame-time governor. None of these report RAM.

## Browser gotchas

- **Radios**: EdgeTX joystick polls at 1 ms (8 axes, 11-bit). Chromium polls the OS at 250 Hz,
  but the page only samples on `getGamepads()`, usually once per rAF (~half a frame added). An
  event-driven gamepad API reached Intent to Experiment in April 2026. WebHID reaches devices
  the Gamepad API can't (DJI RC). Ship a calibration wizard.
- **Latency**: Chromium documents two frames of rAF canvas input lag
  (https://issues.chromium.org/issues/41158934); `desynchronized` etc. showed no gain in one
  2022 study. Use a fixed physics step decoupled from rAF.
- **Brave**: since 1.93 it farbles WebGL renderer strings, empties WebGPU adapter info and
  randomises the extension order. Never pick quality tiers from GPU strings; use a frame-time
  governor and feature detection. Avoid readback for gameplay.
- **WebGPU on Linux**: staged by GPU; WebGL2 fallback mandatory.
- **Memory**: wasm32 caps at 4 GB (Memory64 exists, not needed). `SharedArrayBuffer` needs
  cross-origin isolation.
- **PWA**: cheap, gives a chromeless window, offline play and cached assets.

## Native vs browser

- GPU API overhead is near parity in Chrome: per-dispatch 23.8 us Dawn native, 32.8 us Chrome
  Linux Vulkan, ~1 ms in Firefox (https://arxiv.org/html/2604.02344v1).
- The CPU wasm penalty (~1.5x native) is irrelevant for a 1-8 kHz single-body model.
- Latency is the real gap, one to two frames. If it becomes the top complaint, wrap the same
  code for desktop (as WebFPV did) rather than rewrite.
- Worth measuring ourselves: same-scene RAM and click-to-photon latency in Chrome, Brave and a
  wrapper - nobody has published it.
