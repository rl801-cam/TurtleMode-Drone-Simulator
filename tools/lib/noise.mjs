// noise.mjs - seeded value noise and the scalar helpers the generators lean on.
//
// Everything is seeded and integer-hashed rather than drawn from Math.random(), so a given seed
// always produces the same map. That matters more than it sounds: the gate coordinates in
// tracks.js are surveyed against the geometry this produces, so a regenerated map that came out
// even slightly different would quietly bury half the course.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const mix = (a, b, t) => a + (b - a) * t;

export function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

// Quintic - zero first *and* second derivative at the ends, so fbm terrain has no visible
// grid creases along the lattice lines
export function smootherstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
}

// mulberry32 - small, fast, and good enough for scattering rocks
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash2(x, y, seed) {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// Value noise on the unit lattice, in [0, 1]
export function noise2(x, y, seed = 0) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smootherstep(0, 1, xf);
    const v = smootherstep(0, 1, yf);

    const a = hash2(xi, yi, seed);
    const b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed);
    const d = hash2(xi + 1, yi + 1, seed);

    return mix(mix(a, b, u), mix(c, d, u), v);
}

// Fractal sum, in [0, 1]
export function fbm(x, y, { octaves = 4, lacunarity = 2, gain = 0.5, seed = 0 } = {}) {
    let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
    for (let i = 0; i < octaves; i++) {
        sum += amp * noise2(fx, fy, seed + i * 1013);
        norm += amp;
        amp *= gain;
        fx *= lacunarity;
        fy *= lacunarity;
    }
    return sum / norm;
}

// Absolute-value fbm folded back over itself. The creases it leaves read as rock strata and
// erosion channels, which plain fbm never does - plain fbm looks like dunes.
export function ridged(x, y, { octaves = 4, lacunarity = 2, gain = 0.5, seed = 0 } = {}) {
    let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
    for (let i = 0; i < octaves; i++) {
        const n = 1 - Math.abs(noise2(fx, fy, seed + i * 7717) * 2 - 1);
        sum += amp * n * n;
        norm += amp;
        amp *= gain;
        fx *= lacunarity;
        fy *= lacunarity;
    }
    return sum / norm;
}

// Distance to the nearest of a jittered lattice of feature points, normalised to roughly [0, 1].
// Used for gravel, rubble and the cracks in concrete.
export function cellular(x, y, seed = 0) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let best = 4;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const cx = xi + dx, cy = yi + dy;
            const px = cx + hash2(cx, cy, seed);
            const py = cy + hash2(cx, cy, seed + 991);
            const d = (px - x) * (px - x) + (py - y) * (py - y);
            if (d < best) best = d;
        }
    }
    return clamp(Math.sqrt(best) * 1.4, 0, 1);
}

// Shortest distance from (px, pz) to a polyline, plus how far along it that point sits.
// The canyon, the conveyor and the racing line are all polylines, so this does a lot of work.
export function distanceToPolyline(px, pz, points) {
    let best = Infinity;
    let bestT = 0;
    let travelled = 0;
    let bestTravel = 0;

    for (let i = 0; i < points.length - 1; i++) {
        const [ax, az] = points[i];
        const [bx, bz] = points[i + 1];
        const dx = bx - ax, dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
        t = clamp(t, 0, 1);
        const cx = ax + dx * t, cz = az + dz * t;
        const d = Math.hypot(px - cx, pz - cz);
        const segLength = Math.sqrt(lenSq);
        if (d < best) {
            best = d;
            bestT = t;
            bestTravel = travelled + segLength * t;
        }
        travelled += segLength;
    }

    return { distance: best, t: bestT, along: bestTravel, total: travelled };
}
