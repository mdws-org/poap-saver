/* Fill the offline gallery's template with a rescue's badges. Shared by the
   page (app.js) and the tests, so both fill it the same way.

   Metadata is third-party text. "<" never appears inside the gallery's inline
   <script>: "</script>", "<!--" and "<script" in it all change how a browser
   reads the element, and < means the same to JavaScript. A function
   replacement keeps $-patterns in metadata literal. Page-lifetime fields
   (preview blob: URLs) are dropped, since they mean nothing in the archive. */
(function (root) {
    'use strict';
    function poapGallery(tpl, address, rows) {
        var clean = rows.map(function (p) {
            var c = {}, k;
            for (k in p) if (k !== 'preview') c[k] = p[k];
            return c;
        });
        var data = JSON.stringify(clean).replace(/</g, '\\u003c');
        var html = tpl
            .replace(/__ADDRESS__/g, address)
            .replace(/__COUNT__/g, String(clean.length))
            .replace('__DATA__', function () { return data; });
        return { clean: clean, html: html };
    }
    if (typeof module === 'object' && module.exports) module.exports = poapGallery;
    else root.poapGallery = poapGallery;
})(this);
