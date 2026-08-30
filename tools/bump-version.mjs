#!/usr/bin/env node
// bump-version.mjs - Advance the cache-busting version across every file that carries it.
//
// The project has no bundler, so module URLs are plain relative paths and browsers cache them
// hard. Each one carries a `?v=N` tag that has to be bumped after any edit, and the `BUILD`
// constant in main.js has to match so the launch menu's stamp tells the truth. That is twelve
// places by hand, across three files, and missing one produces the worst possible failure: a page
// that runs a mixture of old and new modules and looks like a bug in whatever you just changed.
//
// Usage:
//   node tools/bump-version.mjs           bump to the next version
//   node tools/bump-version.mjs 42        set an explicit version
//   node tools/bump-version.mjs --check   report the current version, change nothing
//
// index.html itself cannot be versioned - it is the document that names all the others - so a
// browser holding a stale copy of it will keep requesting the old modules and none of this helps.
// That is what the build stamp in the launch menu is for: check it before debugging a change that
// appears not to have applied.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every file that can carry a version tag. A file with no tags is not an error - it simply has no
// imports that need busting - but a file listed here that goes missing is.
const FILES = ['index.html', 'js/main.js', 'js/ui.js'];

const TAG = /\?v=(\d+)/g;
const BUILD = /const BUILD = 'v(\d+)';/;

async function main() {
    const arg = process.argv[2];
    const sources = new Map();

    for (const file of FILES) {
        sources.set(file, await readFile(join(root, file), 'utf8'));
    }

    // Read the current version off every tag at once, so a file left behind by a half-finished
    // bump is caught here rather than silently carried forward.
    const found = new Set();
    for (const text of sources.values()) {
        for (const [, n] of text.matchAll(TAG)) found.add(Number(n));
        const build = text.match(BUILD);
        if (build) found.add(Number(build[1]));
    }

    if (found.size === 0) {
        console.error('No version tags found. Has the cache-busting scheme changed?');
        process.exit(1);
    }

    const versions = [...found].sort((a, b) => a - b);
    const current = versions[versions.length - 1];

    if (versions.length > 1) {
        console.warn(`Warning: files disagree on the current version (found v${versions.join(', v')}).`);
        console.warn('Bumping will bring them all into line.');
    }

    if (arg === '--check') {
        console.log(`Current version: v${current}`);
        process.exit(versions.length > 1 ? 1 : 0);
    }

    const next = arg === undefined ? current + 1 : Number(arg);
    if (!Number.isInteger(next) || next < 0) {
        console.error(`Not a valid version: ${arg}`);
        process.exit(1);
    }

    let total = 0;
    for (const [file, text] of sources) {
        let count = 0;
        let updated = text.replace(TAG, () => { count++; return `?v=${next}`; });
        updated = updated.replace(BUILD, () => { count++; return `const BUILD = 'v${next}';`; });

        if (count > 0) await writeFile(join(root, file), updated);
        total += count;
        console.log(`  ${relative(root, join(root, file)).padEnd(14)} ${count} tag${count === 1 ? '' : 's'}`);
    }

    console.log(`v${current} -> v${next}  (${total} tags across ${FILES.length} files)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
