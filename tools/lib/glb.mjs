// glb.mjs - a dependency-free glTF 2.0 binary writer, plus the geometry and PNG helpers the
// map generators are built on.
//
// The project has no bundler and no `npm install`, and that holds for the tools as well: this
// writes the container by hand rather than pulling in a glTF library. Everything here is plain
// Node - `zlib` for PNG compression is the only import.

import zlib from 'node:zlib';
import fs from 'node:fs';

// --- growable typed arrays -------------------------------------------------
// A map this size is several million numbers. Plain JS arrays box every one of them, so the
// vertex streams are built straight into typed arrays that double when they fill.

class Growable {
    constructor(Type, capacity = 4096) {
        this.Type = Type;
        this.data = new Type(capacity);
        this.length = 0;
    }

    ensure(extra) {
        if (this.length + extra <= this.data.length) return;
        let capacity = this.data.length;
        while (capacity < this.length + extra) capacity *= 2;
        const next = new this.Type(capacity);
        next.set(this.data.subarray(0, this.length));
        this.data = next;
    }

    push1(a) { this.ensure(1); this.data[this.length++] = a; }
    push2(a, b) { this.ensure(2); this.data[this.length++] = a; this.data[this.length++] = b; }
    push3(a, b, c) { this.ensure(3); this.data[this.length++] = a; this.data[this.length++] = b; this.data[this.length++] = c; }
    push4(a, b, c, d) {
        this.ensure(4);
        this.data[this.length++] = a; this.data[this.length++] = b;
        this.data[this.length++] = c; this.data[this.length++] = d;
    }

    view() { return this.data.subarray(0, this.length); }
}

// --- surfaces --------------------------------------------------------------

// One Surface becomes one mesh with one primitive, so the whole map draws in as many calls as
// there are materials. Vertex colours are always written: they cost 4 bytes a vertex and are
// what stops a tiled texture reading as a repeating grid across a 300 m map.
export class Surface {
    constructor(name, material) {
        this.name = name;
        this.material = material;
        this.pos = new Growable(Float32Array, 1 << 16);
        this.nrm = new Growable(Float32Array, 1 << 16);
        this.uv = new Growable(Float32Array, 1 << 16);
        this.col = new Growable(Uint8Array, 1 << 16);
        this.idx = new Growable(Uint32Array, 1 << 16);
        this.vertexCount = 0;
    }

    vertex(x, y, z, nx, ny, nz, u, v, r, g, b) {
        this.pos.push3(x, y, z);
        this.nrm.push3(nx, ny, nz);
        this.uv.push2(u, v);
        this.col.push4(r, g, b, 255);
        return this.vertexCount++;
    }

    tri(a, b, c) { this.idx.push3(a, b, c); }

    get triangleCount() { return this.idx.length / 3; }

    // A flat-shaded convex n-gon. Points are [x,y,z] in counter-clockwise order seen from the
    // front; the normal comes from the winding (Newell's method, which is stable on the
    // near-degenerate slivers that terrain skirts throw up). UVs are a planar projection onto
    // whichever world plane the face most nearly lies in, so a texture tiles at a fixed number of
    // metres regardless of which way a wall faces and nothing needs unwrapping.
    face(points, { uvScale = 4, color = [255, 255, 255], uvOffset = [0, 0] } = {}) {
        const n = points.length;
        if (n < 3) return;

        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < n; i++) {
            const p = points[i];
            const q = points[(i + 1) % n];
            nx += (p[1] - q[1]) * (p[2] + q[2]);
            ny += (p[2] - q[2]) * (p[0] + q[0]);
            nz += (p[0] - q[0]) * (p[1] + q[1]);
        }
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) return; // degenerate, contributes nothing but a bad normal
        nx /= len; ny /= len; nz /= len;

        // Project along the dominant axis of the normal
        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        let ui = 0, vi = 1;
        if (ay >= ax && ay >= az) { ui = 0; vi = 2; }        // mostly horizontal: use x,z
        else if (ax >= az) { ui = 2; vi = 1; }               // mostly facing x: use z,y
        else { ui = 0; vi = 1; }                             // mostly facing z: use x,y

        const [r, g, b] = color;
        const base = this.vertexCount;
        for (const p of points) {
            this.vertex(
                p[0], p[1], p[2], nx, ny, nz,
                p[ui] / uvScale + uvOffset[0], p[vi] / uvScale + uvOffset[1],
                r, g, b
            );
        }
        for (let i = 1; i < n - 1; i++) this.tri(base, base + i, base + i + 1);
    }

    // Convenience: a quad given in CCW order
    quad(a, b, c, d, opts) { this.face([a, b, c, d], opts); }
}

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const out = Buffer.allocUnsafe(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

// 8-bit RGB, filter type 0 on every scanline. Nothing here needs a smarter filter: the textures
// are noise, which no predictor helps with, and leaving them unfiltered keeps the encoder honest
// about what it is producing.
export function encodePNG(width, height, rgb) {
    const stride = width * 3;
    const raw = Buffer.allocUnsafe(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }

    const ihdr = Buffer.allocUnsafe(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // colour type: truecolour
    ihdr[10] = 0;  // deflate
    ihdr[11] = 0;  // adaptive filtering
    ihdr[12] = 0;  // no interlace

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// --- GLB -------------------------------------------------------------------

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const UNSIGNED_BYTE = 5121;

// materials: [{ name, baseColorFactor, texture, metallic, roughness, emissive, doubleSided }]
// images:    [{ name, png }]  - Buffers, referenced by material.texture as an index
export function writeGLB(path, { surfaces, materials, images = [], generator = 'turtlemode-mapgen' }) {
    const bin = [];
    let binLength = 0;
    const bufferViews = [];
    const accessors = [];

    const pad4 = () => {
        const rem = binLength % 4;
        if (rem === 0) return;
        const fill = Buffer.alloc(4 - rem);
        bin.push(fill);
        binLength += fill.length;
    };

    const addView = (buffer, target) => {
        pad4();
        const view = { buffer: 0, byteOffset: binLength, byteLength: buffer.length };
        if (target) view.target = target;
        bufferViews.push(view);
        bin.push(buffer);
        binLength += buffer.length;
        return bufferViews.length - 1;
    };

    const bufferOf = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);

    const addAccessor = (typed, componentType, type, count, target, extra = {}) => {
        const view = addView(bufferOf(typed), target);
        accessors.push({ bufferView: view, componentType, count, type, ...extra });
        return accessors.length - 1;
    };

    const meshes = [];
    const nodes = [];

    for (const surface of surfaces) {
        if (surface.vertexCount === 0) continue;

        const pos = surface.pos.view();
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
            if (pos[i] < minX) minX = pos[i];
            if (pos[i] > maxX) maxX = pos[i];
            if (pos[i + 1] < minY) minY = pos[i + 1];
            if (pos[i + 1] > maxY) maxY = pos[i + 1];
            if (pos[i + 2] < minZ) minZ = pos[i + 2];
            if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
        }

        const attributes = {
            POSITION: addAccessor(pos, FLOAT, 'VEC3', surface.vertexCount, ARRAY_BUFFER, {
                min: [minX, minY, minZ], max: [maxX, maxY, maxZ]
            }),
            NORMAL: addAccessor(surface.nrm.view(), FLOAT, 'VEC3', surface.vertexCount, ARRAY_BUFFER),
            TEXCOORD_0: addAccessor(surface.uv.view(), FLOAT, 'VEC2', surface.vertexCount, ARRAY_BUFFER),
            COLOR_0: addAccessor(surface.col.view(), UNSIGNED_BYTE, 'VEC4', surface.vertexCount, ARRAY_BUFFER, {
                normalized: true
            })
        };

        const indices = addAccessor(
            surface.idx.view(), UNSIGNED_INT, 'SCALAR', surface.idx.length, ELEMENT_ARRAY_BUFFER
        );

        meshes.push({
            name: surface.name,
            primitives: [{ attributes, indices, material: surface.material }]
        });
        nodes.push({ mesh: meshes.length - 1, name: surface.name });
    }

    const gltfImages = images.map((img) => ({
        name: img.name,
        mimeType: 'image/png',
        bufferView: addView(img.png, undefined)
    }));

    const gltf = {
        asset: { version: '2.0', generator },
        scene: 0,
        scenes: [{ nodes: nodes.map((_, i) => i) }],
        nodes,
        meshes,
        accessors,
        bufferViews,
        buffers: [{ byteLength: binLength }],
        materials: materials.map((m) => {
            const pbr = {
                baseColorFactor: m.baseColorFactor || [1, 1, 1, 1],
                metallicFactor: m.metallic ?? 0,
                roughnessFactor: m.roughness ?? 0.9
            };
            if (m.texture !== undefined && m.texture !== null) {
                pbr.baseColorTexture = { index: m.texture, texCoord: 0 };
            }
            const out = { name: m.name, pbrMetallicRoughness: pbr };
            if (m.emissive) out.emissiveFactor = m.emissive;
            if (m.doubleSided) out.doubleSided = true;
            return out;
        })
    };

    if (gltfImages.length) {
        gltf.images = gltfImages;
        // One sampler for everything: repeat both ways so world-scale UVs tile, trilinear so the
        // ground does not shimmer at range.
        gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
        gltf.textures = gltfImages.map((_, i) => ({ sampler: 0, source: i }));
    }

    const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
    const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
    const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

    const binBuf = Buffer.concat(bin);
    const binPad = (4 - (binBuf.length % 4)) % 4;
    const binChunk = Buffer.concat([binBuf, Buffer.alloc(binPad, 0)]);

    const header = Buffer.allocUnsafe(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

    const jsonHeader = Buffer.allocUnsafe(8);
    jsonHeader.writeUInt32LE(jsonChunk.length, 0);
    jsonHeader.write('JSON', 4, 'ascii');

    const binHeader = Buffer.allocUnsafe(8);
    binHeader.writeUInt32LE(binChunk.length, 0);
    binHeader.write('BIN\0', 4, 'ascii');

    const glb = Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
    fs.writeFileSync(path, glb);

    return {
        bytes: glb.length,
        jsonBytes: jsonChunk.length,
        binBytes: binChunk.length,
        imageBytes: images.reduce((sum, img) => sum + img.png.length, 0),
        meshes: meshes.length,
        triangles: surfaces.reduce((sum, s) => sum + s.triangleCount, 0),
        vertices: surfaces.reduce((sum, s) => sum + s.vertexCount, 0)
    };
}

// Reads back what was just written and checks the container is well formed - chunk lengths,
// accessor extents and index ranges. A GLB that fails here would load as an empty scene in the
// browser, and an empty scene is a map with no collision at all: the drone falls for ever.
export function verifyGLB(path) {
    const buf = fs.readFileSync(path);
    const problems = [];

    if (buf.toString('ascii', 0, 4) !== 'glTF') problems.push('missing glTF magic');
    if (buf.readUInt32LE(4) !== 2) problems.push('not glTF version 2');
    if (buf.readUInt32LE(8) !== buf.length) problems.push('header length does not match file size');

    const jsonLength = buf.readUInt32LE(12);
    if (buf.toString('ascii', 16, 20) !== 'JSON') problems.push('first chunk is not JSON');
    const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));

    const binOffset = 20 + jsonLength;
    const binLength = buf.readUInt32LE(binOffset);
    if (buf.toString('ascii', binOffset + 4, binOffset + 8).replace(/\0/g, '') !== 'BIN') {
        problems.push('second chunk is not BIN');
    }
    if (binOffset + 8 + binLength !== buf.length) problems.push('BIN chunk overruns the file');
    if (gltf.buffers[0].byteLength > binLength) problems.push('buffer longer than the BIN chunk');

    const binStart = binOffset + 8;
    for (const view of gltf.bufferViews) {
        if ((view.byteOffset || 0) + view.byteLength > binLength) {
            problems.push('bufferView runs past the end of the buffer');
        }
        if ((view.byteOffset || 0) % 4 !== 0) problems.push('bufferView is not 4-byte aligned');
    }

    for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives) {
            const posAcc = gltf.accessors[prim.attributes.POSITION];
            const idxAcc = gltf.accessors[prim.indices];
            const view = gltf.bufferViews[idxAcc.bufferView];
            const indices = new Uint32Array(
                buf.buffer, buf.byteOffset + binStart + (view.byteOffset || 0), idxAcc.count
            );
            let max = 0;
            for (let i = 0; i < indices.length; i++) if (indices[i] > max) max = indices[i];
            if (max >= posAcc.count) {
                problems.push(`${mesh.name}: index ${max} past ${posAcc.count} vertices`);
            }
            if (idxAcc.count % 3 !== 0) problems.push(`${mesh.name}: index count is not a multiple of 3`);
            for (const name of ['NORMAL', 'TEXCOORD_0', 'COLOR_0']) {
                const acc = gltf.accessors[prim.attributes[name]];
                if (acc && acc.count !== posAcc.count) {
                    problems.push(`${mesh.name}: ${name} count does not match POSITION`);
                }
            }
        }
    }

    return { problems, meshCount: gltf.meshes.length, materialCount: gltf.materials.length };
}
