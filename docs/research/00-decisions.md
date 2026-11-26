# Render overhaul: decisions, measurements and open questions

Living document for the `render-overhaul` branch. Goal: TrypFPV-class outdoor maps (big
terrain, distant mountains, thousands of conifers, grass, sun shadows, haze) in the browser,
with low RAM and good CPU/GPU use, on hardware as weak as an Intel Iris Plus G7 (Ice Lake
Gen11) laptop iGPU. This is a long-term project, so migrating to wasm/WebGPU is allowed when
the numbers justify it.

Supporting reports in this folder:

| File | Topic |
| --- | --- |
| `01-rendering.md` | Engine choice, open-world techniques, Gaussian splats, asset compression |
| `03-landscape.md` | Competitor sims, open-source/browser sims, browser gotchas, native vs browser |
| `04-physics.md` | Flight model, physics engine, Betaflight in wasm |
| `07-sponza.md` | The Sponza map: perf, course, autopilot, recorder, HUD research and pitfalls |

Claims in those reports come from web research by sub-agents and are tagged by confidence.
Anything that drives a decision is re-measured here before it is relied on.

## Measured on the target laptop (2026-11-25)

Intel Iris Plus G7 (ICL GT2), 7.5 GB RAM, Linux 6.8, Mesa. Brave 158 stable and 159 Nightly,
clean throwaway profiles, headed (headless Brave falls back to SwiftShader and is useless for
GPU numbers). Harness: `tools/bench/brave_cdp.py`.

**GPU paths**

| Path | Result |
| --- | --- |
| WebGL2, default flags | Real iGPU via ANGLE -> OpenGL 4.6 |
| WebGL2, `--use-angle=vulkan` | Real iGPU via Vulkan, but bando ran at 22-28 fps against ~57 on OpenGL |
| WebGPU, default flags | **No adapter** (stable and Nightly) |
| WebGPU, `--enable-unsafe-webgpu` only | SwiftShader **software** adapter - a trap |
| WebGPU, `--enable-unsafe-webgpu --enable-features=Vulkan` | intel gen-11, real iGPU |

Chromium enables WebGPU on Linux by default only for Intel Gen12+ (Chrome 144) and NVIDIA on
Wayland (147). Windows, macOS, ChromeOS and Android have it by default. A WebGL2 path is
therefore mandatory.

**Compressed textures**: WebGL2 exposes BC1-7 (`s3tc`, `s3tc_srgb`, `bptc`, `rgtc`), ETC2 and
ASTC; also `WEBGL_multi_draw` and `WEBGL_clip_cull_distance`; max texture 16384. WebGPU (with
flags) exposes `texture-compression-bc`, `-etc2`, `-astc`, `timestamp-query`,
`indirect-first-instance`, `chromium-experimental-multi-draw-indirect`. So KTX2/Basis can
transcode to BC7 here.

**Memory, current sim (v36, WebGL2)** - PSS summed over every Brave process:

| State | Total | Notes |
| --- | --- | --- |
| Menu, no map | ~460 MB | Brave itself: browser 128, GPU 111, renderer 117, network 55, zygote 38, storage 11 |
| Flying bando | ~620 MB | renderer +120, GPU +16, audio service +30 |
| Flying quarry | ~610 MB | |

iGPU buffer memory is not visible in PSS on this kernel without root, so the map's share
(~+160 MB) is a lower bound. Frame rate over 5 s at spawn: bando 57, quarry 59 (vsync cap 60);
freezing or disabling shadows changes little there.

**Conclusion**: the current sim is already roughly 10x lighter than Unity/Unreal sims, and
Brave's own ~460 MB floor dominates. The problem to solve is *visual quality per byte and per
GPU millisecond*, not a RAM leak.

## Decisions so far

1. **Browser first, native wrapper later if latency demands it.** Native buys about one frame
   of input latency and CPU headroom, not GPU speed; the zero-install link is the product's
   edge (`03-landscape.md`).
2. **No Gaussian splats for the flyable map.** Splats need re-sorting on every fast camera turn
   and are overdraw-heavy close to surfaces; they don't take dynamic shadows and still need a
   collision proxy. Possible later for a scanned showcase backdrop.
3. **Maps become data, not triangle soup.** Ship a 16-bit heightfield, splat/mask maps, KTX2
   material sets and a compact instance list instead of 45-52 MB glTF meshes. Terrain renders
   with a CDLOD-style quadtree of one instanced grid patch; distant mountains as a low-res
   backdrop ring; trees as instanced meshes -> cards/impostors by distance; grass generated
   on the GPU near the camera; sky/haze analytic.
4. **Terrain collision samples the heightfield directly**, which removes the triangle BVH for
   terrain entirely; a BVH remains only for props and rocks.
5. **Assets CC0 only** (Poly Haven, ambientCG) or generated in-repo. Megascans/Fab licences
   forbid public redistribution.
6. **Supply chain**: third-party JS/wasm is vendored from npm tarballs verified against the
   registry's sha512 integrity, with the hashes recorded in the repo; external repos are read
   before anything from them runs.

## Engine gate (2026-11-25): WebGPURenderer + TSL, provisionally

Same scene on all paths (`bench/engine-gate/`): 2000 m displaced terrain (524k triangles),
20k instanced conifers, one shadowed sun (2048^2 PCF), fog, scripted low-altitude flight, a
fixed sequence of frames at 1920x1080. Each frame's cost is measured by rendering four frames
back to back and forcing the GPU to finish (`readPixels` / `onSubmittedWorkDone`), because
rAF timing reads the refresh rate with vsync on and bursts with it off. `renderer.info`
confirms both renderers draw the same 4.89M triangles (2.44M without shadows) in the same
handful of draws.

Mean ms per frame, mean of three interleaved runs (the laptop throttles: run 3 was ~20%
slower than run 1 across the board, so treat +-20% as noise):

| | WebGLRenderer | WebGPURenderer, WebGL2 backend | WebGPURenderer, WebGPU (flags) |
| --- | --- | --- | --- |
| shadows + MSAA | 19.3 | 19.1 | 16.9 |
| shadows, no MSAA | 20.2 | 14.6 | 14.7 |
| no shadows + MSAA | 12.4 | 16.8 | 13.8 |
| no shadows, no MSAA (single run) | 9.8 | 12.3 | 13.0 |

- No path is a clear loser. With shadows, which every real map has, the TSL renderer ties or
  wins; without them its WebGL2 backend is 25-35% slower, mostly in MSAA.
- First frame: 80-160 ms on WebGLRenderer, 180-370 ms on WebGPURenderer.
- Halving the resolution barely moved anything: this scene is geometry-bound (~4.9M
  triangles). The real world will be fewer triangles with much heavier shading, so fragment cost
  is still untested.
- **Decision**: build on `WebGPURenderer` + TSL. One shader codebase runs on WebGPU where it
  exists and on WebGL2 everywhere else; compute, indirect draws and the CSM/TRAA nodes come
  with it. Default-flags Brave (WebGL2 backend) is the primary test target, so every feature is
  proven there first, and compute-only features need a CPU fallback.
- **Pivot back to GLSL + WebGLRenderer if** a needed feature is broken on the WebGL2 backend, or
  TSL fragment cost runs 25%+ above equivalent GLSL.
- **Budget reality**: even this flat-shaded scene costs 10-20 ms on the Iris. LOD, culling and
  dynamic resolution are day-one requirements.

Headless Brave reaches the real iGPU with `--headless=new --enable-gpu --ignore-gpu-blocklist`
(the harness default since this gate), so benchmarks no longer open windows.

## Decisions pending measurement

- **Gaussian splats**: ruled out above on research alone. The measurements, the outdoor terrain
  and Churchill College work live on the `render-research` branch.
- **Terrain shader budget**: full-screen cost at 8/16/32 texture fetches, in TSL on the WebGL2
  backend.

## Open questions for the team

1. Which OS do the pilots fly on? That decides how much WebGPU-first is worth.
2. Map generator language: the repo's tools are Node, but neither dev machine used so far has
   Node. Rust (fast erosion, single binary) or Node? The slice generates terrain at runtime so
   this does not block.
3. Launching TrypFPV on the shared GPU box for side-by-side comparison needs an explicit OK.
4. ~~GPL~~ - answered: the project is meant to be open source, so GPL-3 is fine and real
   Betaflight compiled to wasm is in scope as the flight controller. The repo still needs a
   LICENSE file.

## Benchmark method notes

- Headless runs (`--headless=new --enable-gpu --ignore-gpu-blocklist`) use the real iGPU but skip
  presentation (Brave's compositor and the desktop's). Same scene: 9.8 ms headed vs 6.7-8.3 ms
  headless, so budget ~1.5-3 ms at 1080p for presentation. Headless is for A/B comparisons; take
  absolute "holds 60 fps" numbers headed, when nobody is using the laptop.
- Plain `--headless=new` (no GPU flags) renders with SwiftShader on the CPU: useless for timing,
  but fine for correctness screenshots while another job owns the GPU.
- Dependencies: only pin releases that have been public for at least ~3 weeks, verified against
  the registry's sha512 integrity, with hashes in a MANIFEST next to the vendored files.
