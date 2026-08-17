// textures.mjs - procedural surface textures, generated straight to PNG.
//
// Every texture tiles: the map's UVs are a world-space planar projection, so a texture repeats
// every few metres and is never unwrapped. That means the noise has to be periodic, which is what
// `wrap` does below - it samples the noise on a torus so the left edge meets the right one.
//
// Per-pixel grain is added last and deliberately. It is what a rock face looks like from 30 cm
// away in FPV, and it is also most of the file: noise is incompressible, so the grain is the
// difference between a 300 KB texture and a 2 MB one.

import { fbm, ridged, cellular, noise2, rng, clamp, mix, smoothstep } from './noise.mjs';

// Samples a noise function on a torus of period `period` in tile space, so the result tiles
// seamlessly at the texture edge.
function wrapped(fn, u, v, period, args) {
    const a = (u % period + period) % period;
    const b = (v % period + period) % period;
    const wa = a / period, wb = b / period;
    // Bilinear blend of the four wrapped samples - cheap, and any seam it leaves is far below
    // the grain that goes on top.
    const s00 = fn(a, b, args);
    const s10 = fn(a - period, b, args);
    const s01 = fn(a, b - period, args);
    const s11 = fn(a - period, b - period, args);
    return mix(mix(s00, s10, wa), mix(s01, s11, wa), wb);
}

class Canvas {
    constructor(size) {
        this.size = size;
        this.data = new Uint8Array(size * size * 3);
    }

    set(i, r, g, b) {
        this.data[i * 3] = clamp(Math.round(r), 0, 255);
        this.data[i * 3 + 1] = clamp(Math.round(g), 0, 255);
        this.data[i * 3 + 2] = clamp(Math.round(b), 0, 255);
    }

    // Adds uncorrelated per-pixel noise on top of whatever was painted
    grain(amount, seed) {
        const rand = rng(seed);
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = clamp(this.data[i] + (rand() * 2 - 1) * amount, 0, 255);
        }
        return this.data;
    }
}

// Quarried rock: horizontal bedding planes cut by vertical fracture lines.
export function rockTexture(size, seed = 101) {
    const c = new Canvas(size);
    const P = 6; // noise periods across the tile
    for (let y = 0; y < size; y++) {
        const v = (y / size) * P;
        for (let x = 0; x < size; x++) {
            const u = (x / size) * P;
            const i = y * size + x;

            // Bedding: stretched along u so the strata run horizontally on a wall
            const strata = wrapped((a, b) => fbm(a * 0.5, b * 3.5, { octaves: 3, seed }), u, v, P);
            const grit = wrapped((a, b) => fbm(a * 4, b * 4, { octaves: 3, seed: seed + 7 }), u, v, P);
            const cracks = wrapped((a, b) => cellular(a * 2.2, b * 2.2, seed + 13), u, v, P);

            let shade = 0.62 + strata * 0.5 + grit * 0.22;
            shade *= 0.72 + smoothstep(0.02, 0.16, cracks) * 0.28; // dark fracture lines
            const warm = 0.9 + strata * 0.35;

            c.set(i, 116 * shade * warm, 108 * shade, 97 * shade * (1.05 - strata * 0.15));
        }
    }
    return c.grain(9, seed + 99);
}

// Blasted rock and quarry dust - the flat ground and the benches
export function groundTexture(size, seed = 211) {
    const c = new Canvas(size);
    const P = 5;
    for (let y = 0; y < size; y++) {
        const v = (y / size) * P;
        for (let x = 0; x < size; x++) {
            const u = (x / size) * P;
            const i = y * size + x;

            const stones = wrapped((a, b) => cellular(a * 5, b * 5, seed), u, v, P);
            const fines = wrapped((a, b) => cellular(a * 13, b * 13, seed + 31), u, v, P);
            const patch = wrapped((a, b) => fbm(a * 1.2, b * 1.2, { octaves: 3, seed: seed + 5 }), u, v, P);

            const stone = smoothstep(0.15, 0.7, stones);
            let shade = 0.55 + stone * 0.4 + fines * 0.18 + patch * 0.3;
            c.set(i, 128 * shade * (0.95 + patch * 0.2), 112 * shade, 92 * shade * (1.02 - patch * 0.1));
        }
    }
    return c.grain(11, seed + 99);
}

// Poured concrete: mottled, stained, with hairline cracks
export function concreteTexture(size, seed = 307, base = [166, 162, 154]) {
    const c = new Canvas(size);
    const P = 4;
    for (let y = 0; y < size; y++) {
        const v = (y / size) * P;
        for (let x = 0; x < size; x++) {
            const u = (x / size) * P;
            const i = y * size + x;

            const mottle = wrapped((a, b) => fbm(a * 1.6, b * 1.6, { octaves: 4, seed }), u, v, P);
            const pores = wrapped((a, b) => cellular(a * 22, b * 22, seed + 17), u, v, P);
            const crack = wrapped((a, b) => cellular(a * 1.7, b * 1.7, seed + 41), u, v, P);
            const stain = wrapped((a, b) => ridged(a * 0.9, b * 2.6, { octaves: 3, seed: seed + 61 }), u, v, P);

            let shade = 0.78 + mottle * 0.3 - (1 - pores) * 0.12;
            shade *= 0.8 + smoothstep(0.015, 0.09, crack) * 0.2;
            shade *= 1 - stain * 0.16;

            c.set(i, base[0] * shade, base[1] * shade, base[2] * shade * (1 - stain * 0.05));
        }
    }
    return c.grain(7, seed + 99);
}

// Painted steel sheet: brushed, panel-lined, and going at the edges
export function steelTexture(size, seed = 401) {
    const c = new Canvas(size);
    const P = 4;
    for (let y = 0; y < size; y++) {
        const v = (y / size) * P;
        for (let x = 0; x < size; x++) {
            const u = (x / size) * P;
            const i = y * size + x;

            const brush = wrapped((a, b) => fbm(a * 30, b * 1.5, { octaves: 2, seed }), u, v, P);
            const wear = wrapped((a, b) => fbm(a * 2.5, b * 2.5, { octaves: 3, seed: seed + 9 }), u, v, P);
            const rustBloom = smoothstep(0.62, 0.9, wear);

            const shade = 0.74 + brush * 0.24 + wear * 0.18;
            const r = mix(88, 150, rustBloom) * shade;
            const g = mix(104, 92, rustBloom) * shade;
            const b = mix(118, 68, rustBloom) * shade;
            c.set(i, r, g, b);
        }
    }
    return c.grain(6, seed + 99);
}

// Corroded steel - containers, plant, machinery
export function rustTexture(size, seed = 503) {
    const c = new Canvas(size);
    const P = 4;
    for (let y = 0; y < size; y++) {
        const v = (y / size) * P;
        for (let x = 0; x < size; x++) {
            const u = (x / size) * P;
            const i = y * size + x;

            const blotch = wrapped((a, b) => fbm(a * 2.2, b * 2.2, { octaves: 4, seed }), u, v, P);
            const pit = wrapped((a, b) => cellular(a * 16, b * 16, seed + 23), u, v, P);
            const streak = wrapped((a, b) => ridged(a * 0.8, b * 5, { octaves: 3, seed: seed + 37 }), u, v, P);

            const rust = clamp(blotch * 1.3 + streak * 0.4 - 0.25, 0, 1);
            const shade = 0.72 + pit * 0.32;
            c.set(
                i,
                mix(122, 158, rust) * shade,
                mix(112, 84, rust) * shade,
                mix(102, 52, rust) * shade
            );
        }
    }
    return c.grain(8, seed + 99);
}

// Diagonal hazard stripes, worn. Tiled at 1 m, so the stripe pitch on a kerb is about 35 cm.
export function hazardTexture(size, seed = 601) {
    const c = new Canvas(size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            const u = x / size, v = y / size;
            // Period chosen so the diagonal meets itself at the tile edge
            const band = ((u + v) * 3) % 1;
            const isYellow = band < 0.5;
            const wear = noise2(u * 14, v * 14, seed) * 0.35 + noise2(u * 40, v * 40, seed + 3) * 0.2;
            const shade = 0.72 + wear;
            if (isYellow) c.set(i, 214 * shade, 176 * shade, 44 * shade);
            else c.set(i, 46 * shade, 44 * shade, 42 * shade);
        }
    }
    return c.grain(7, seed + 99);
}
