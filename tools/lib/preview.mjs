// preview.mjs - a small software rasteriser, so a generated map can be looked at without a
// browser. Flat shading, a z-buffer and one directional light: enough to see whether the quarry
// is quarry-shaped, whether anything is floating, and whether a wall came out inside out.
//
// It renders the same triangle arrays that go into the GLB, so what it draws is what ships.

import { encodePNG } from './glb.mjs';

const SKY = [150, 178, 200];
const LIGHT = (() => {
    const v = [0.45, 0.78, 0.44];
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
})();

// eye/target in world space, fov in degrees
export function render(surfaces, materialTone, { eye, target, fov = 70, width = 960, height = 600 }) {
    const colour = new Uint8Array(width * height * 3);
    const depth = new Float32Array(width * height).fill(Infinity);
    for (let i = 0; i < width * height; i++) {
        // Cheap vertical sky gradient, so up and down are distinguishable
        const t = Math.floor(i / width) / height;
        colour[i * 3] = SKY[0] * (0.82 + t * 0.3);
        colour[i * 3 + 1] = SKY[1] * (0.84 + t * 0.26);
        colour[i * 3 + 2] = SKY[2] * (0.9 + t * 0.18);
    }

    // Camera basis: forward, right, up
    let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl; fy /= fl; fz /= fl;
    // right = forward x worldUp, with worldUp = (0, 1, 0)
    let rx = -fz, ry = 0, rz = fx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    // up = right x forward
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const scale = (height / 2) / Math.tan((fov * Math.PI) / 360);
    const near = 0.25;

    const vx = new Float32Array(3), vy = new Float32Array(3), vz = new Float32Array(3);

    for (const surface of surfaces) {
        if (surface.vertexCount === 0) continue;
        // Terrain tiles are named `<material>#<i>-<j>`, so fall back to the part before the hash
        const tone = materialTone[surface.name]
            || materialTone[surface.name.split('#')[0]]
            || [200, 200, 200];
        const pos = surface.pos.view();
        const nrm = surface.nrm.view();
        const col = surface.col.view();
        const idx = surface.idx.view();

        for (let t = 0; t < idx.length; t += 3) {
            let behind = false;
            for (let k = 0; k < 3; k++) {
                const v = idx[t + k] * 3;
                const dx = pos[v] - eye[0], dy = pos[v + 1] - eye[1], dz = pos[v + 2] - eye[2];
                const cz = dx * fx + dy * fy + dz * fz;
                if (cz < near) { behind = true; break; }
                vx[k] = (dx * rx + dy * ry + dz * rz) / cz * scale + width / 2;
                vy[k] = height / 2 - (dx * ux + dy * uy + dz * uz) / cz * scale;
                vz[k] = cz;
            }
            if (behind) continue;

            const minX = Math.max(0, Math.floor(Math.min(vx[0], vx[1], vx[2])));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(vx[0], vx[1], vx[2])));
            const minY = Math.max(0, Math.floor(Math.min(vy[0], vy[1], vy[2])));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(vy[0], vy[1], vy[2])));
            if (minX > maxX || minY > maxY) continue;

            const area = (vx[1] - vx[0]) * (vy[2] - vy[0]) - (vx[2] - vx[0]) * (vy[1] - vy[0]);
            if (Math.abs(area) < 1e-9) continue;

            // Normals and colours are interpolated across the face rather than taken from one
            // vertex. On the terrain that matters: it is a smooth-normal mesh, and flat shading
            // it turns every rapidly-turning surface - a quarry bench wall, say - into a moire of
            // sawtooth facets that look like broken geometry and are not in the mesh at all.
            const ia = idx[t] * 3, ib = idx[t + 1] * 3, ic = idx[t + 2] * 3;
            const ca = idx[t] * 4, cb = idx[t + 1] * 4, cc = idx[t + 2] * 4;

            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const px = x + 0.5, py = y + 0.5;
                    const w0 = ((vx[1] - px) * (vy[2] - py) - (vx[2] - px) * (vy[1] - py)) / area;
                    const w1 = ((vx[2] - px) * (vy[0] - py) - (vx[0] - px) * (vy[2] - py)) / area;
                    const w2 = 1 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    const z = w0 * vz[0] + w1 * vz[1] + w2 * vz[2];
                    const o = y * width + x;
                    if (z >= depth[o]) continue;
                    depth[o] = z;

                    const nx = w0 * nrm[ia] + w1 * nrm[ib] + w2 * nrm[ic];
                    const ny = w0 * nrm[ia + 1] + w1 * nrm[ib + 1] + w2 * nrm[ic + 1];
                    const nz = w0 * nrm[ia + 2] + w1 * nrm[ib + 2] + w2 * nrm[ic + 2];
                    const nl = Math.hypot(nx, ny, nz) || 1;
                    const lambert = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / nl);
                    const shade = 0.32 + 0.68 * lambert;

                    const r = (tone[0] * (w0 * col[ca] + w1 * col[cb] + w2 * col[cc])) / 255 * shade;
                    const g = (tone[1] * (w0 * col[ca + 1] + w1 * col[cb + 1] + w2 * col[cc + 1])) / 255 * shade;
                    const b = (tone[2] * (w0 * col[ca + 2] + w1 * col[cb + 2] + w2 * col[cc + 2])) / 255 * shade;

                    // Distance haze, matching the fog the map is meant to be seen through
                    const haze = Math.min(1, Math.max(0, (z - 60) / 420));
                    colour[o * 3] = r + (SKY[0] - r) * haze;
                    colour[o * 3 + 1] = g + (SKY[1] - g) * haze;
                    colour[o * 3 + 2] = b + (SKY[2] - b) * haze;
                }
            }
        }
    }

    return encodePNG(width, height, colour);
}
