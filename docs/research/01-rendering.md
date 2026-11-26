# Rendering stack research (2026-11-25)

Sub-agent web research, condensed. Claims carry their source URL; anything marked
*unverified* has not been checked. Numbers from other people's hardware do not transfer to the
Iris G7 - see `00-decisions.md` for what was measured here.

## Verdict (provisional, pending the engine gate)

three.js r187 is the engine. Which renderer is decided by measurement:

- For `WebGLRenderer`: the target laptop is WebGL2-only by default; the reusable vegetation
  libraries (`agargaro/instanced-mesh`, `octahedral-impostor`, `batched-mesh-extensions`) are
  `WebGLRenderer`-only and patch shaders through `onBeforeCompile`; a maintainer calls the
  `WebGPURenderer` WebGL2 backend experimental and "an entirely separate renderer"
  (https://discourse.threejs.org/t/webgpurenderer-forcewebgl-true-vs-webglrenderer/87805).
  One r183 report on 4,000 non-instanced meshes (RTX 4090 laptop): CPU per frame 4.5 ms
  WebGL, 9.7 ms WebGPU, 10.3 ms forceWebGL; first frame 32 / 167 / 344 ms
  (https://discourse.threejs.org/t/webgpurenderer-2x-slower-cpu-and-5-10x-slower-first-frame-than-webglrenderer-on-many-mesh-scenes-r183-same-on-both-backends/91904).
  A world made of a handful of instanced draws may not show that gap.
- For `WebGPURenderer` + TSL: three.js's focus is now there, with no major new features planned
  for `WebGLRenderer` (https://threejs.org/manual/en/webgpurenderer). CSM, TRAA and motion blur
  exist as TSL nodes. Compute and `drawIndexedIndirect` (what the impressive 2026 open-world
  demos rely on) only exist on the WebGPU backend; the WebGL2 backend emulates simple compute
  with transform feedback.

## Engines compared

| Engine | Version | Size (min / gzip) | No bundler | WebGL2 path | Notes |
| --- | --- | --- | --- | --- | --- |
| three.js `WebGLRenderer` | r187 (2026-10-30) | 392 / 89 KB | importmap | mature | CSM addon, BatchedMesh, multi-draw; no compute |
| three.js `WebGPURenderer` + TSL | r187 | 492 / 123 KB | importmap | experimental | compute, indirect, CSM/TRAA/motion-blur nodes |
| Babylon.js | 9.37.2 | 8.93 MB / 1.93 MB UMD | heavy | mature | CSM, thin instances, splats |
| PlayCanvas | 2.24.3 | 2.90 MB / 749 KB | ESM | mature | best splat renderer |
| Bevy (wasm) | 0.20.1 | not measured | Rust toolchain | reduced | full rewrite; meshlets need 64-bit atomics, not on WebGPU |

Babylon and PlayCanvas would be a rewrite with no gain on the WebGL2 path. No COOP/COEP on
GitHub Pages means no `SharedArrayBuffer`, so no wasm threads without a workaround
(`coi-serviceworker`, unverified on Pages).

## WebGPU default status (gpuweb wiki, edited ~May 2026)

| Browser | Windows | macOS | Linux | Android |
| --- | --- | --- | --- | --- |
| Chromium | 113 | 113 | Intel Gen12+ (144), NVIDIA Wayland (147), else flags | 121 |
| Firefox | 141 | 145/147 Apple Silicon | Nightly only | off |
| Safari | - | 26 | - | iOS 26 |

Source: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status

## Techniques, by value on the WebGL2 path

| # | Technique | Reusable implementation |
| --- | --- | --- |
| 1 | KTX2 + meshopt assets | `zeux/meshoptimizer` gltfpack (MIT); `donmccurdy/glTF-Transform` (MIT) |
| 2 | CDLOD heightmap terrain | reference: https://github.com/vvanghelue/webgpu-landscape-rendering (CPU quadtree, 100-450 patches, one instanced 16x16 grid, geomorph; needs no compute, ports to WebGL2) |
| 3 | Instanced trees, BVH culling, LOD | `agargaro/instanced-mesh` (MIT, needs three >= 0.186) |
| 4 | Octahedral impostors | `agargaro/octahedral-impostor` (MIT, wip, last push 2025-11) |
| 5 | Cascaded shadows | three addon `examples/jsm/csm` |
| 6 | Atmosphere / aerial perspective | `takram-design-engineering/three-geospatial` (MIT, Bruneton) |
| 7 | Grass | none found for WebGL2; write instanced vertex-shader blades in camera-centred tiles |
| 8 | Post-processing | `pmndrs/postprocessing` (Zlib); motion blur by depth reprojection, hand-written |
| 9 | Batched terrain LOD | `agargaro/batched-mesh-extensions` (MIT) |
| 10 | Procedural conifers | `dgreenheck/ez-tree` (MIT code; bundled texture licence unstated) |

WebGPU-only work to study, not adopt:

- https://github.com/VictorZakharov/threejs-nanites (MIT): 1M trees + 1.5M bushes, cluster-DAG
  LOD, HZB occlusion, software raster, impostors, TAA + upscale, GPU-ms quality governor;
  3.1-10.1 ms at 1080p on an RTX 4070 Ti; has a reduced WebGL2 mode.
- https://github.com/Scthe/nanite-webgpu and the r187 `webgpu_meshlets*` examples: virtualised
  geometry on the web; overkill for a heightmap world on an iGPU.
- `AskAlice/threejs-worldgen` (Apache-2.0): TSL grass, 4 LODs, ~700k blades.
- `JolifantoBambla/webgpu-sky-atmosphere`: Hillaire port, raw WebGPU.

Lessons from the vvanghelue landscape renderer (Apple M4, 1600x900, 16x16 km, ~2M trees,
3-6 ms aerial, 10-15 ms in dense forest):

- trees are a pure hash of their 4 m cell, so there is zero per-tree CPU data;
- alpha-tested impostors were a major cost on tile-based GPUs, and opaque silhouette cards fixed it;
- sub-pixel triangles dominate distant-tree cost, hence a one-triangle far LOD;
- the terrain fragment shader was the largest single cost;
- long-range mountain shadows are ray-marched from the heightmap into a 2048^2 texture,
  re-baked only when the sun moves; CSM covers the near field only.

## Gaussian splats: not for the flyable map

- Memory is fine: Spark packs 16-56 B/splat (https://sparkjs.dev/docs/packed-splats/); SPZ is
  20-25 B/splat on disk (https://www.worldlabs.ai/blog/spark-2.0); PlayCanvas SOG is 15-20x
  smaller than PLY.
- Sorting is the blocker. Spark reads distances back and sorts in a worker, so the order trails
  the camera, and FPV turns fastest of any use case. A GPU radix sort needs WebGPU compute.
- Fill rate is the second blocker. PlayCanvas on WebGL2: 137 fps at 1M splats on an M4 Max,
  38 fps at 1M on an iPhone 13 Pro Max
  (https://blog.playcanvas.com/new-in-supersplat-webgpu-and-streaming-bring-huge-performance-wins).
  No Intel iGPU figure was found.
- Baked lighting: no dynamic shadows, no time of day. Collision needs a proxy mesh.
- 4DGS (dynamic) is irrelevant for static maps.
- Viewers if a scanned showcase is wanted later: `sparkjsdev/spark` (MIT, active),
  PlayCanvas/supersplat (MIT).

## Asset compression

- An uncompressed 4096^2 RGBA texture with mips is ~90 MB of GPU memory; BC7/ASTC is 4x
  smaller, BC1 8x (https://www.donmccurdy.com/2024/02/11/web-texture-formats/). Use UASTC for
  normals and ETC1S for colour; the Basis transcoder is 527 KB (245 KB gzip).
- `gltfpack -cc` (quantisation + `EXT_meshopt_compression`); the meshopt decoder is 29 KB.
- Bigger win: replace glTF triangle maps with heightmap + splat + instance data.

## Risks

1. 60 fps at 1080p on the Iris is unproven; every external figure is from M4/RTX hardware.
   Plan for dynamic resolution and scalable grass/shadows/post from day one.
2. Overdraw from alpha-tested grass and impostors is the likeliest iGPU killer.
3. `WebGLRenderer` is in maintenance mode; keep shader logic in self-contained chunks.
4. The agargaro libraries are single-author projects; pin and vendor them.
5. r160 -> r187 is 27 releases of migration (colour management, addon paths).
