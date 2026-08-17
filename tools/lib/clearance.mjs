// clearance.mjs - "would this line actually fly?", answered against the triangles.
//
// The bando course was surveyed by eye against a downloaded mesh. A generated map can do better:
// the same triangles that become the collision BVH in the browser are here in the generator, so
// every gate ring and every leg of the racing line can be measured before the file is written.
// A gate that ends up inside a wall is caught by a failing build rather than by a pilot.

const CELL = 4; // metres

export class ClearanceField {
    constructor(surfaces) {
        let triangleCount = 0;
        for (const s of surfaces) triangleCount += s.triangleCount;

        this.tris = new Float32Array(triangleCount * 9);
        this.cells = new Map();

        let t = 0;
        for (const surface of surfaces) {
            const pos = surface.pos.view();
            const idx = surface.idx.view();
            for (let i = 0; i < idx.length; i += 3) {
                const o = t * 9;
                for (let k = 0; k < 3; k++) {
                    const v = idx[i + k] * 3;
                    this.tris[o + k * 3] = pos[v];
                    this.tris[o + k * 3 + 1] = pos[v + 1];
                    this.tris[o + k * 3 + 2] = pos[v + 2];
                }
                this.insert(t, o);
                t++;
            }
        }

        this.triangleCount = t;
        this.stamp = new Int32Array(t).fill(-1);
        this.query = 0;
    }

    key(ix, iy, iz) {
        return (ix + 512) + (iy + 512) * 1024 + (iz + 512) * 1048576;
    }

    insert(index, o) {
        const tris = this.tris;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let k = 0; k < 3; k++) {
            const x = tris[o + k * 3], y = tris[o + k * 3 + 1], z = tris[o + k * 3 + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
            for (let iy = Math.floor(minY / CELL); iy <= Math.floor(maxY / CELL); iy++) {
                for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
                    const k = this.key(ix, iy, iz);
                    const bucket = this.cells.get(k);
                    if (bucket) bucket.push(index);
                    else this.cells.set(k, [index]);
                }
            }
        }
    }

    // Distance from a point to the nearest triangle, capped at maxDist. Cheaper than the true
    // distance because everything past the cap is discarded with the cell walk.
    nearest(px, py, pz, maxDist = 8) {
        const q = ++this.query;
        let best = maxDist;

        const lo = (v) => Math.floor((v - maxDist) / CELL);
        const hi = (v) => Math.floor((v + maxDist) / CELL);

        for (let iz = lo(pz); iz <= hi(pz); iz++) {
            for (let iy = lo(py); iy <= hi(py); iy++) {
                for (let ix = lo(px); ix <= hi(px); ix++) {
                    const bucket = this.cells.get(this.key(ix, iy, iz));
                    if (!bucket) continue;
                    for (let i = 0; i < bucket.length; i++) {
                        const t = bucket[i];
                        if (this.stamp[t] === q) continue;
                        this.stamp[t] = q;
                        const d = pointTriangleDistance(px, py, pz, this.tris, t * 9);
                        if (d < best) best = d;
                    }
                }
            }
        }

        return best;
    }

    // Walks a straight leg and reports the tightest point on it. The line a pilot actually flies
    // is a curve through these, so this is a first-order check: it proves the corridor exists,
    // not that every possible line through it is clean.
    sampleSegment(a, b, { step = 0.35, maxDist = 8 } = {}) {
        const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        const steps = Math.max(1, Math.ceil(length / step));
        let worst = Infinity;
        let at = null;

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = a.x + (b.x - a.x) * t;
            const y = a.y + (b.y - a.y) * t;
            const z = a.z + (b.z - a.z) * t;
            const d = this.nearest(x, y, z, maxDist);
            if (d < worst) { worst = d; at = { x, y, z, t }; }
        }

        return { clearance: worst, at, length };
    }

    // The ring itself, not the line through it: samples the circumference so a gate threaded into
    // an opening is checked for actually fitting.
    sampleRing(centre, normal, radius, { samples = 48, maxDist = 8 } = {}) {
        // Any vector not parallel to the normal gives a basis for the ring's plane
        const seed = Math.abs(normal.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
        const ux = seed.y * normal.z - seed.z * normal.y;
        const uy = seed.z * normal.x - seed.x * normal.z;
        const uz = seed.x * normal.y - seed.y * normal.x;
        const ul = Math.hypot(ux, uy, uz);
        const u = { x: ux / ul, y: uy / ul, z: uz / ul };
        const v = {
            x: normal.y * u.z - normal.z * u.y,
            y: normal.z * u.x - normal.x * u.z,
            z: normal.x * u.y - normal.y * u.x
        };

        let worst = Infinity;
        let at = null;
        for (let i = 0; i < samples; i++) {
            const a = (i / samples) * Math.PI * 2;
            const c = Math.cos(a), s = Math.sin(a);
            const x = centre.x + (u.x * c + v.x * s) * radius;
            const y = centre.y + (u.y * c + v.y * s) * radius;
            const z = centre.z + (u.z * c + v.z * s) * radius;
            const d = this.nearest(x, y, z, maxDist);
            if (d < worst) { worst = d; at = { x, y, z, angle: a }; }
        }
        return { clearance: worst, at };
    }
}

// Closest point on a triangle to a point (Ericson, Real-Time Collision Detection s5.1.5),
// returning the distance only.
function pointTriangleDistance(px, py, pz, tris, o) {
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
    const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;

    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);

    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return Math.hypot(apx - abx * v, apy - aby * v, apz - abz * v);
    }

    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return Math.hypot(apx - acx * w, apy - acy * w, apz - acz * w);
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return Math.hypot(
            px - (bx + (cx - bx) * w),
            py - (by + (cy - by) * w),
            pz - (bz + (cz - bz) * w)
        );
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return Math.hypot(
        apx - (abx * v + acx * w),
        apy - (aby * v + acy * w),
        apz - (abz * v + acz * w)
    );
}
