// generate-rift-quarry.mjs - builds `rift-quarry.glb` and the survey data for the Rift Run course.
//
//   node tools/generate-rift-quarry.mjs
//
// Why a generator rather than a downloaded model: the gates have to be surveyed against the
// collision mesh, and a generated map lets that happen the other way round. The racing line is
// defined first, in the same constants the geometry is built from, and then every gate ring and
// every leg between gates is measured against the finished triangles before the file is written
// (see the clearance report at the end). A gate that ends up inside a wall fails the build.
//
// Read the LAYOUT block below and the rest follows from it. Nothing here is hand-placed twice:
// tracks.js gets its numbers from the survey this prints.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Surface, writeGLB, verifyGLB, encodePNG } from './lib/glb.mjs';
import {
    clamp, mix, smoothstep, smootherstep, fbm, ridged, noise2, rng, distanceToPolyline
} from './lib/noise.mjs';
import { ClearanceField } from './lib/clearance.mjs';
import { render } from './lib/preview.mjs';
import * as textures from './lib/textures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_GLB = path.resolve(HERE, '..', 'rift-quarry.glb');
const OUT_SURVEY = path.resolve(HERE, 'rift-quarry-survey.json');

const DEG = Math.PI / 180;

// ===========================================================================
// LAYOUT - the whole map in one block. Everything else is derived.
// ===========================================================================

// Terrain grid. 0.5 m spacing over 300 m is 361k vertices and 720k triangles; it is the main
// lever on both file size and how cleanly a 60-degree quarry wall resolves.
const WORLD = { half: 150, step: 0.5 };

// The quarry. Benches step down from the rim to the floor; the racing line spirals into it.
const PIT = { x: -58, z: -44, rimR: 42, floorR: 13, rimY: 0, floorY: -22, benches: 4 };

// The graded yard. Flat at y = 0, which is what the practice spawn at (0, 1, 0) stands on.
const YARD = { x0: -14, x1: 64, z0: -26, z1: 60 };

// Haul road from the yard out to the quarry edge, graded flat like the yard
const ROAD = { points: [[22, -28], [2, -33.6], [-16.3, -38.7]], halfWidth: 7 };

// The ravine, as a centreline with a floor height and a half-width at each node. It leaves the
// pit floor heading south, cuts a notch through the benches on that side, and climbs 23 m to the
// yard over about 93 m - the long leg of the lap. The first two nodes are inside the rim on
// purpose: that stretch is a cut through the terraces, not a separate valley.
const CANYON = [
    { x: -58, z: -31, y: -22.0, w: 8.0 },
    { x: -56, z: -14, y: -19.0, w: 7.0 },
    { x: -52, z: 2, y: -15.5, w: 6.5 },
    { x: -46, z: 18, y: -11.0, w: 7.0 },
    { x: -40, z: 32, y: -6.5, w: 8.0 },
    { x: -32, z: 44, y: -2.0, w: 9.0 },
    { x: -24, z: 54, y: 1.5, w: 10.0 }
];

const HANGAR = { x: 22, z: -4, width: 20, length: 30, height: 9.5, door: { width: 9, height: 7 } };
const PLANT = {
    x: -8,                                  // the crusher, conveyor and silos all share this line
    crusherZ: -50,
    silos: [-24, -14, -4],
    siloRadius: 4.2,
    siloHeight: 12,
    conveyor: { z0: -48, y0: 7, z1: -4, y1: 20 }, // underside of the truss
    legs: [-44, -30, -18, -6]               // no leg between -44 and -30: that is the road crossing
};
const TANK = { x: 44, z: 46, r: 8, h: 15 };
const CONTAINERS = { z: [47, 58], x0: -2, x1: 30 };   // two rows, an alley between them
// Runs north-south so the line, which comes back west along z = 34, passes between the supports
const PIPE_RACK = { x: 34, z0: 26, z1: 44, deck: 7.6 };

// Where the racing line crosses the conveyor, and where it leaves the rim
const CONVEYOR_CROSS = { x: PLANT.x, z: -36.4 };
const RIM_ENTRY_DEG = 7;

// Spiral down the benches: bearing, radius, and height above the pit datum. The radii sit in the
// middle of each bench flat, and each height is 4.5 m over that bench, so the line follows the
// terraces down rather than dropping through them.
//
// The bearings run *backwards* from the rim entry, round the north side of the quarry. That is
// not arbitrary: by the last turn the radius is closing faster than the bearing, so the drone is
// travelling almost straight across the floor towards the mouth of the cut, and the run into the
// adit is a continuation rather than a hairpin. Spiralling the short way round instead - 7 deg to
// 95, which looks tidier on paper - arrives at the floor pointing back the way it came, because
// the whole of the pit floor lies north of a bench-three gate at that bearing.
const SPIRAL = [
    { name: 'RIM DROP', deg: RIM_ENTRY_DEG, r: 40, y: 4.5, radius: 2.8 },
    { name: 'BENCH ONE', deg: -30, r: 32.93, y: -1.0, radius: 2.6 },
    { name: 'BENCH TWO', deg: -68, r: 25.75, y: -6.5, radius: 2.6 },
    { name: 'BENCH THREE', deg: -105, r: 18.55, y: -12.0, radius: 2.6 },
    { name: 'PIT FLOOR', deg: -138, r: 9.0, y: -17.5, radius: 2.8 }
];

// The adit: a rock barrier plugging the cut where it leaves the quarry, with a bored opening
// through it. The only way out of the pit without climbing back over the rim.
const ADIT = { along: 20, width: 26, thickness: 9, opening: { width: 6.5, height: 7 } };
// The natural arch spanning the ravine, two thirds of the way up
const ARCH = { along: 72, radius: 8, band: 2.6, depth: 6 };
// Gates in the ravine, by distance along the centreline
const CANYON_GATES = [
    { name: 'RAVINE ONE', along: 32, radius: 3.0 },
    { name: 'RAVINE TWO', along: 48, radius: 3.0 },
    { name: 'RAVINE THREE', along: 62, radius: 3.0 }
];

const SPAWN = { x: 22, y: 1.0, z: 40, yaw: 0 };

// Texture resolution, in pixels. Noise does not compress, so this is the other half of the file
// size - and the reason the map looks like rock from 30 cm away rather than flat colour.
const TEX_SIZE = { rock: 2048, ground: 2048, yard: 1024, concrete: 1024, steel: 512, rust: 512, hazard: 256 };

// ===========================================================================
// Terrain height field
// ===========================================================================

// Cumulative distance along the ravine centreline, so a point can be looked up by how far along
// it sits rather than by segment index
const CANYON_XZ = CANYON.map((n) => [n.x, n.z]);
const CANYON_ALONG = (() => {
    const out = [0];
    for (let i = 1; i < CANYON.length; i++) {
        out.push(out[i - 1] + Math.hypot(CANYON[i].x - CANYON[i - 1].x, CANYON[i].z - CANYON[i - 1].z));
    }
    return out;
})();
const CANYON_LENGTH = CANYON_ALONG[CANYON_ALONG.length - 1];

// Position, floor height and half-width at a distance along the ravine
function canyonAt(along) {
    const s = clamp(along, 0, CANYON_LENGTH);
    let i = 1;
    while (i < CANYON_ALONG.length - 1 && CANYON_ALONG[i] < s) i++;
    const t = (s - CANYON_ALONG[i - 1]) / (CANYON_ALONG[i] - CANYON_ALONG[i - 1]);
    const a = CANYON[i - 1], b = CANYON[i];
    return {
        x: mix(a.x, b.x, t),
        z: mix(a.z, b.z, t),
        y: mix(a.y, b.y, t),
        w: mix(a.w, b.w, t),
        // Unit direction of travel down the ravine
        dir: (() => {
            const dx = b.x - a.x, dz = b.z - a.z;
            const l = Math.hypot(dx, dz);
            return { x: dx / l, z: dz / l };
        })()
    };
}

function rectDistance(x, z, x0, x1, z0, z1) {
    const dx = Math.max(x0 - x, 0, x - x1);
    const dz = Math.max(z0 - z, 0, z - z1);
    return Math.hypot(dx, dz);
}

function padWeight(x, z) {
    return 1 - smootherstep(0, 13, rectDistance(x, z, YARD.x0, YARD.x1, YARD.z0, YARD.z1));
}

function roadWeight(x, z) {
    const { distance } = distanceToPolyline(x, z, ROAD.points);
    return 1 - smootherstep(ROAD.halfWidth, ROAD.halfWidth + 9, distance);
}

// Terraced quarry profile at a radius from the pit centre
function benchHeight(d) {
    const t = clamp((PIT.rimR - d) / (PIT.rimR - PIT.floorR), 0, 1);
    const s = t * PIT.benches;
    const k = Math.floor(s);
    const f = s - k;
    // Flat for the first 55% of each step, then the wall. Benches come out 4.3 m wide with
    // 5.5 m walls between them, which is what makes the spiral readable from the air.
    const profile = Math.min(1, (k + smoothstep(0.55, 0.95, f)) / PIT.benches);
    return PIT.rimY - profile * (PIT.rimY - PIT.floorY);
}

function baseHeight(x, z) {
    let h = (fbm(x * 0.0062, z * 0.0062, { octaves: 4, seed: 11 }) - 0.5) * 13;
    h += (ridged(x * 0.019, z * 0.019, { octaves: 3, seed: 23 }) - 0.45) * 5;
    h += (fbm(x * 0.09, z * 0.09, { octaves: 2, seed: 41 }) - 0.5) * 1.6;
    // The basin closes the world in - without it the map has a visible edge and the fog has
    // nothing to sit against. The start radius wanders with a very low frequency so the result is
    // a ring of hills rather than the rim of a crater, which is what a clean smootherstep on the
    // radius gives you.
    const wander = (fbm(x * 0.0042, z * 0.0042, { octaves: 2, seed: 19 }) - 0.5) * 26;
    h += smootherstep(114 + wander, 178 + wander, Math.hypot(x, z)) * 46;
    return h;
}

function terrainHeight(x, z) {
    let h = baseHeight(x, z);

    // Graded ground - the yard and the haul road out to the rim
    const graded = Math.max(padWeight(x, z), roadWeight(x, z));
    if (graded > 0) h = mix(h, 0, graded);

    // The quarry, blended in over the last few metres of rim so there is a lip rather than a step
    const d = Math.hypot(x - PIT.x, z - PIT.z);
    if (d < PIT.rimR + 5) {
        const w = smootherstep(PIT.rimR + 5, PIT.rimR - 3, d);
        if (w > 0) h = mix(h, Math.min(h, benchHeight(d)), w);
    }

    // The ravine. A plain min against a V-profile: where the surrounding ground is already
    // lower than the walls would be, nothing is carved and the two blend by themselves.
    const c = distanceToPolyline(x, z, CANYON_XZ);
    if (c.distance < 40) {
        const node = canyonAt(c.along);
        const wall = node.y + Math.max(0, c.distance - node.w) * 2.6;
        if (wall < h) h = wall;
    }

    // Blast rubble everywhere except the graded ground
    h += (fbm(x * 0.35, z * 0.35, { octaves: 2, seed: 77 }) - 0.5) * 0.55 * (1 - graded);
    return h;
}

function terrainNormal(x, z) {
    const e = 0.35;
    const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
    const dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return { x: -dx / l, y: 1 / l, z: -dz / l, slope: Math.hypot(dx, dz) };
}

// ===========================================================================
// Materials and surfaces
// ===========================================================================

const MATERIALS = [
    { name: 'rock', texture: 0, roughness: 0.98 },
    { name: 'ground', texture: 1, roughness: 1.0 },
    { name: 'yard', texture: 2, roughness: 0.95 },
    { name: 'concrete', texture: 3, roughness: 0.9 },
    { name: 'steel', texture: 4, roughness: 0.62, metallic: 0.25, doubleSided: true },
    { name: 'rust', texture: 5, roughness: 0.85, metallic: 0.1, doubleSided: true },
    { name: 'hazard', texture: 6, roughness: 0.8, doubleSided: true },
    { name: 'dark', baseColorFactor: [0.09, 0.1, 0.12, 1], roughness: 0.4, metallic: 0.2, doubleSided: true },
    { name: 'lamp', baseColorFactor: [0.6, 0.55, 0.45, 1], emissive: [1.0, 0.86, 0.55], roughness: 0.4 },
    { name: 'foliage', baseColorFactor: [0.19, 0.26, 0.15, 1], roughness: 1.0, doubleSided: true },
    { name: 'timber', baseColorFactor: [0.28, 0.21, 0.14, 1], roughness: 1.0 }
];
const MAT = Object.fromEntries(MATERIALS.map((m, i) => [m.name, i]));

const S = {};
for (const m of MATERIALS) S[m.name] = new Surface(m.name, MAT[m.name]);

// The terrain is split into tiles, each its own mesh sharing one of the terrain materials.
// Three.js frustum-culls per mesh, so as one 420k-triangle sheet the ground is submitted in full
// on every frame - and again for the shadow map - however little of it is on screen. Named
// `<material>#<i>-<j>`; the part before the # is what picks the material and the preview tone.
const TERRAIN_TILES = 8;
const EXTRA_SURFACES = [];
const allSurfaces = () => [...MATERIALS.map((m) => S[m.name]), ...EXTRA_SURFACES];

// UV scale is metres per texture tile, per material
const UV = { rock: 9, ground: 6, yard: 7, concrete: 4, steel: 2.5, rust: 2.2, hazard: 1, dark: 2, lamp: 1, foliage: 2, timber: 2 };

// Filled in once the racing line is built. Everything placed afterwards - boulders, spoil heaps,
// light masts, the rim berm - keeps out of the corridor the course flies through, which is the
// difference between decorating a map and blocking it.
let LINE_XZ = null;
const clearOfLine = (x, z, margin) => !LINE_XZ || distanceToPolyline(x, z, LINE_XZ).distance > margin;

// ===========================================================================
// Primitives
// ===========================================================================

// Local -> world with a yaw rotation. Proper rotation, so face winding is preserved.
function frame(cx, cy, cz, yawDeg = 0) {
    const a = yawDeg * DEG;
    const c = Math.cos(a), s = Math.sin(a);
    return (lx, ly, lz) => [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
}

const BOX_FACES = [
    { key: 'px', pts: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { key: 'nx', pts: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { key: 'py', pts: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { key: 'ny', pts: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { key: 'pz', pts: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { key: 'nz', pts: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }
];

// x/y/z is the centre; sx/sy/sz are full extents.
function addBox(surface, { x, y, z, sx, sy, sz, yaw = 0, color = [235, 235, 235], uvScale, skip = [] }) {
    const f = frame(x, y, z, yaw);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    for (const face of BOX_FACES) {
        if (skip.includes(face.key)) continue;
        surface.face(face.pts.map((p) => f(p[0] * hx, p[1] * hy, p[2] * hz)), { uvScale, color });
    }
}

// A box between two arbitrary points - a beam. The basis is built from the member's own
// direction rather than a yaw, so a sloping truss chord actually slopes.
function addBeam(surface, a, b, w, h, { color = [235, 235, 235], uvScale } = {}) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const d = [dx / len, dy / len, dz / len];
    const seed = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let rx = d[1] * seed[2] - d[2] * seed[1];
    let ry = d[2] * seed[0] - d[0] * seed[2];
    let rz = d[0] * seed[1] - d[1] * seed[0];
    const rl = Math.hypot(rx, ry, rz);
    rx /= rl; ry /= rl; rz /= rl;
    // up = right x dir, which makes (right, up, dir) right-handed and keeps the box winding
    const ux = ry * d[2] - rz * d[1];
    const uy = rz * d[0] - rx * d[2];
    const uz = rx * d[1] - ry * d[0];

    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, cz = (a[2] + b[2]) / 2;
    const to = (lx, ly, lz) => [
        cx + rx * lx + ux * ly + d[0] * lz,
        cy + ry * lx + uy * ly + d[1] * lz,
        cz + rz * lx + uz * ly + d[2] * lz
    ];
    for (const face of BOX_FACES) {
        surface.face(face.pts.map((p) => to(p[0] * w / 2, p[1] * h / 2, p[2] * len / 2)), { uvScale, color });
    }
}

// y is the base. `inward` flips the whole thing so the inside is the visible surface, which is
// what a tunnel liner or a pipe bore needs.
function addCylinder(surface, {
    x, y, z, r, h, rTop = r, segments = 24, capTop = false, capBottom = false,
    color = [235, 235, 235], uvScale, inward = false, yaw = 0
}) {
    const f = frame(x, y, z, yaw);
    const top = [], bottom = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        bottom.push(f(Math.cos(a) * r, 0, Math.sin(a) * r));
        top.push(f(Math.cos(a) * rTop, h, Math.sin(a) * rTop));
    }
    for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        const quad = inward
            ? [bottom[i], bottom[j], top[j], top[i]]
            : [bottom[j], bottom[i], top[i], top[j]];
        surface.face(quad, { uvScale, color });
    }
    // Increasing angle winds clockwise seen from above, so the caps take the orders below
    if (capTop && rTop > 0) surface.face(top.slice().reverse(), { uvScale, color });
    if (capBottom) surface.face(bottom.slice(), { uvScale, color });
}

// A rectangular wall standing in the local XY plane with a rectangular hole in it, built as four
// solid boxes. Doorways and the adit are all this shape.
function addWallWithOpening(surface, {
    x, y, z, yaw = 0, width, height, thickness, opening, color, uvScale
}) {
    const { width: ow, height: oh, base: ob = 0, centre: oc = 0 } = opening;
    const left = -width / 2, right = width / 2;
    const holeL = oc - ow / 2, holeR = oc + ow / 2;

    const piece = (x0, x1, y0, y1) => {
        if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
        const f = frame(x, y, z, yaw);
        const c = f((x0 + x1) / 2, (y0 + y1) / 2, 0);
        addBox(surface, {
            x: c[0], y: c[1], z: c[2], yaw,
            sx: x1 - x0, sy: y1 - y0, sz: thickness, color, uvScale
        });
    };

    piece(left, holeL, 0, height);          // left of the opening
    piece(holeR, right, 0, height);         // right of it
    piece(holeL, holeR, ob + oh, height);   // lintel
    if (ob > 0) piece(holeL, holeR, 0, ob); // sill
}

// A cylinder between two arbitrary points. addCylinder only builds along +Y and `yaw` is a
// rotation about Y, so it cannot lay one on its side however it is called - anything horizontal
// (a pipe run, an axle) has to come from here.
function addTube(surface, a, b, { r, segments = 14, color = [235, 235, 235], uvScale, caps = true } = {}) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const d = [dx / len, dy / len, dz / len];
    const seed = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let ux = d[1] * seed[2] - d[2] * seed[1];
    let uy = d[2] * seed[0] - d[0] * seed[2];
    let uz = d[0] * seed[1] - d[1] * seed[0];
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    // v = d x u, so (u, v, d) is right-handed and the ring winds outwards
    const vx = d[1] * uz - d[2] * uy;
    const vy = d[2] * ux - d[0] * uz;
    const vz = d[0] * uy - d[1] * ux;

    const ringA = [], ringB = [];
    for (let i = 0; i < segments; i++) {
        const th = (i / segments) * Math.PI * 2;
        const c = Math.cos(th) * r, s = Math.sin(th) * r;
        const ox = ux * c + vx * s, oy = uy * c + vy * s, oz = uz * c + vz * s;
        ringA.push([a[0] + ox, a[1] + oy, a[2] + oz]);
        ringB.push([b[0] + ox, b[1] + oy, b[2] + oz]);
    }
    for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        surface.face([ringA[i], ringA[j], ringB[j], ringB[i]], { uvScale, color });
    }
    if (caps) {
        surface.face(ringB.slice(), { uvScale, color });
        surface.face(ringA.slice().reverse(), { uvScale, color });
    }
}

// A lumpy rock. A subdivided octahedron with the radius pushed about by noise, flat shaded so
// the facets read as fractured stone rather than a smooth blob.
function addRock(surface, { x, y, z, r, seed = 1, squash = 0.75, detail = 1, color, uvScale }) {
    const base = [
        [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]
    ];
    let tris = [
        [0, 4, 2], [0, 2, 5], [0, 5, 3], [0, 3, 4],
        [1, 2, 4], [1, 5, 2], [1, 3, 5], [1, 4, 3]
    ].map((t) => t.map((i) => base[i]));

    for (let d = 0; d < detail; d++) {
        const next = [];
        for (const [a, b, c] of tris) {
            const mid = (p, q) => {
                const m = [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
                const l = Math.hypot(...m);
                return [m[0] / l, m[1] / l, m[2] / l];
            };
            const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
            next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
        }
        tris = next;
    }

    const warp = (p) => {
        const n = fbm(p[0] * 1.7 + seed, p[2] * 1.7 - seed, { octaves: 3, seed });
        const k = r * (0.72 + n * 0.55);
        return [x + p[0] * k, y + p[1] * k * squash, z + p[2] * k];
    };

    for (const t of tris) surface.face(t.map(warp), { uvScale, color });
}

// A truss bridge between two points: chords, verticals and diagonals. Used for the conveyor.
function addTruss(surface, { from, to, width, depth, bays, color, uvScale }) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    const ux = dx / len, uy = dy / len, uz = dz / len;
    // Horizontal perpendicular, which is all the width axis needs to be
    const pl = Math.hypot(dz, dx);
    const px = -dz / pl, pz = dx / pl;
    const at = (t, side, up) => [
        from[0] + dx * t + px * side * width / 2,
        from[1] + dy * t + up,
        from[2] + dz * t + pz * side * width / 2
    ];

    const member = (a, b, size) => addBeam(surface, a, b, size, size, { color, uvScale });

    for (const side of [-1, 1]) {
        member(at(0, side, 0), at(1, side, 0), 0.35);
        member(at(0, side, depth), at(1, side, depth), 0.35);
        for (let i = 0; i <= bays; i++) {
            const t = i / bays;
            member(at(t, side, 0), at(t, side, depth), 0.25);
            if (i < bays) {
                const t2 = (i + 1) / bays;
                member(at(t, side, 0), at(t2, side, depth), 0.2);
            }
        }
    }
    // Deck and a covered top, so it reads as a conveyor rather than scaffolding
    for (let i = 0; i < bays; i++) {
        const t = i / bays, t2 = (i + 1) / bays;
        surface.face([at(t, -1, 0.35), at(t2, -1, 0.35), at(t2, 1, 0.35), at(t, 1, 0.35)], { uvScale, color });
        surface.face([at(t, 1, depth), at(t2, 1, depth), at(t2, -1, depth), at(t, -1, depth)], { uvScale, color });
    }
}

// ===========================================================================
// Terrain mesh
// ===========================================================================

function buildTerrain() {
    const N = Math.round((WORLD.half * 2) / WORLD.step) + 1;
    const heights = new Float32Array(N * N);
    const normals = new Float32Array(N * N * 3);
    const at = (i, j) => -WORLD.half + i * WORLD.step;

    for (let j = 0; j < N; j++) {
        const z = at(j);
        for (let i = 0; i < N; i++) heights[j * N + i] = terrainHeight(at(i), z);
    }

    // Normals from the sampled grid rather than from terrainHeight again - cheaper, and it
    // guarantees the shading matches the triangles the drone actually collides with.
    const inv = 1 / (2 * WORLD.step);
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1);
            const j0 = Math.max(0, j - 1), j1 = Math.min(N - 1, j + 1);
            const dx = (heights[j * N + i1] - heights[j * N + i0]) * (i1 === i0 ? 0 : inv * (2 / (i1 - i0)));
            const dz = (heights[j1 * N + i] - heights[j0 * N + i]) * (j1 === j0 ? 0 : inv * (2 / (j1 - j0)));
            const l = Math.hypot(dx, 1, dz);
            normals[(j * N + i) * 3] = -dx / l;
            normals[(j * N + i) * 3 + 1] = 1 / l;
            normals[(j * N + i) * 3 + 2] = -dz / l;
        }
    }

    // One vertex may be shared by quads that land on different materials or in different tiles,
    // so each surface keeps its own lazily filled index map - sparse, because a tile only ever
    // touches its own corner of the grid. Only the vertices on a boundary get duplicated.
    const tiles = new Map();
    const tileFor = (kind, i, j) => {
        const ti = Math.min(TERRAIN_TILES - 1, Math.floor((i / (N - 1)) * TERRAIN_TILES));
        const tj = Math.min(TERRAIN_TILES - 1, Math.floor((j / (N - 1)) * TERRAIN_TILES));
        const key = `${kind}#${ti}-${tj}`;
        let tile = tiles.get(key);
        if (!tile) {
            tile = { surface: new Surface(key, MAT[kind]), index: new Map() };
            tiles.set(key, tile);
            EXTRA_SURFACES.push(tile.surface);
        }
        return tile;
    };

    const tint = (x, y, z, slope, kind) => {
        const macro = fbm(x * 0.011, z * 0.011, { octaves: 3, seed: 5 });
        const fine = noise2(x * 0.4, z * 0.4, 9);
        // Everything gets darker with depth: the pit floor is 22 m down a hole and should read
        // that way even with a hemisphere light doing the ambient.
        const depth = 0.72 + smoothstep(-24, 6, y) * 0.28;
        let r = 1, g = 1, b = 1;
        if (kind === 'rock') {
            r = 0.82 + macro * 0.3; g = 0.80 + macro * 0.27; b = 0.78 + macro * 0.24;
        } else if (kind === 'ground') {
            r = 0.86 + macro * 0.26; g = 0.82 + macro * 0.22; b = 0.72 + macro * 0.2;
        } else {
            r = 0.88 + macro * 0.14; g = 0.89 + macro * 0.14; b = 0.9 + macro * 0.13;
        }
        const grit = 0.94 + fine * 0.12;
        const steep = 1 - clamp(slope - 0.9, 0, 1) * 0.12;
        return [
            clamp(r * depth * grit * steep * 255, 0, 255),
            clamp(g * depth * grit * steep * 255, 0, 255),
            clamp(b * depth * grit * steep * 255, 0, 255)
        ];
    };

    const vertexFor = (tile, kind, idx, i, j, slope) => {
        const existing = tile.index.get(idx);
        if (existing !== undefined) return existing;
        const x = at(i), z = at(j), y = heights[idx];
        const [r, g, b] = tint(x, y, z, slope, kind);
        const v = tile.surface.vertex(
            x, y, z,
            normals[idx * 3], normals[idx * 3 + 1], normals[idx * 3 + 2],
            x / UV[kind], z / UV[kind],
            r, g, b
        );
        tile.index.set(idx, v);
        return v;
    };

    for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
            const a = j * N + i, b = j * N + i + 1, c = (j + 1) * N + i, d = (j + 1) * N + i + 1;
            const x = at(i) + WORLD.step / 2, z = at(j) + WORLD.step / 2;
            const dx = ((heights[b] - heights[a]) + (heights[d] - heights[c])) * 0.5 / WORLD.step;
            const dz = ((heights[c] - heights[a]) + (heights[d] - heights[b])) * 0.5 / WORLD.step;
            const slope = Math.hypot(dx, dz);

            // Rock above a slope threshold, loose ground below it - but the threshold itself is
            // pushed about by low-frequency noise. A fixed one puts the boundary exactly where
            // the slope hovers around it, so on a bench wall the two materials alternate quad by
            // quad and the whole face reads as a row of dithered teeth. Wandering the threshold
            // turns that into patches of scree, which is what a quarry wall looks like anyway.
            const bias = (fbm(x * 0.07, z * 0.07, { octaves: 2, seed: 3 }) - 0.5) * 0.6;
            const kind = padWeight(x, z) > 0.985 ? 'yard' : (slope > 0.7 + bias ? 'rock' : 'ground');
            const tile = tileFor(kind, i, j);
            const surface = tile.surface;

            const va = vertexFor(tile, kind, a, i, j, slope);
            const vb = vertexFor(tile, kind, b, i + 1, j, slope);
            const vc = vertexFor(tile, kind, c, i, j + 1, slope);
            const vd = vertexFor(tile, kind, d, i + 1, j + 1, slope);

            // Split along whichever diagonal joins the closer pair of heights. This is not
            // cosmetic: alternating the diagonal in a checker pattern - the obvious way to avoid
            // a directional grain - corrugates every steep face, because one orientation puts a
            // ridge across the slope and the other a groove. On the 62-degree bench walls and the
            // ravine sides that came out as a row of sawtooth teeth about a metre apart, in the
            // silhouette as well as the shading. Following the terrain instead leaves the creases
            // straight.
            if (Math.abs(heights[b] - heights[c]) < Math.abs(heights[a] - heights[d])) {
                surface.tri(va, vc, vb);
                surface.tri(vb, vc, vd);
            } else {
                surface.tri(va, vc, vd);
                surface.tri(va, vd, vb);
            }
        }
    }

    return { N, heights };
}

// ===========================================================================
// Structures
// ===========================================================================

function buildHangar() {
    const { x, z, width: w, length: l, height: h, door } = HANGAR;
    const t = 0.4;
    const steel = S.steel;

    // Side walls
    addBox(steel, { x: x - w / 2, y: h / 2, z, sx: t, sy: h, sz: l, color: [214, 224, 230], uvScale: UV.steel });
    addBox(steel, { x: x + w / 2, y: h / 2, z, sx: t, sy: h, sz: l, color: [214, 224, 230], uvScale: UV.steel });

    // End walls, each with a doorway. yaw 0 puts the wall in the XY plane, which is what the
    // ends of a hall running down Z are.
    for (const zz of [z - l / 2, z + l / 2]) {
        addWallWithOpening(steel, {
            x, y: 0, z: zz, yaw: 0, width: w, height: h, thickness: t,
            opening: { width: door.width, height: door.height, base: 0, centre: 0 },
            color: [206, 216, 224], uvScale: UV.steel
        });
    }

    // Shallow gable, built as two slabs meeting at the ridge
    const rise = 2.2;
    for (const side of [-1, 1]) {
        const pts = [
            [x + side * w / 2, h, z - l / 2], [x, h + rise, z - l / 2],
            [x, h + rise, z + l / 2], [x + side * w / 2, h, z + l / 2]
        ];
        steel.face(side < 0 ? pts : pts.slice().reverse(), { uvScale: UV.steel, color: [188, 198, 206] });
        // Underside, so the roof is not a single sheet when seen from inside
        const under = pts.map((p) => [p[0], p[1] - 0.25, p[2]]);
        steel.face(side < 0 ? under.slice().reverse() : under, { uvScale: UV.steel, color: [150, 158, 166] });
    }
    // Gable ends
    for (const zz of [z - l / 2, z + l / 2]) {
        const pts = [[x - w / 2, h, zz], [x + w / 2, h, zz], [x, h + rise, zz]];
        steel.face(zz < z ? pts : pts.slice().reverse(), { uvScale: UV.steel, color: [196, 206, 214] });
    }

    // Roof trusses, low enough to matter if you climb inside
    for (let i = 1; i < 6; i++) {
        const zz = z - l / 2 + (l * i) / 6;
        addBox(steel, { x, y: h - 0.5, z: zz, sx: w - t, sy: 0.3, sz: 0.3, color: [130, 140, 150], uvScale: UV.steel });
        addBox(steel, { x, y: h - 0.9, z: zz, sx: 0.3, sy: 1.1, sz: 0.3, color: [130, 140, 150], uvScale: UV.steel });
    }

    // Door frames in hazard paint, and a lamp over each opening
    for (const zz of [z - l / 2, z + l / 2]) {
        const sign = zz < z ? -1 : 1;
        for (const side of [-1, 1]) {
            addBox(S.hazard, {
                x: x + side * (door.width / 2 + 0.25), y: door.height / 2, z: zz + sign * 0.25,
                sx: 0.5, sy: door.height, sz: 0.2, color: [255, 255, 255], uvScale: UV.hazard
            });
        }
        addBox(S.hazard, {
            x, y: door.height + 0.25, z: zz + sign * 0.25,
            sx: door.width + 1, sy: 0.5, sz: 0.2, color: [255, 255, 255], uvScale: UV.hazard
        });
        addBox(S.lamp, {
            x, y: door.height + 0.9, z: zz + sign * 0.3,
            sx: 1.2, sy: 0.35, sz: 0.3, color: [255, 255, 255], uvScale: UV.lamp
        });
    }
}

function buildPlant() {
    const { x, crusherZ, silos, siloRadius, siloHeight, conveyor, legs } = PLANT;

    // Crusher house, stepped concrete, part buried in the slope it stands on
    const ground = terrainHeight(x, crusherZ);
    addBox(S.concrete, { x, y: ground + 3, z: crusherZ, sx: 16, sy: 18, sz: 14, color: [226, 226, 222], uvScale: UV.concrete });
    addBox(S.concrete, { x, y: ground + 13, z: crusherZ + 5, sx: 10, sy: 10, sz: 8, color: [216, 218, 214], uvScale: UV.concrete });
    addBox(S.rust, { x: x + 6, y: ground + 8, z: crusherZ - 5, sx: 4, sy: 12, sz: 4, color: [235, 225, 215], uvScale: UV.rust });
    addBox(S.steel, { x, y: ground + 12.4, z: crusherZ, sx: 17, sy: 0.5, sz: 15, color: [170, 180, 188], uvScale: UV.steel });

    // Silos with conical roofs, on a plinth
    for (const z of silos) {
        addCylinder(S.concrete, {
            x, y: 0, z, r: siloRadius + 0.5, h: 1.2, segments: 28, capTop: true,
            color: [206, 206, 202], uvScale: UV.concrete
        });
        addCylinder(S.concrete, {
            x, y: 1.2, z, r: siloRadius, h: siloHeight - 1.2, segments: 28,
            color: [232, 230, 226], uvScale: UV.concrete
        });
        addCylinder(S.rust, {
            x, y: siloHeight, z, r: siloRadius + 0.2, rTop: 0.4, h: 2.6, segments: 28, capTop: true,
            color: [225, 220, 215], uvScale: UV.rust
        });
        // Hazard band at the base, the way plant is always marked
        addCylinder(S.hazard, {
            x, y: 1.2, z, r: siloRadius + 0.06, h: 1.4, segments: 28,
            color: [255, 255, 255], uvScale: UV.hazard
        });
    }

    // Conveyor. `y0/y1` are the underside of the truss; the racing line goes beneath it.
    addTruss(S.steel, {
        from: [x, conveyor.y0, conveyor.z0], to: [x, conveyor.y1, conveyor.z1],
        width: 3.2, depth: 2.6, bays: 22, color: [178, 190, 198], uvScale: UV.steel
    });
    for (const z of legs) {
        const t = (z - conveyor.z0) / (conveyor.z1 - conveyor.z0);
        const top = mix(conveyor.y0, conveyor.y1, t);
        const base = terrainHeight(x, z);
        for (const side of [-1.4, 1.4]) {
            addBox(S.steel, {
                x: x + side, y: (base + top) / 2 - 1, z, sx: 0.7, sy: top - base + 2, sz: 0.7,
                color: [166, 176, 186], uvScale: UV.steel
            });
        }
        addBox(S.steel, { x, y: base + (top - base) * 0.55, z, sx: 3.5, sy: 0.4, sz: 0.4, color: [166, 176, 186], uvScale: UV.steel });
        addBox(S.concrete, { x, y: base - 0.4, z, sx: 4.6, sy: 1.4, sz: 2.2, color: [200, 200, 196], uvScale: UV.concrete });
    }
    // A lamp on the leg either side of the road crossing, so the gap under the belt is obvious
    for (const z of [-44, -30]) {
        addBox(S.lamp, { x: x + 1.9, y: 6.5, z, sx: 0.5, sy: 0.5, sz: 0.5, color: [255, 255, 255], uvScale: UV.lamp });
    }
}

function buildYard() {
    // Storage tank with a domed top and a wrap-around stair landing
    addCylinder(S.steel, { x: TANK.x, y: 0, z: TANK.z, r: TANK.r, h: TANK.h, segments: 36, color: [196, 208, 212], uvScale: UV.steel });
    addCylinder(S.steel, { x: TANK.x, y: TANK.h, z: TANK.z, r: TANK.r, rTop: 1.2, h: 2.4, segments: 36, capTop: true, color: [186, 198, 204], uvScale: UV.steel });
    addCylinder(S.hazard, { x: TANK.x, y: 0.2, z: TANK.z, r: TANK.r + 0.05, h: 1.2, segments: 36, color: [255, 255, 255], uvScale: UV.hazard });
    addCylinder(S.rust, { x: TANK.x, y: TANK.h - 3, z: TANK.z, r: TANK.r + 0.6, h: 0.25, segments: 36, capTop: true, color: [225, 220, 210], uvScale: UV.rust });
    // Smaller tank for company
    addCylinder(S.rust, { x: 58, y: 0, z: 32, r: 4, h: 9, segments: 24, capTop: true, color: [225, 215, 205], uvScale: UV.rust });

    // Two rows of stacked containers with an alley between them
    const rand = rng(4242);
    for (const z of CONTAINERS.z) {
        for (let x = CONTAINERS.x0; x < CONTAINERS.x1; x += 6.4) {
            const stack = rand() > 0.35 ? 2 : 1;
            for (let k = 0; k < stack; k++) {
                // Vertex colour multiplies the rust texture, which is already a strong brown, so
                // these have to start bright or every container comes out the same mud colour
                const tone = [
                    [255, 168, 140], [190, 225, 255], [250, 246, 200], [190, 240, 190]
                ][Math.floor(rand() * 4)];
                addContainer(x + 3.03, k * 2.62, z + (rand() - 0.5) * 0.6, (rand() - 0.5) * 3, tone);
            }
        }
    }

    // Pipe rack the line ducks under. It runs north-south, across the return leg rather than
    // along it - a rack parallel to the racing line is a wall, not a gate.
    const rackLength = PIPE_RACK.z1 - PIPE_RACK.z0;
    for (const z of [PIPE_RACK.z0, PIPE_RACK.z1]) {
        addBox(S.concrete, { x: PIPE_RACK.x, y: PIPE_RACK.deck / 2, z, sx: 1.1, sy: PIPE_RACK.deck, sz: 1.1, color: [220, 220, 216], uvScale: UV.concrete });
    }
    addBox(S.concrete, {
        x: PIPE_RACK.x, y: PIPE_RACK.deck, z: (PIPE_RACK.z0 + PIPE_RACK.z1) / 2,
        sx: 1.6, sy: 0.5, sz: rackLength + 2, color: [214, 214, 210], uvScale: UV.concrete
    });
    for (const [dx, r, tone] of [[-0.5, 0.45, [235, 220, 205]], [0.5, 0.35, [220, 230, 235]]]) {
        addTube(S.rust,
            [PIPE_RACK.x + dx, PIPE_RACK.deck + 0.7, PIPE_RACK.z0 - 4],
            [PIPE_RACK.x + dx, PIPE_RACK.deck + 0.7, PIPE_RACK.z1 + 4],
            { r, segments: 12, color: tone, uvScale: UV.rust });
    }

    // Site office and a row of drums
    addBox(S.steel, { x: 52, y: 1.6, z: 8, sx: 9, sy: 3.2, sz: 4, color: [214, 218, 210], uvScale: UV.steel });
    addBox(S.dark, { x: 52, y: 2.1, z: 5.9, sx: 6, sy: 1.1, sz: 0.2, uvScale: UV.dark });
    addBox(S.steel, { x: 52, y: 3.35, z: 8, sx: 9.6, sy: 0.3, sz: 4.6, color: [180, 186, 180], uvScale: UV.steel });
    for (let i = 0; i < 9; i++) {
        addCylinder(S.rust, {
            x: 46 + (i % 3) * 0.9, y: 0, z: 14 + Math.floor(i / 3) * 0.9, r: 0.35, h: 0.9,
            segments: 10, capTop: true, color: [240, 200, 170], uvScale: UV.rust
        });
    }

    // Light masts round the yard
    for (const [x, z] of [[10, 30], [58, -14], [2, 42], [46, 26], [-10, 12], [40, -22]]) {
        if (!clearOfLine(x, z, 9)) continue;
        const base = terrainHeight(x, z);
        addCylinder(S.steel, { x, y: base, z, r: 0.22, h: 11, segments: 8, color: [180, 186, 192], uvScale: UV.steel });
        addBox(S.steel, { x, y: base + 11.2, z, sx: 2.4, sy: 0.25, sz: 0.5, color: [170, 176, 182], uvScale: UV.steel });
        for (const dx of [-0.8, 0.8]) {
            addBox(S.lamp, { x: x + dx, y: base + 10.95, z, sx: 0.8, sy: 0.3, sz: 0.5, color: [255, 255, 255], uvScale: UV.lamp });
        }
    }

    // Concrete safety berm along the rim where the haul road reaches the edge, with a gap where
    // the road - and the racing line - goes over
    for (let i = 0; i < 16; i++) {
        const deg = RIM_ENTRY_DEG - 26 + i * 3.4;
        if (Math.abs(deg - RIM_ENTRY_DEG) < 7) continue;
        const a = deg * DEG;
        const r = PIT.rimR - 1.6;
        const x = PIT.x + Math.cos(a) * r, z = PIT.z + Math.sin(a) * r;
        const yaw = -a / DEG;
        addBox(S.concrete, {
            x, y: terrainHeight(x, z) + 0.45, z, yaw,
            sx: 0.6, sy: 0.9, sz: 2.2, color: [222, 220, 214], uvScale: UV.concrete
        });
        if (i % 2 === 0) {
            addBox(S.hazard, {
                x, y: terrainHeight(x, z) + 1.05, z, yaw,
                sx: 0.66, sy: 0.3, sz: 2.2, color: [255, 255, 255], uvScale: UV.hazard
            });
        }
    }
}

function addContainer(x, y, z, yaw, tone) {
    const L = 6.06, W = 2.44, H = 2.59;
    // Corrugated sides: alternating in and out panels, which is most of what makes a container
    // read as one. Ends are flat with a door frame.
    const f = frame(x, y + H / 2, z, yaw);
    const ribs = 20;
    for (const side of [-1, 1]) {
        for (let i = 0; i < ribs; i++) {
            const x0 = -L / 2 + (L * i) / ribs, x1 = -L / 2 + (L * (i + 1)) / ribs;
            const d = (i % 2 === 0 ? W / 2 : W / 2 - 0.08) * side;
            const pts = [
                f(x0, -H / 2, d), f(x1, -H / 2, d), f(x1, H / 2, d), f(x0, H / 2, d)
            ];
            S.rust.face(side < 0 ? pts.slice().reverse() : pts, { uvScale: UV.rust, color: tone });
        }
    }
    for (const end of [-1, 1]) {
        const pts = [
            f((L / 2) * end, -H / 2, -W / 2), f((L / 2) * end, -H / 2, W / 2),
            f((L / 2) * end, H / 2, W / 2), f((L / 2) * end, H / 2, -W / 2)
        ];
        S.rust.face(end > 0 ? pts : pts.slice().reverse(), { uvScale: UV.rust, color: tone });
    }
    const top = [f(-L / 2, H / 2, W / 2), f(L / 2, H / 2, W / 2), f(L / 2, H / 2, -W / 2), f(-L / 2, H / 2, -W / 2)];
    S.rust.face(top, { uvScale: UV.rust, color: tone.map((c) => c * 0.92) });
    const bottom = [f(-L / 2, -H / 2, -W / 2), f(L / 2, -H / 2, -W / 2), f(L / 2, -H / 2, W / 2), f(-L / 2, -H / 2, W / 2)];
    S.rust.face(bottom, { uvScale: UV.rust, color: [120, 120, 120] });
}

// The adit through the rock barrier between the pit floor and the head of the ravine
function buildAdit() {
    const node = canyonAt(ADIT.along);
    const yaw = Math.atan2(node.dir.x, node.dir.z) / DEG;
    const floor = node.y;
    const height = 26;

    addWallWithOpening(S.rock, {
        x: node.x, y: floor - 4, z: node.z, yaw,
        width: ADIT.width, height, thickness: ADIT.thickness,
        opening: { width: ADIT.opening.width, height: ADIT.opening.height, base: 4, centre: 0 },
        color: [216, 210, 200], uvScale: UV.rock
    });

    // Concrete portal frames at each mouth, and lamps inside the bore
    for (const side of [-1, 1]) {
        const f = frame(node.x, floor, node.z, yaw);
        const zz = side * (ADIT.thickness / 2 + 0.25);
        for (const dx of [-1, 1]) {
            const c = f(dx * (ADIT.opening.width / 2 + 0.4), ADIT.opening.height / 2, zz);
            addBox(S.concrete, { x: c[0], y: c[1], z: c[2], yaw, sx: 0.8, sy: ADIT.opening.height + 1.4, sz: 0.5, color: [222, 220, 214], uvScale: UV.concrete });
        }
        const lintel = f(0, ADIT.opening.height + 0.4, zz);
        addBox(S.concrete, { x: lintel[0], y: lintel[1], z: lintel[2], yaw, sx: ADIT.opening.width + 2.4, sy: 0.8, sz: 0.5, color: [222, 220, 214], uvScale: UV.concrete });
        const band = f(0, ADIT.opening.height + 1.1, zz);
        addBox(S.hazard, { x: band[0], y: band[1], z: band[2], yaw, sx: ADIT.opening.width + 2.4, sy: 0.5, sz: 0.3, color: [255, 255, 255], uvScale: UV.hazard });
    }
    for (const t of [-0.28, 0.28]) {
        const f = frame(node.x, floor, node.z, yaw);
        const c = f(0, ADIT.opening.height - 0.3, t * ADIT.thickness);
        addBox(S.lamp, { x: c[0], y: c[1], z: c[2], yaw, sx: 0.9, sy: 0.25, sz: 0.4, color: [255, 255, 255], uvScale: UV.lamp });
    }

    // Clad the slab. Left as a plain box it reads as a monolith dropped across the quarry; broken
    // up with boulders it reads as the spur of rock the adit was driven through.
    const f = frame(node.x, floor, node.z, yaw);
    const rand = rng(1771);
    for (let i = 0; i < 26; i++) {
        const lx = (rand() * 2 - 1) * (ADIT.width / 2);
        const ly = rand() * (height - 5) - 3;
        const face = rand() > 0.5 ? 1 : -1;
        // Never near the bore: the racing line goes through it
        if (Math.abs(lx) < ADIT.opening.width / 2 + 4 && ly < ADIT.opening.height + 4) continue;
        const c = f(lx, ly, face * ADIT.thickness / 2);
        addRock(S.rock, {
            x: c[0], y: c[1], z: c[2], r: 2 + rand() * 3.6, seed: 1200 + i,
            detail: 2, squash: 0.7 + rand() * 0.5,
            color: [206 + rand() * 30, 200 + rand() * 28, 190 + rand() * 26], uvScale: UV.rock
        });
    }
    for (let i = 0; i < 9; i++) {
        const lx = -ADIT.width / 2 + (i + 0.5) * (ADIT.width / 9);
        const c = f(lx, height - 4 + (rand() - 0.5) * 2, (rand() - 0.5) * ADIT.thickness * 0.7);
        addRock(S.rock, {
            x: c[0], y: c[1], z: c[2], r: 3 + rand() * 2.6, seed: 1300 + i,
            detail: 2, squash: 0.85, color: [210, 204, 194], uvScale: UV.rock
        });
    }
}

// The natural arch spanning the ravine near its mouth
function buildArch() {
    const node = canyonAt(ARCH.along);
    // Span across the ravine: perpendicular to the direction of travel
    const sx = node.dir.z, sz = -node.dir.x;
    const segments = 18;
    const ring = [];
    for (let i = 0; i <= segments; i++) {
        const th = (i / segments) * Math.PI;
        const wobble = 1 + (noise2(i * 0.7, 3.1, 71) - 0.5) * 0.16;
        const rIn = ARCH.radius * wobble;
        const rOut = (ARCH.radius + ARCH.band) * (1 + (noise2(i * 0.55, 8.3, 73) - 0.5) * 0.2);
        const c = Math.cos(th), s = Math.sin(th);
        const half = (ARCH.depth / 2) * (1 + (noise2(i * 0.9, 1.7, 79) - 0.5) * 0.3);
        const pt = (r, d) => [
            node.x + sx * c * r + node.dir.x * d,
            node.y + s * r,
            node.z + sz * c * r + node.dir.z * d
        ];
        ring.push({
            inNear: pt(rIn, -half), inFar: pt(rIn, half),
            outNear: pt(rOut, -half), outFar: pt(rOut, half)
        });
    }

    // Winding matters here and is easy to get backwards: the ring's own frame is
    // (span, up, dir), and a face wound the intuitive way about it comes out facing *into* the
    // stone. Rock is a single-sided material, so an inverted arch is an invisible arch.
    const color = [214, 206, 194];
    for (let i = 0; i < segments; i++) {
        const a = ring[i], b = ring[i + 1];
        S.rock.face([a.inFar, b.inFar, b.inNear, a.inNear], { uvScale: UV.rock, color });     // soffit
        S.rock.face([a.outNear, b.outNear, b.outFar, a.outFar], { uvScale: UV.rock, color }); // extrados
        S.rock.face([a.outFar, b.outFar, b.inFar, a.inFar], { uvScale: UV.rock, color });     // far cheek
        S.rock.face([a.inNear, b.inNear, b.outNear, a.outNear], { uvScale: UV.rock, color }); // near cheek
    }
    // Bury the feet so the arch grows out of the ravine floor rather than resting on it
    for (const end of [ring[0], ring[segments]]) {
        const c = [
            (end.inNear[0] + end.outFar[0]) / 2, node.y - 2,
            (end.inNear[2] + end.outFar[2]) / 2
        ];
        addRock(S.rock, { x: c[0], y: c[1], z: c[2], r: 4.6, seed: 31 + end.inNear[0], detail: 2, squash: 1.1, color, uvScale: UV.rock });
    }
}

// ===========================================================================
// Scatter - boulders, rubble, trees and abandoned plant
// ===========================================================================

function scatter() {
    const rand = rng(90210);

    // Boulders across the whole basin, thicker on the quarry benches
    for (let i = 0; i < 900; i++) {
        const x = (rand() * 2 - 1) * 140;
        const z = (rand() * 2 - 1) * 140;
        const y = terrainHeight(x, z);
        if (y > 40) continue;                       // not up the basin walls
        const inPit = Math.hypot(x - PIT.x, z - PIT.z) < PIT.rimR;
        if (!inPit && rand() > 0.55) continue;
        if (padWeight(x, z) > 0.5 || roadWeight(x, z) > 0.5) continue;
        if (!clearOfLine(x, z, 7)) continue;
        const r = 0.5 + rand() * rand() * 3.4;
        addRock(S.rock, {
            x, y: y + r * 0.35, z, r, seed: (i * 37) % 9973,
            detail: r > 1.8 ? 2 : 1, squash: 0.6 + rand() * 0.4,
            color: [200 + rand() * 40, 196 + rand() * 36, 188 + rand() * 34], uvScale: UV.rock
        });
    }

    // Rubble heaps against the bench walls
    for (let i = 0; i < 60; i++) {
        const a = rand() * Math.PI * 2;
        const r = PIT.floorR + rand() * (PIT.rimR - PIT.floorR - 4);
        const x = PIT.x + Math.cos(a) * r, z = PIT.z + Math.sin(a) * r;
        if (!clearOfLine(x, z, 9)) continue;
        const y = terrainHeight(x, z);
        const size = 2.5 + rand() * 4;
        addRock(S.ground, {
            x, y: y + size * 0.2, z, r: size, seed: 500 + i, detail: 1, squash: 0.32,
            color: [206, 190, 168], uvScale: UV.ground
        });
    }

    // Conifers on the basin slopes above the quarry
    for (let i = 0; i < 320; i++) {
        const x = (rand() * 2 - 1) * 148;
        const z = (rand() * 2 - 1) * 148;
        const y = terrainHeight(x, z);
        if (y < 6 || y > 46) continue;
        if (Math.hypot(x - PIT.x, z - PIT.z) < PIT.rimR + 6) continue;
        if (!clearOfLine(x, z, 12)) continue;
        const h = 5 + rand() * 7;
        addCylinder(S.timber, { x, y: y - 0.4, z, r: 0.22, h: h * 0.4, segments: 6, color: [230, 220, 210], uvScale: UV.timber });
        for (let k = 0; k < 3; k++) {
            const base = y + h * (0.22 + k * 0.24);
            addCylinder(S.foliage, {
                x, y: base, z, r: (2.1 - k * 0.55) * (0.8 + rand() * 0.3), rTop: 0.05,
                h: h * 0.42, segments: 8, capBottom: true,
                color: [200 + rand() * 55, 220 + rand() * 35, 190 + rand() * 40], uvScale: UV.foliage
            });
        }
    }

    // A dead haul truck on the pit floor and a second one in the yard
    addHaulTruck(PIT.x + 4, PIT.z + 6, 35);
    addHaulTruck(38, 20, -105);

    // Spoil cones beside the crusher
    for (let i = 0; i < 5; i++) {
        const x = PLANT.x + 12 + i * 7, z = PLANT.crusherZ + 12 + (i % 2) * 8;
        if (!clearOfLine(x, z, 10)) continue;
        addCylinder(S.ground, {
            x, y: terrainHeight(x, z) - 0.5, z, r: 5 - i * 0.4, rTop: 0.3, h: 4.5 - i * 0.3,
            segments: 16, capTop: true, color: [214, 196, 172], uvScale: UV.ground
        });
    }
}

function addHaulTruck(x, z, yaw) {
    const y = terrainHeight(x, z);
    const f = frame(x, y, z, yaw);
    const body = (lx, ly, lz, sx, sy, sz, surface, color, uvScale) => {
        const c = f(lx, ly, lz);
        addBox(surface, { x: c[0], y: c[1], z: c[2], yaw, sx, sy, sz, color, uvScale });
    };
    body(0, 1.5, 0.6, 3.2, 1.2, 7, S.rust, [230, 190, 120], UV.rust);        // chassis
    body(0, 3.1, -2.2, 3.0, 2.0, 2.4, S.rust, [235, 200, 130], UV.rust);     // cab
    body(0, 3.4, 1.6, 3.6, 2.2, 4.6, S.rust, [200, 190, 180], UV.rust);      // skip
    body(0, 2.4, -3.5, 3.4, 0.8, 0.6, S.dark, [255, 255, 255], UV.dark);     // bumper
    for (const [lx, lz] of [[-1.7, -1.8], [1.7, -1.8], [-1.7, 2], [1.7, 2]]) {
        addTube(S.dark, f(lx - 0.35, 1.1, lz), f(lx + 0.35, 1.1, lz), {
            r: 1.1, segments: 14, uvScale: UV.dark
        });
    }
}

// ===========================================================================
// The racing line
// ===========================================================================

// The line is a closed polyline of waypoints; the ones marked `gate` become rings. Each gate's
// orientation is the local tangent, so a ring is always square to the line through it and the
// yaw/pitch that end up in tracks.js are derived, never guessed.
function buildRaceLine() {
    const line = [];
    const via = (x, y, z) => line.push({ x, y, z });
    const gate = (name, x, y, z, radius) => line.push({ x, y, z, gate: true, name, radius });
    const ground = (x, z, h) => terrainHeight(x, z) + h;

    // --- the yard: start straight and the shed ---
    gate('START / FINISH', HANGAR.x, 3.0, 26, 2.4);
    gate('SHED IN', HANGAR.x, 3.3, HANGAR.z + HANGAR.length / 2 - 0.2, 2.4);
    via(HANGAR.x, 3.3, HANGAR.z);
    gate('SHED OUT', HANGAR.x, 3.3, HANGAR.z - HANGAR.length / 2 + 0.2, 2.4);

    // --- out along the haul road, under the conveyor ---
    via(HANGAR.x, 3.6, -26);
    gate('THE BELT', CONVEYOR_CROSS.x, ground(CONVEYOR_CROSS.x, CONVEYOR_CROSS.z, 4.0), CONVEYOR_CROSS.z, 2.8);

    // --- over the rim and down the benches ---
    const spiralPoint = (deg, r, y) => ({
        x: PIT.x + Math.cos(deg * DEG) * r,
        y: PIT.rimY + y,
        z: PIT.z + Math.sin(deg * DEG) * r
    });
    for (let i = 0; i < SPIRAL.length; i++) {
        const k = SPIRAL[i];
        const p = spiralPoint(k.deg, k.r, k.y);
        gate(k.name, p.x, p.y, p.z, k.radius);
        // Follow the bowl between gates rather than cutting the chord, so the surveyed length
        // and the clearance check both describe the line a pilot would actually fly
        const next = SPIRAL[i + 1];
        if (next) {
            const steps = Math.max(1, Math.round(Math.abs(next.deg - k.deg) / 18));
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const q = spiralPoint(mix(k.deg, next.deg, t), mix(k.r, next.r, t), mix(k.y, next.y, t));
                via(q.x, q.y, q.z);
            }
        }
    }

    // --- across the floor and into the mouth of the cut ---
    const head = canyonAt(0);
    via(head.x, head.y + 4.5, head.z);

    // --- through the adit into the ravine ---
    const aditNode = canyonAt(ADIT.along);
    gate('THE ADIT', aditNode.x, aditNode.y + 3.2, aditNode.z, 2.2);

    // --- up the ravine, sampled along the centreline ---
    const stops = [];
    for (let a = ADIT.along + 6; a <= CANYON_LENGTH - 4; a += 6.5) stops.push(a);
    stops.push(CANYON_LENGTH - 2);
    for (const a of stops) {
        const node = canyonAt(a);
        const g = CANYON_GATES.find((cg) => Math.abs(cg.along - a) < 3.25);
        const arch = Math.abs(a - ARCH.along) < 3.25;
        const y = node.y + 4.5;
        if (arch) {
            const at = canyonAt(ARCH.along);
            // Under the crown of the arch: 4 m up with a 3 m ring leaves a metre of soffit
            gate('THE ARCH', at.x, at.y + 4.0, at.z, 3.0);
        } else if (g) {
            const at = canyonAt(g.along);
            gate(g.name, at.x, at.y + 4.5, at.z, g.radius);
        } else {
            via(node.x, y, node.z);
        }
    }

    // --- back into the yard, along the container alley ---
    via(-18, ground(-18, 54, 4.2), 54);
    const alleyZ = (CONTAINERS.z[0] + CONTAINERS.z[1]) / 2;
    via(-4, 3.4, alleyZ);
    gate('CONTAINER RUN', 14, 3.2, alleyZ, 2.5);
    via(30, 3.6, alleyZ + 1);

    // --- hairpin round the tank ---
    via(42, 4.2, 58);
    via(54, 4.6, 54);
    gate('TANK TURN', 57, 5.0, 44, 2.6);
    // Wide of the tank: the hairpin exit has to clear its 8 m wall on the way back west
    via(52, 4.6, 36);

    // --- under the pipe rack and back onto the start straight ---
    gate('PIPE RACK', PIPE_RACK.x, 4.0, 34, 2.4);
    via(26, 3.4, 32);
    via(HANGAR.x, 3.0, 30);

    return line;
}

// Tangent-derived orientation for each gate, plus the surveyed lap length
function surveyGates(line) {
    const n = line.length;
    const gates = [];
    let lapLength = 0;
    for (let i = 0; i < n; i++) {
        const a = line[i], b = line[(i + 1) % n];
        lapLength += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }

    for (let i = 0; i < n; i++) {
        if (!line[i].gate) continue;
        const prev = line[(i - 1 + n) % n];
        const next = line[(i + 1) % n];
        const dx = next.x - prev.x, dy = next.y - prev.y, dz = next.z - prev.z;
        const len = Math.hypot(dx, dy, dz);
        // Matches the convention in tracks.js: 0 faces -Z, +90 faces +X, pitch lifts out of level
        const yaw = Math.atan2(dx, -dz) / DEG;
        const pitch = Math.asin(clamp(dy / len, -1, 1)) / DEG;
        gates.push({
            name: line[i].name,
            x: line[i].x, y: line[i].y, z: line[i].z,
            yaw, pitch, radius: line[i].radius, index: i
        });
    }
    return { gates, lapLength };
}

// ===========================================================================
// Build
// ===========================================================================

function selfTest() {
    // Winding: a box built by addBox must have every face pointing outwards. Get this wrong and
    // half the map is invisible from the outside, which is not something a file size check finds.
    const probe = new Surface('probe', 0);
    addBox(probe, { x: 0, y: 0, z: 0, sx: 2, sy: 2, sz: 2, uvScale: 1 });
    const nrm = probe.nrm.view();
    const pos = probe.pos.view();
    for (let i = 0; i < probe.vertexCount; i++) {
        const dot = pos[i * 3] * nrm[i * 3] + pos[i * 3 + 1] * nrm[i * 3 + 1] + pos[i * 3 + 2] * nrm[i * 3 + 2];
        if (dot <= 0) throw new Error('addBox produced an inward-facing normal');
    }

    // Cylinder sides must face outwards, and the top cap upwards
    const cyl = new Surface('cyl', 0);
    addCylinder(cyl, { x: 0, y: 0, z: 0, r: 1, h: 2, segments: 8, capTop: true, capBottom: true, uvScale: 1 });
    const cn = cyl.nrm.view(), cp = cyl.pos.view();
    let sawUp = false, sawDown = false;
    for (let i = 0; i < cyl.vertexCount; i++) {
        const ny = cn[i * 3 + 1];
        if (Math.abs(ny) < 0.5) {
            const dot = cp[i * 3] * cn[i * 3] + cp[i * 3 + 2] * cn[i * 3 + 2];
            if (dot <= 0) throw new Error('addCylinder side faces inwards');
        } else if (ny > 0.5) sawUp = true;
        else sawDown = true;
    }
    if (!sawUp || !sawDown) throw new Error('addCylinder caps are missing or inverted');

    // A tube laid along +X: side normals must point away from the axis, and each cap along it
    const tube = new Surface('tube', 0);
    addTube(tube, [0, 0, 0], [4, 0, 0], { r: 1, segments: 8, uvScale: 1 });
    const tn = tube.nrm.view(), tp = tube.pos.view();
    let capNear = false, capFar = false;
    for (let i = 0; i < tube.vertexCount; i++) {
        const nx = tn[i * 3], ny = tn[i * 3 + 1], nz = tn[i * 3 + 2];
        if (Math.abs(nx) > 0.9) {
            if (nx > 0 && tp[i * 3] > 3.9) capFar = true;
            else if (nx < 0 && tp[i * 3] < 0.1) capNear = true;
            else throw new Error('addTube cap faces the wrong way');
        } else if (ny * tp[i * 3 + 1] + nz * tp[i * 3 + 2] <= 0) {
            throw new Error('addTube side faces inwards');
        }
    }
    if (!capNear || !capFar) throw new Error('addTube caps are missing');
}

// The arch band is the one piece of single-sided geometry in the map whose winding is not
// obvious from the code - its faces are wound about the ring's own (span, up, dir) frame, and
// the intuitive order faces into the stone. Rock is single-sided, so an inverted arch is an
// invisible one, which is exactly the sort of thing a file-size check sails past.
function verifyArch(firstVertex) {
    const node = canyonAt(ARCH.along);
    const pos = S.rock.pos.view();
    const nrm = S.rock.nrm.view();
    let up = 0, down = 0;
    for (let v = firstVertex; v < S.rock.vertexCount; v++) {
        const dx = pos[v * 3] - node.x, dy = pos[v * 3 + 1] - node.y, dz = pos[v * 3 + 2] - node.z;
        // Outer skin, near the crown
        if (dy < ARCH.radius * 0.85) continue;
        if (Math.hypot(dx, dy, dz) < ARCH.radius + 1.2) continue;
        if (nrm[v * 3 + 1] > 0.5) up++;
        if (nrm[v * 3 + 1] < -0.5) down++;
    }
    if (down > 0) throw new Error('the arch is wound inside out - its outer face points downwards');
    if (up < 3) throw new Error('arch winding check found no crown faces to check');
}

function main() {
    const t0 = Date.now();
    selfTest();

    console.log('Generating textures...');
    const images = [
        { name: 'rock', png: encodePNG(TEX_SIZE.rock, TEX_SIZE.rock, textures.rockTexture(TEX_SIZE.rock)) },
        { name: 'ground', png: encodePNG(TEX_SIZE.ground, TEX_SIZE.ground, textures.groundTexture(TEX_SIZE.ground)) },
        { name: 'yard', png: encodePNG(TEX_SIZE.yard, TEX_SIZE.yard, textures.concreteTexture(TEX_SIZE.yard, 909, [150, 148, 143])) },
        { name: 'concrete', png: encodePNG(TEX_SIZE.concrete, TEX_SIZE.concrete, textures.concreteTexture(TEX_SIZE.concrete)) },
        { name: 'steel', png: encodePNG(TEX_SIZE.steel, TEX_SIZE.steel, textures.steelTexture(TEX_SIZE.steel)) },
        { name: 'rust', png: encodePNG(TEX_SIZE.rust, TEX_SIZE.rust, textures.rustTexture(TEX_SIZE.rust)) },
        { name: 'hazard', png: encodePNG(TEX_SIZE.hazard, TEX_SIZE.hazard, textures.hazardTexture(TEX_SIZE.hazard)) }
    ];
    for (const img of images) console.log(`  ${img.name.padEnd(9)} ${(img.png.length / 1048576).toFixed(2)} MB`);

    console.log('Building the racing line...');
    const line = buildRaceLine();
    LINE_XZ = line.map((p) => [p.x, p.z]);
    const { gates, lapLength } = surveyGates(line);

    console.log('Building terrain...');
    buildTerrain();

    console.log('Building structures...');
    buildHangar();
    buildPlant();
    buildYard();
    buildAdit();
    const archStart = S.rock.vertexCount;
    buildArch();
    verifyArch(archStart);

    console.log('Scattering...');
    scatter();

    const surfaces = allSurfaces().filter((s) => s.vertexCount > 0);
    const byMaterial = new Map();
    for (const s of surfaces) {
        const name = s.name.split('#')[0];
        const row = byMaterial.get(name) || { tris: 0, verts: 0, meshes: 0 };
        row.tris += s.triangleCount; row.verts += s.vertexCount; row.meshes++;
        byMaterial.set(name, row);
    }
    for (const [name, row] of byMaterial) {
        console.log(`  ${name.padEnd(9)} ${String(row.tris).padStart(8)} tris  ${String(row.verts).padStart(8)} verts  ${String(row.meshes).padStart(3)} meshes`);
    }

    console.log('Surveying the course against the triangles...');
    const field = new ClearanceField(surfaces);
    const survey = surveyCourse(field, line, gates);

    console.log('Writing GLB...');
    const stats = writeGLB(OUT_GLB, {
        surfaces, materials: MATERIALS, images,
        generator: 'turtlemode rift-quarry generator'
    });
    const check = verifyGLB(OUT_GLB);

    console.log('');
    console.log(`  ${path.basename(OUT_GLB)}  ${(stats.bytes / 1048576).toFixed(2)} MB`);
    console.log(`  geometry ${((stats.bytes - stats.imageBytes) / 1048576).toFixed(2)} MB   textures ${(stats.imageBytes / 1048576).toFixed(2)} MB`);
    console.log(`  ${stats.triangles.toLocaleString()} triangles, ${stats.vertices.toLocaleString()} vertices, ${stats.meshes} meshes`);
    console.log(`  container check: ${check.problems.length ? check.problems.join('; ') : 'clean'}`);
    console.log('');

    printSurvey(survey, gates, lapLength);

    fs.writeFileSync(OUT_SURVEY, JSON.stringify({
        map: 'rift-quarry',
        lapLength: Math.round(lapLength),
        spawn: SPAWN,
        gates: gates.map((g) => ({
            name: g.name,
            x: round(g.x), y: round(g.y), z: round(g.z),
            yaw: round(g.yaw), pitch: round(g.pitch), radius: g.radius
        })),
        clearance: survey
    }, null, 2));

    const previewFlag = process.argv.indexOf('--preview');
    if (previewFlag >= 0) {
        console.log('\nRendering previews...');
        writePreviews(process.argv[previewFlag + 1] || path.resolve(HERE, 'preview'));
    }

    console.log(`\nSurvey written to ${path.relative(process.cwd(), OUT_SURVEY)}`);
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    if (check.problems.length) process.exitCode = 1;
    if (survey.worstGate.clearance < 0.35 || survey.worstLeg.clearance < 1.0) {
        console.error('\nFAIL: the course does not fit the map. Adjust the layout above and rerun.');
        process.exitCode = 1;
    }
}

const round = (v) => Math.round(v * 100) / 100;

// `--preview <dir>` renders the finished geometry from a handful of viewpoints, so the shape of
// the map can be checked without loading it in a browser. Approximate flat colours - the textures
// are not sampled - but it shows form, scale and anything facing the wrong way.
const PREVIEW_TONE = {
    rock: [150, 140, 128], ground: [162, 142, 116], yard: [150, 148, 143], concrete: [186, 184, 178],
    steel: [128, 146, 160], rust: [148, 104, 76], hazard: [206, 172, 60], dark: [40, 44, 50],
    lamp: [255, 236, 190], foliage: [66, 92, 54], timber: [92, 70, 48]
};

const PREVIEW_VIEWS = [
    { name: '1-overview', eye: [150, 190, 210], target: [-40, -14, -20], fov: 52 },
    { name: '2-start-grid', eye: [SPAWN.x, 2.6, SPAWN.z + 4], target: [HANGAR.x, 4, -30], fov: 78 },
    { name: '3-rim', eye: [-14, 9, -34], target: [-58, -18, -50], fov: 80 },
    { name: '4-pit-floor', eye: [-64, -16.5, -50], target: [-55, -14, -12], fov: 82 },
    { name: '5-ravine', eye: [-30, 4, 50], target: [-50, -12, -6], fov: 80 },
    { name: '6-yard', eye: [60, 26, 70], target: [10, 2, 10], fov: 62 },
    { name: '7-benches', eye: [-38, -2, -60], target: [-58, -10, -50], fov: 66 }
];

function writePreviews(dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const view of PREVIEW_VIEWS) {
        const png = render(allSurfaces(), PREVIEW_TONE, view);
        fs.writeFileSync(path.join(dir, `${view.name}.png`), png);
        console.log(`  ${view.name}.png`);
    }
}

function surveyCourse(field, line, gates) {
    const legs = [];
    const rings = [];
    let worstLeg = { clearance: Infinity };
    let worstGate = { clearance: Infinity };

    // Every leg of the flown polyline
    for (let i = 0; i < line.length; i++) {
        const a = line[i], b = line[(i + 1) % line.length];
        const r = field.sampleSegment(a, b, { step: 0.4, maxDist: 9 });
        const entry = {
            from: a.name || `via ${i}`, to: b.name || `via ${(i + 1) % line.length}`,
            clearance: round(r.clearance), length: round(r.length),
            at: r.at ? { x: round(r.at.x), y: round(r.at.y), z: round(r.at.z) } : null
        };
        legs.push(entry);
        if (r.clearance < worstLeg.clearance) worstLeg = entry;
    }

    // Every ring
    for (const g of gates) {
        const yaw = g.yaw * DEG, pitch = g.pitch * DEG;
        const normal = {
            x: Math.sin(yaw) * Math.cos(pitch),
            y: Math.sin(pitch),
            z: -Math.cos(yaw) * Math.cos(pitch)
        };
        const r = field.sampleRing(g, normal, g.radius, { samples: 64, maxDist: 9 });
        const entry = { name: g.name, radius: g.radius, clearance: round(r.clearance) };
        rings.push(entry);
        if (r.clearance < worstGate.clearance) worstGate = entry;
    }

    // Both spawns: the drone has to stand on something in practice and in race mode
    const spawns = {
        practice: round(field.nearest(0, 1, 0, 9)),
        race: round(field.nearest(SPAWN.x, SPAWN.y, SPAWN.z, 9)),
        practiceGround: round(terrainHeight(0, 0)),
        raceGround: round(terrainHeight(SPAWN.x, SPAWN.z))
    };

    return { legs, rings, spawns, worstLeg, worstGate };
}

function printSurvey(survey, gates, lapLength) {
    console.log('GATE RINGS (clearance from the ring itself to the nearest triangle)');
    for (const r of survey.rings) {
        const flag = r.clearance < 0.5 ? '  <-- tight' : '';
        console.log(`  ${r.name.padEnd(16)} r=${String(r.radius).padEnd(5)} ${r.clearance.toFixed(2)} m${flag}`);
    }
    console.log('\nTIGHTEST LEGS (straight line between waypoints)');
    const sorted = survey.legs.slice().sort((a, b) => a.clearance - b.clearance).slice(0, 8);
    for (const l of sorted) {
        console.log(`  ${(l.from + ' -> ' + l.to).padEnd(38)} ${l.clearance.toFixed(2)} m  at ${l.at ? `${l.at.x}, ${l.at.y}, ${l.at.z}` : '-'}`);
    }
    console.log('\nSPAWNS');
    console.log(`  practice (0, 1, 0)  ground ${survey.spawns.practiceGround} m, nearest surface ${survey.spawns.practice} m`);
    console.log(`  race grid           ground ${survey.spawns.raceGround} m, nearest surface ${survey.spawns.race} m`);
    console.log(`\nLap: ${gates.length} gates, ${Math.round(lapLength)} m of flown line`);
}

main();
