/* The offline gallery a POAP rescue writes is filled with third-party
 * metadata: names, descriptions and years come from whoever created each event
 * and pass through public gateways. None of it may become markup.
 *
 * The template's script runs here against a small stand-in for the DOM, so the
 * test sees exactly what the page hands to innerHTML. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "web");
const TPL = readFileSync(join(DIR, "gallery-template.html"), "utf8");
const PAYLOAD = '<img src=x onerror="globalThis.__xss=1">';

const row = (over) => ({
    c: "gnosis", t: "123", e: 456, n: "An event", d: "A description",
    y: 2024, img: null, sha: null, uri: "https://api.poap.tech/metadata/456/123", src: null, ...over,
});

/* The script inside a filled template, run against stand-in elements. */
function runGallery(html) {
    const script = /<script>([\s\S]*)<\/script>/i.exec(html)[1];
    const el = () => ({
        innerHTML: "", textContent: "", value: "", children: [], dataset: {},
        addEventListener() {}, querySelector: () => el(), showModal() {}, close() {},
        classList: { toggle() {} },
    });
    const els = {};
    const document = { getElementById: (id) => (els[id] ||= el()) };
    const ctx = { document, globalThis: {} };
    vm.runInNewContext(script, ctx);
    return els;
}

/* Fill the template the safe way, so only the template's own handling of the
 * data is under test here. */
const fillSafely = (rows) =>
    TPL.replace("__DATA__", () => JSON.stringify(rows).replace(/</g, "\\u003c"))
        .replace(/__ADDRESS__/g, "0x0000000000000000000000000000000000000001")
        .replace(/__COUNT__/g, String(rows.length));

test("a year carrying markup does not reach the year chips as markup", () => {
    const els = runGallery(fillSafely([row({ y: PAYLOAD }), row({ y: 2023 })]));
    assert.ok(!els.years.innerHTML.includes("<img"), els.years.innerHTML);
    assert.ok(els.years.innerHTML.includes("2023"), "a real year went missing");
});

test("names, descriptions and years in the cards stay text", () => {
    const els = runGallery(fillSafely([row({ n: PAYLOAD, d: PAYLOAD, y: PAYLOAD })]));
    assert.ok(!els.grid.innerHTML.includes("<img"), els.grid.innerHTML);
});

test("the page fills the template without a '<' in the data inside its script", () => {
    const shared = join(DIR, "gallery.js");
    assert.ok(existsSync(shared), "web/gallery.js, shared by the page and this test, is missing");
    const poapGallery = createRequire(import.meta.url)(shared);
    const hostile = ["<!--<script>", "</script><script>globalThis.__xss=1</script>", "a < b", "<!-- x"];
    const { html } = poapGallery(TPL, "0x0000000000000000000000000000000000000001",
        hostile.map((d) => row({ d, n: d })));
    const data = /var DATA = ([\s\S]*?);\nvar grid/.exec(html)[1];
    assert.ok(!data.includes("<"), "a '<' in the data inside the inline script can change how the browser reads it");
    const els = runGallery(html);
    assert.equal(els.count.textContent, "4 badges", "the data did not load");
});
