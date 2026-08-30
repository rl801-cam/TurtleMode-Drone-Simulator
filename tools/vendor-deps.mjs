#!/usr/bin/env node
// vendor-deps.mjs - Fetch the browser dependencies into vendor/.
//
// The page has no bundler and no `npm install`; the importmap in index.html points at committed
// copies under vendor/ rather than at a CDN. That is deliberate. Loading three.js from unpkg meant
// the simulator could not run offline and went dark whenever unpkg did, which for a tool people
// fly on is not an acceptable failure mode. It also means the exact bytes being shipped are in
// git and reviewable, rather than whatever a URL resolves to today.
//
// This script exists so refreshing those copies is reproducible. Run it after changing a version
// in DEPS below; the versions here and the ones documented in project_plan.md are the same fact
// and must be kept in step.
//
//   node tools/vendor-deps.mjs            download anything missing
//   node tools/vendor-deps.mjs --force    re-download everything
//   node tools/vendor-deps.mjs --check    verify every file is present, change nothing
//
// The import graph these five files form closes on itself: GLTFLoader pulls in 'three' and a
// relative BufferGeometryUtils.js, BufferGeometryUtils and three-mesh-bvh pull in 'three', and
// cannon-es imports nothing. Adding a new three.js addon means checking its imports and vendoring
// whatever they reach, or the page will fail on a bare specifier the importmap cannot resolve.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const THREE = '0.160.0';
const CANNON = '0.20.0';
const BVH = '0.7.3';

const DEPS = [
    {
        url: `https://unpkg.com/three@${THREE}/build/three.module.js`,
        path: 'vendor/three/three.module.js'
    },
    {
        url: `https://unpkg.com/three@${THREE}/examples/jsm/loaders/GLTFLoader.js`,
        path: 'vendor/three/addons/loaders/GLTFLoader.js'
    },
    {
        // Imported by the app directly, and also by GLTFLoader via a relative path - which is why
        // it has to sit at exactly this location under addons/
        url: `https://unpkg.com/three@${THREE}/examples/jsm/utils/BufferGeometryUtils.js`,
        path: 'vendor/three/addons/utils/BufferGeometryUtils.js'
    },
    {
        url: `https://unpkg.com/cannon-es@${CANNON}/dist/cannon-es.js`,
        path: 'vendor/cannon-es/cannon-es.js'
    },
    {
        url: `https://unpkg.com/three-mesh-bvh@${BVH}/build/index.module.js`,
        path: 'vendor/three-mesh-bvh/index.module.js'
    }
];

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
    const mode = process.argv[2];
    let missing = 0;

    for (const dep of DEPS) {
        const target = join(root, dep.path);
        const present = await exists(target);

        if (mode === '--check') {
            if (!present) missing++;
            console.log(`  ${present ? 'ok     ' : 'MISSING'} ${dep.path}`);
            continue;
        }

        if (present && mode !== '--force') {
            console.log(`  skip    ${dep.path} (already vendored)`);
            continue;
        }

        const res = await fetch(dep.url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${dep.url}`);
        const body = await res.text();

        // A CDN error page is still a 200 from some hosts, and a truncated module fails at runtime
        // in a way that points nowhere near here. Cheap sanity check on what came back.
        if (!body.trim() || body.trimStart().startsWith('<')) {
            throw new Error(`${dep.url} did not return JavaScript`);
        }

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body);
        console.log(`  wrote   ${dep.path} (${(body.length / 1024).toFixed(0)} KB)`);
    }

    if (mode === '--check' && missing > 0) {
        console.error(`\n${missing} vendored file(s) missing. Run: node tools/vendor-deps.mjs`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
