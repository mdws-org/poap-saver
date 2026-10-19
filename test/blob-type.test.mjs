/* A preview blob never carries a type the browser would run as a page.
 * Artwork bytes and their Content-Type come from third-party hosts, and the
 * preview URL is used as a link: opened as text/html or image/svg+xml, it runs
 * script in the origin that serves this app. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "web", "app.js"), "utf8");

test("no blob is built from the response's own Content-Type", () => {
    assert.deepEqual(APP.match(/new Blob\(\[bytes\],\s*\{\s*type:\s*ctype/g) || [], []);
});

test("only raster image types survive; everything else becomes a download", () => {
    const m = /function previewType\([\s\S]*?\n    \}\n/.exec(APP);
    assert.ok(m, "web/app.js has no previewType()");
    const previewType = new Function(`${m[0]}; return previewType;`)();
    for (const t of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "", null, undefined])
        assert.equal(previewType(t), "application/octet-stream", String(t));
    assert.equal(previewType("image/png"), "image/png");
    assert.equal(previewType("IMAGE/GIF; charset=binary"), "image/gif");
});
