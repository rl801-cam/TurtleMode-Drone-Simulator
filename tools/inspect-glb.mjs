// inspect-glb.mjs - read a .glb back and say what is actually in it.
//
//   node tools/inspect-glb.mjs rift-quarry.glb
//   node tools/inspect-glb.mjs rift-quarry.glb --render out/dir
//
// The generator's own preview draws the geometry it holds in memory, which proves nothing about
// the file it then writes. This parses the finished .glb the way the browser will - chunks,
// accessors, buffer views - and can rasterise the result, so a container bug shows up as a
// picture of the map rather than as an empty scene at load time.
//
// It works on any glTF binary, not just the generated one.

import fs from 'node:fs';
import path from 'node:path';
import { render } from './lib/preview.mjs';

const COMPONENT = {
    5120: { array: Int8Array, size: 1 },
    5121: { array: Uint8Array, size: 1 },
    5122: { array: Int16Array, size: 2 },
    5123: { array: Uint16Array, size: 2 },
    5125: { array: Uint32Array, size: 4 },
    5126: { array: Float32Array, size: 4 }
};
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGLB(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');

    const jsonLength = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
    const binStart = 20 + jsonLength + 8;

    const readAccessor = (index) => {
        if (index === undefined) return null;
        const acc = gltf.accessors[index];
        const view = gltf.bufferViews[acc.bufferView];
        const comp = COMPONENT[acc.componentType];
        const count = acc.count * TYPE_COUNT[acc.type];
        const offset = binStart + (view.byteOffset || 0) + (acc.byteOffset || 0);
        // Typed array views need their own alignment; copy rather than assume the file has it
        const bytes = buf.subarray(offset, offset + count * comp.size);
        const copy = Buffer.from(bytes);
        return new comp.array(copy.buffer, copy.byteOffset, count);
    };

    const surfaces = [];
    for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives) {
            const pos = readAccessor(prim.attributes.POSITION);
            const nrm = readAccessor(prim.attributes.NORMAL);
            const col = readAccessor(prim.attributes.COLOR_0);
            const idx = readAccessor(prim.indices);
            const vertexCount = pos.length / 3;
            surfaces.push({
                name: mesh.name || `mesh${surfaces.length}`,
                material: prim.material,
                materialName: prim.material !== undefined ? gltf.materials[prim.material]?.name : null,
                vertexCount,
                triangleCount: idx.length / 3,
                // Shaped like the generator's Surface so the same rasteriser can draw it
                pos: { view: () => pos },
                nrm: { view: () => nrm || new Float32Array(pos.length).fill(0.577) },
                col: { view: () => col || new Uint8Array(vertexCount * 4).fill(255) },
                idx: { view: () => idx }
            });
        }
    }

    return { gltf, surfaces, bytes: buf.length };
}

function bounds(surfaces) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const s of surfaces) {
        const p = s.pos.view();
        for (let i = 0; i < p.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                if (p[i + k] < lo[k]) lo[k] = p[i + k];
                if (p[i + k] > hi[k]) hi[k] = p[i + k];
            }
        }
    }
    return { lo, hi };
}

function main() {
    const file = process.argv[2];
    if (!file) {
        console.error('usage: node tools/inspect-glb.mjs <file.glb> [--render <dir>]');
        process.exit(2);
    }

    const { gltf, surfaces, bytes } = readGLB(file);
    let tris = 0, verts = 0;
    for (const s of surfaces) { tris += s.triangleCount; verts += s.vertexCount; }

    console.log(`${path.basename(file)}  ${(bytes / 1048576).toFixed(2)} MB`);
    console.log(`  generator: ${gltf.asset.generator || 'unknown'}`);
    console.log(`  ${gltf.meshes.length} meshes, ${surfaces.length} primitives, ${(gltf.materials || []).length} materials, ${(gltf.images || []).length} images`);
    console.log(`  ${tris.toLocaleString()} triangles, ${verts.toLocaleString()} vertices`);

    for (const img of gltf.images || []) {
        const view = gltf.bufferViews[img.bufferView];
        console.log(`  image ${String(img.name || '').padEnd(9)} ${img.mimeType} ${(view.byteLength / 1048576).toFixed(2)} MB`);
    }

    const { lo, hi } = bounds(surfaces);
    console.log(`  bounds  x ${lo[0].toFixed(1)}..${hi[0].toFixed(1)}   y ${lo[1].toFixed(1)}..${hi[1].toFixed(1)}   z ${lo[2].toFixed(1)}..${hi[2].toFixed(1)}`);

    const renderFlag = process.argv.indexOf('--render');
    if (renderFlag >= 0) {
        const dir = process.argv[renderFlag + 1];
        fs.mkdirSync(dir, { recursive: true });
        // Frame whatever the file happens to contain, from a corner and above
        const span = Math.max(hi[0] - lo[0], hi[2] - lo[2]);
        const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        const tone = {};
        for (const s of surfaces) tone[s.name] = [190, 186, 180];
        const png = render(surfaces, tone, {
            eye: [mid[0] + span * 0.5, hi[1] + span * 0.45, mid[2] + span * 0.62],
            target: mid, fov: 55
        });
        const out = path.join(dir, `${path.basename(file, '.glb')}-from-file.png`);
        fs.writeFileSync(out, png);
        console.log(`  rendered ${out}`);
    }
}

if (process.argv[1] && process.argv[1].endsWith('inspect-glb.mjs')) main();
