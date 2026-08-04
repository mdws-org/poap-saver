/* poap-saver — in-browser rescuer.
   Everything runs client-side: the page talks to public RPC endpoints and to
   POAP's still-answering hosts, hashes every image with WebCrypto, and hands
   back a zip. Nothing is uploaded anywhere; there is no server side.

   The gallery placed inside the zip comes from gallery-template.html, fetched
   from beside this script, so the CLI and the browser produce the same page. */
(function () {
    'use strict';

    var POAP = '0x22c1f6050e56d2876009903609a2cc3fef83b415';
    var ENS_REGISTRY = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
    var RPCS = {
        gnosis: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
        eth: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    };

    /* ------------------------------------------------------- keccak-256 --
       ENS namehash needs the original Keccak-256 (not SHA-3, whose padding
       differs). BigInt lanes, Keccak-f[1600]. Verified against the Ethereum
       empty hash c5d2...a470. */
    var RC = [
        '0x0000000000000001', '0x0000000000008082', '0x800000000000808A',
        '0x8000000080008000', '0x000000000000808B', '0x0000000080000001',
        '0x8000000080008081', '0x8000000000008009', '0x000000000000008A',
        '0x0000000000000088', '0x0000000080008009', '0x000000008000000A',
        '0x000000008000808B', '0x800000000000008B', '0x8000000000008089',
        '0x8000000000008003', '0x8000000000008002', '0x8000000000000080',
        '0x000000000000800A', '0x800000008000000A', '0x8000000080008081',
        '0x8000000000008080', '0x0000000080000001', '0x8000000080008008',
    ].map(BigInt);
    var ROT = [
        [0n, 36n, 3n, 41n, 18n], [1n, 44n, 10n, 45n, 2n], [62n, 6n, 43n, 15n, 61n],
        [28n, 55n, 25n, 21n, 56n], [27n, 20n, 39n, 8n, 14n],
    ];
    var M64 = (1n << 64n) - 1n;

    function rotl(x, n) {
        if (n === 0n) return x;
        return ((x << n) | (x >> (64n - n))) & M64;
    }

    function keccak256(bytes) {
        var rate = 136;
        var st = [];
        for (var x = 0; x < 5; x++) { st.push([0n, 0n, 0n, 0n, 0n]); }
        var padLen = rate - (bytes.length % rate);
        var padded = new Uint8Array(bytes.length + padLen);
        padded.set(bytes);
        padded[bytes.length] = 0x01;
        padded[padded.length - 1] |= 0x80;
        for (var off = 0; off < padded.length; off += rate) {
            for (var i = 0; i < rate / 8; i++) {
                var lane = 0n;
                for (var b = 7; b >= 0; b--) {
                    lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
                }
                st[i % 5][(i / 5) | 0] ^= lane;
            }
            for (var rnd = 0; rnd < 24; rnd++) {
                var c = [], d = [];
                for (x = 0; x < 5; x++) {
                    c[x] = st[x][0] ^ st[x][1] ^ st[x][2] ^ st[x][3] ^ st[x][4];
                }
                for (x = 0; x < 5; x++) {
                    d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
                }
                var bb = [];
                for (x = 0; x < 5; x++) { bb.push([0n, 0n, 0n, 0n, 0n]); }
                for (x = 0; x < 5; x++) {
                    for (var y = 0; y < 5; y++) {
                        var v = st[x][y] ^ d[x];
                        bb[y][(2 * x + 3 * y) % 5] = rotl(v, ROT[x][y]);
                    }
                }
                for (x = 0; x < 5; x++) {
                    for (y = 0; y < 5; y++) {
                        st[x][y] = bb[x][y] ^ ((~bb[(x + 1) % 5][y] & M64) & bb[(x + 2) % 5][y]);
                    }
                }
                st[0][0] ^= RC[rnd];
            }
        }
        var out = new Uint8Array(32);
        for (i = 0; i < 4; i++) {
            var l = st[i % 5][(i / 5) | 0];
            for (b = 0; b < 8; b++) {
                out[i * 8 + b] = Number((l >> BigInt(8 * b)) & 0xffn);
            }
        }
        return out;
    }

    function hex(bytes) {
        return Array.prototype.map.call(bytes, function (b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    function namehash(name) {
        var node = new Uint8Array(32);
        if (name) {
            var labels = name.toLowerCase().split('.');
            for (var i = labels.length - 1; i >= 0; i--) {
                var lab = keccak256(new TextEncoder().encode(labels[i]));
                var joined = new Uint8Array(64);
                joined.set(node); joined.set(lab, 32);
                node = keccak256(joined);
            }
        }
        return node;
    }

    /* --------------------------------------------------------- JSON-RPC -- */
    function rpcBatch(chain, calls, to) {
        var payload = calls.map(function (data, i) {
            return { jsonrpc: '2.0', id: i, method: 'eth_call',
                     params: [{ to: to || POAP, data: data }, 'latest'] };
        });
        var urls = RPCS[chain];
        function attempt(u) {
            if (u >= urls.length) return Promise.reject(new Error('all RPC endpoints failed for ' + chain));
            return fetch(urls[u], {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            }).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }).then(function (out) {
                if (!Array.isArray(out)) throw new Error(JSON.stringify(out.error || out));
                var byId = {};
                out.forEach(function (o) { byId[o.id] = o.result; });
                var res = calls.map(function (_, i) { return byId[i]; });
                /* A missing sub-result is a per-call error (rate limiting).
                   Decoding it as zero would silently drop badges, so fail
                   this endpoint and let the next one try. */
                if (res.some(function (r) { return r == null; })) {
                    throw new Error('partial batch failure');
                }
                return res;
            }).catch(function () { return attempt(u + 1); });
        }
        return attempt(0);
    }

    function decUint(h) { return h && h !== '0x' ? parseInt(h, 16) : 0; }

    function decString(h) {
        var b = h.slice(2);
        var off = parseInt(b.slice(0, 64), 16) * 2;
        var len = parseInt(b.slice(off, off + 64), 16) * 2;
        var bytes = new Uint8Array(len / 2);
        for (var i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(b.substr(off + 64 + i * 2, 2), 16);
        }
        return new TextDecoder().decode(bytes);
    }

    function resolveEns(name) {
        if (!/^[\x00-\x7F]*$/.test(name)) {
            return Promise.reject(new Error(
                name + ': non-ASCII ENS names are not supported - paste the 0x address instead'));
        }
        var node = hex(namehash(name));
        return rpcBatch('eth', ['0x0178b8bf' + node], ENS_REGISTRY).then(function (r) {
            var resolver = '0x' + (r[0] || '').slice(-40);
            if (!parseInt(resolver, 16)) throw new Error(name + ': no ENS resolver set');
            return rpcBatch('eth', ['0x3b3b57de' + node], resolver);
        }).then(function (r) {
            var addr = '0x' + (r[0] || '').slice(-40);
            if (!parseInt(addr, 16)) throw new Error(name + ': resolver has no address record');
            return addr;
        });
    }

    function enumerate(chain, addr) {
        var arg = '0'.repeat(24) + addr.slice(2).toLowerCase();
        return rpcBatch(chain, ['0x70a08231' + arg]).then(function (r) {
            var bal = decUint(r[0]);
            if (!bal) return [];
            var idxCalls = [];
            for (var i = 0; i < bal; i++) {
                idxCalls.push('0x2f745c59' + arg + i.toString(16).padStart(64, '0'));
            }
            return batched(chain, idxCalls, 50).then(function (rs) {
                var ids = rs.map(decUint).filter(Boolean);
                var uriCalls = ids.map(function (t) {
                    return '0xc87b56dd' + t.toString(16).padStart(64, '0');
                });
                return batched(chain, uriCalls, 50).then(function (us) {
                    return ids.map(function (t, j) {
                        return { id: t, uri: us[j] ? decString(us[j]) : null };
                    });
                });
            });
        });
    }

    function batched(chain, calls, n) {
        var out = [];
        function step(i) {
            if (i >= calls.length) return Promise.resolve(out);
            return rpcBatch(chain, calls.slice(i, i + n)).then(function (rs) {
                out = out.concat(rs);
                return step(i + n);
            });
        }
        return step(0);
    }

    /* ------------------------------------------------------------- zip --
       Store-only zip: images are already compressed, so deflate would buy
       nothing and cost a dependency. */
    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) {
                c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            }
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) {
            c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function makeZip(files) {
        // files: [{name: 'a/b.txt', data: Uint8Array}]
        // Store-only zip has hard format limits; fail loudly instead of
        // silently wrapping the 16/32-bit fields into a corrupt archive.
        if (files.length > 65535) {
            throw new Error('This collection needs ' + files.length +
                ' zip entries - past the zip format limit. Use the command line tool.');
        }
        var parts = [], central = [], offset = 0;
        var now = new Date();
        var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

        function u16(v) { return new Uint8Array([v & 255, (v >> 8) & 255]); }
        function u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }

        files.forEach(function (f) {
            var name = new TextEncoder().encode(f.name);
            var crc = crc32(f.data);
            var local = [u32(0x04034b50), u16(20), u16(0x0800), u16(0),
                         u16(dosTime), u16(dosDate), u32(crc),
                         u32(f.data.length), u32(f.data.length),
                         u16(name.length), u16(0)];
            local.forEach(function (p) { parts.push(p); });
            parts.push(name, f.data);
            var cen = [u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
                       u16(dosTime), u16(dosDate), u32(crc),
                       u32(f.data.length), u32(f.data.length),
                       u16(name.length), u16(0), u16(0), u16(0), u16(0),
                       u32(0), u32(offset)];
            central.push({ head: cen, name: name });
            offset += 30 + name.length + f.data.length;
        });
        if (offset > 0xFFFFFFFF) {
            throw new Error('Archive exceeds the 4 GiB zip limit. Use the command line tool.');
        }
        var cdStart = offset, cdSize = 0;
        central.forEach(function (c) {
            c.head.forEach(function (p) { parts.push(p); cdSize += p.length; });
            parts.push(c.name); cdSize += c.name.length;
        });
        parts.push(u32(0x06054b50), u16(0), u16(0), u16(files.length),
                   u16(files.length), u32(cdSize), u32(cdStart), u16(0));
        return new Blob(parts, { type: 'application/zip' });
    }

    /* ---------------------------------------------------------- rescue -- */
    var ui = {
        form: document.getElementById('rescue-form'),
        input: document.getElementById('address'),
        button: document.getElementById('go'),
        status: document.getElementById('status'),
        log: document.getElementById('log'),
        result: document.getElementById('result'),
    };

    function say(msg) {
        ui.status.textContent = msg;
    }

    function note(msg) {
        var li = document.createElement('li');
        li.textContent = msg;
        ui.log.appendChild(li);
    }

    function fetchWithRetry(url, tries) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r;
        }).catch(function (e) {
            if (tries <= 1) throw e;
            return new Promise(function (res) { setTimeout(res, 2000); })
                .then(function () { return fetchWithRetry(url, tries - 1); });
        });
    }

    function sha256hex(bytes) {
        return crypto.subtle.digest('SHA-256', bytes).then(function (d) {
            return hex(new Uint8Array(d));
        });
    }

    function extFor(ctype, url) {
        var map = { 'image/png': '.png', 'image/gif': '.gif', 'image/jpeg': '.jpg',
                    'image/webp': '.webp', 'image/svg+xml': '.svg' };
        var base = (ctype || '').split(';')[0].trim();
        if (map[base]) return map[base];
        var m = (url || '').match(/(\.[a-z0-9]{2,5})(?:\?|$)/i);
        return m ? m[1] : '.bin';
    }

    function rescueToken(tok, files, rows, fails) {
        return fetchWithRetry(tok.uri, 3).then(function (r) { return r.json(); })
        .then(function (meta) {
            var dir = tok.chain + '/' + tok.id + '/';
            meta._archived_from = tok.uri;
            meta._archived_ts = Math.floor(Date.now() / 1000);
            files.push({ name: dir + 'metadata.json',
                         data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });
            var imgUrl = meta.image_url || meta.image;
            var row = {
                c: tok.chain, t: String(tok.id), e: eventIdFrom(tok.uri),
                n: meta.name || 'POAP', d: (meta.description || '').trim(),
                y: meta.year || null, img: null, sha: null,
                uri: tok.uri, src: imgUrl || null,
            };
            rows.push(row);
            if (!imgUrl) return null;
            return fetchWithRetry(imgUrl, 3).then(function (r) {
                var ctype = r.headers.get('content-type');
                return r.arrayBuffer().then(function (buf) {
                    var bytes = new Uint8Array(buf);
                    return sha256hex(bytes).then(function (sha) {
                        var fname = 'image' + extFor(ctype, imgUrl);
                        files.push({ name: dir + fname, data: bytes });
                        files.push({ name: dir + 'image.sha256',
                                     data: new TextEncoder().encode(sha + '  ' + fname + '\n') });
                        row.img = dir + fname;
                        row.sha = sha;
                        row.preview = URL.createObjectURL(
                            new Blob([bytes], { type: ctype || 'image/png' }));
                    });
                });
            });
        }).catch(function (e) {
            fails.push(tok.chain + '/' + tok.id + ': ' + e.message);
            note('failed ' + tok.chain + '/' + tok.id + ' — ' + e.message);
        });
    }

    function eventIdFrom(uri) {
        var m = (uri || '').match(/\/(\d+)\/\d+\/?$/);
        return m ? Number(m[1]) : null;
    }

    function pool(items, width, worker) {
        var i = 0, done = 0;
        return new Promise(function (resolve) {
            function next() {
                if (i >= items.length) {
                    if (done === items.length) resolve();
                    return;
                }
                var item = items[i++];
                var tick = function () {
                    done++;
                    say('Saving badge ' + done + ' of ' + items.length + '…');
                    next();
                };
                worker(item).then(tick, tick);
            }
            if (!items.length) return resolve();
            for (var w = 0; w < Math.min(width, items.length); w++) next();
        });
    }

    var stalePreviews = [];

    function run(input) {
        if (!(window.crypto && crypto.subtle)) {
            say('This page needs a secure context (https:// or file://) - ' +
                'crypto.subtle is unavailable here, so images cannot be hash-verified.');
            return;
        }
        ui.button.disabled = true;
        ui.log.textContent = '';
        ui.result.textContent = '';
        stalePreviews.forEach(function (u) { URL.revokeObjectURL(u); });
        stalePreviews = [];
        if (/^0X[0-9a-fA-F]{40}$/.test(input)) input = '0x' + input.slice(2);
        var addrPromise = /^0x[0-9a-fA-F]{40}$/.test(input)
            ? Promise.resolve(input)
            : (say('Resolving ' + input + '…'), resolveEns(input));

        var address, tpl;
        addrPromise.then(function (a) {
            address = a.toLowerCase();
            /* The gallery template is required to finish the zip; fetch it
               first so a missing file fails in one second, not after a
               hundred megabytes of badge downloads. */
            return fetch('gallery-template.html');
        }).then(function (r) {
            if (!r.ok) {
                throw new Error('gallery-template.html is missing beside this page (HTTP '
                    + r.status + ') - it must be deployed with index.html and app.js');
            }
            return r.text();
        }).then(function (t) {
            tpl = t;
            say('Looking up badges for ' + address + '…');
            return Promise.all([enumerate('gnosis', address), enumerate('eth', address)]);
        }).then(function (both) {
            var toks = [];
            both[0].forEach(function (t) { t.chain = 'gnosis'; toks.push(t); });
            both[1].forEach(function (t) { t.chain = 'eth'; toks.push(t); });
            toks = toks.filter(function (t) { return t.uri; });
            if (!toks.length) {
                say('No POAPs found for ' + address + ' on Gnosis or Ethereum.');
                ui.button.disabled = false;
                return null;
            }
            say('Found ' + toks.length + ' badges. Saving…');
            var files = [], rows = [], fails = [];
            return pool(toks, 3, function (t) {
                return rescueToken(t, files, rows, fails);
            }).then(function () {
                    rows.sort(function (a, b) { return (b.y || 0) - (a.y || 0); });
                    rows.forEach(function (p) {
                        if (p.preview) stalePreviews.push(p.preview);
                    });
                    /* preview holds page-lifetime blob: URLs - meaningless
                       inside the archive, so strip before serializing. */
                    var clean = rows.map(function (p) {
                        var c = {}, k;
                        for (k in p) if (k !== 'preview') c[k] = p[k];
                        return c;
                    });
                    /* "</" must not appear inside the gallery's inline
                       <script>: metadata is third-party text and "</script>"
                       in it would end the element. Function replacement also
                       keeps $-patterns in metadata literal. */
                    var data = JSON.stringify(clean).replace(/<\//g, '<\\/');
                    var gallery = tpl
                        .replace(/__ADDRESS__/g, address)
                        .replace(/__COUNT__/g, String(clean.length))
                        .replace('__DATA__', function () { return data; });
                    files.push({ name: 'index.html',
                                 data: new TextEncoder().encode(gallery) });
                    files.push({ name: 'manifest.json',
                                 data: new TextEncoder().encode(JSON.stringify({
                                     generated: Math.floor(Date.now() / 1000),
                                     address: address, count: clean.length,
                                     contract: POAP, failures: fails,
                                     tool: 'poap-saver web',
                                     poaps: clean,
                                 }, null, 2)) });
                    var prefix = 'poap-archive-' + address.slice(2, 10) + '/';
                    files.forEach(function (f) { f.name = prefix + f.name; });
                    var blob = makeZip(files);
                    var a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'poap-archive-' + address.slice(2, 10) + '.zip';
                    a.textContent = 'Download your archive (' +
                        (blob.size / 1e6).toFixed(1) + ' MB zip)';
                    ui.result.appendChild(a);
                    var doneMsg = rows.length + ' badges saved';
                    if (fails.length) doneMsg += ', ' + fails.length + ' failed — run it again later for those';
                    say(doneMsg + '. Unzip the download and open index.html.');
                    showPreview(rows);
                    a.click();
                    ui.button.disabled = false;
            });
        }).catch(function (e) {
            say(e.message);
            ui.button.disabled = false;
        });
    }

    function showPreview(rows) {
        var el = document.getElementById('preview');
        if (!el) return;
        var html = '';
        rows.forEach(function (p) {
            if (!p.preview) return;
            html += '<figure class="pv">' +
                '<img loading="lazy" src="' + p.preview + '" alt="">' +
                '<figcaption>' + String(p.n).replace(/[&<>"]/g, function (c) {
                    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
                }) + '</figcaption></figure>';
        });
        el.innerHTML = html;
    }

    ui.form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = ui.input.value.trim();
        if (v) run(v);
    });

    /* Test hook: lets test/zip-test.html exercise the zip writer with the
       real functions instead of a re-implementation. Harmless in production. */
    window.__poapSaver = { keccak256: keccak256, crc32: crc32, makeZip: makeZip,
                           namehash: namehash, hex: hex };

    var qs = new URLSearchParams(location.search);
    if (qs.get('address')) {
        ui.input.value = qs.get('address');
        run(qs.get('address'));
    }
})();
