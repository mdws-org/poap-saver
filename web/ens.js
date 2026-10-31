/* ENS forward resolution for ENS v1 and v2, no libraries.
   One call to the ENS Universal Resolver (0xeEeE…EeEe), which walks the v2
   registry tree and falls back to v1, so v1 names, migrated names and native
   v2 names all resolve the same way. Offchain names (CCIP-Read, EIP-3668)
   revert with OffchainLookup. The Universal Resolver batches those (ENSIP-21);
   the batch is answered here, fetching only the gateways the page is allowed
   to reach directly, and otherwise through ENS Labs' gateway.
   Needs: ethCall(to, data) -> Promise<hex result>, rejecting with the revert
   data as err.data on a revert; keccak256(Uint8Array) -> Uint8Array(32). */
function makeEnsResolver(ethCall, keccak256) {
    var UR = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee';
    var GATEWAY = 'https://ccip-v3.ens.xyz';
    // Gateways fetched straight from the browser; anything else goes through ENS Labs.
    var DIRECT = ['https://api.coinbase.com/', 'https://ccip-v3.ens.xyz'];
    var TIMEOUT_MS = 8000, MAX_HOPS = 4, MAX_REQS = 8, MAX_URLS = 4;

    function hex(b) { return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
    function utf8(s) { return new TextEncoder().encode(s); }
    function word(n) { return BigInt(n).toString(16).padStart(64, '0'); }
    function isHex(h) { return typeof h === 'string' && /^([0-9a-f]{2})*$/i.test(h); }
    function bytesArg(h) { // ABI tail for one `bytes` value, h without 0x
        return word(h.length / 2) + h + '0'.repeat((64 - (h.length % 64)) % 64);
    }
    function fail(msg) { throw new Error(msg); }

    // ASCII names only: lower case, letters, digits and hyphens, an underscore only
    // at the start of a label, no "--" in the third and fourth places (ENSIP-15).
    function normalize(name) {
        var n = String(name).trim().toLowerCase();
        if (!/^[\x21-\x7e]+$/.test(n)) fail(name + ': only plain ASCII ENS names work here - paste the 0x address instead');
        var labels = n.split('.');
        var ok = labels.length > 1 && labels.every(function (l) {
            return /^_*[a-z0-9-]+$/.test(l) && l.slice(2, 4) !== '--';
        });
        if (!ok) fail(name + ': not a valid ENS name');
        return n;
    }
    function namehash(n) {
        var node = new Uint8Array(32);
        var labels = n.split('.');
        for (var i = labels.length - 1; i >= 0; i--) {
            var joined = new Uint8Array(64);
            joined.set(node); joined.set(keccak256(utf8(labels[i])), 32);
            node = keccak256(joined);
        }
        return hex(node);
    }
    function dnsEncode(n) {
        return n.split('.').map(function (l) {
            var b = utf8(l);
            if (b.length > 255) fail('label too long');
            return b.length.toString(16).padStart(2, '0') + hex(b);
        }).join('') + '00';
    }
    function resolveCall(nameHex, dataHex) { // resolve(bytes name, bytes data)
        var a = bytesArg(nameHex);
        return '0x9061b923' + word(0x40) + word(0x40 + a.length / 2) + a + bytesArg(dataHex);
    }

    // Bounded ABI readers over a hex string without 0x; offsets are in bytes.
    function at(h, off) {
        if (off * 2 + 64 > h.length) fail('malformed ABI data');
        var v = parseInt(h.slice(off * 2, off * 2 + 64), 16);
        if (!(v >= 0 && v <= h.length / 2)) fail('malformed ABI data');
        return v;
    }
    function bytesAt(h, off) {
        var len = at(h, off);
        if (off * 2 + 64 + len * 2 > h.length) fail('malformed ABI data');
        return h.slice(off * 2 + 64, off * 2 + 64 + len * 2);
    }
    function bytesIn(h, slot) { return bytesAt(h, at(h, slot * 32)); } // `bytes` whose offset is head word `slot`
    function stringsAt(h, off, max) {
        var m = at(h, off), out = [];
        if (m > max) fail('too many gateway urls');
        for (var k = 0; k < m; k++) {
            out.push(new TextDecoder().decode(new Uint8Array((bytesAt(h, off + 32 + at(h, off + 32 + 32 * k)).match(/../g) || []).map(function (x) { return parseInt(x, 16); }))));
        }
        return out;
    }

    // One EIP-3668 gateway request: GET when the URL carries {data}, POST otherwise.
    function fetchGateway(url, sender, data) {
        if (!DIRECT.some(function (d) { return url.indexOf(d) === 0; })) return Promise.reject(new Error('gateway not reachable from this page'));
        var get = url.indexOf('{data}') >= 0;
        var u = url.split('{sender}').join(sender.toLowerCase()).split('{data}').join('0x' + data);
        var opts = get ? {} : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: '0x' + data, sender: sender.toLowerCase() }),
        };
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(TIMEOUT_MS);
        return fetch(u, opts).then(function (r) {
            if (!r.ok) fail('gateway HTTP ' + r.status);
            return r.json();
        }).then(function (j) {
            var d = typeof j.data === 'string' ? j.data.replace(/^0x/, '') : null;
            if (!isHex(d)) fail('gateway gave no data');
            return d;
        });
    }
    function firstGateway(urls, sender, data) {
        var p = Promise.reject(new Error('no gateway'));
        urls.forEach(function (u) { p = p.catch(function () { return fetchGateway(u, sender, data); }); });
        return p;
    }

    // The batch gateway done here (ENSIP-21): query((address,string[],bytes)[]) -> (bool[], bytes[]).
    // Any request this page cannot answer itself sends the whole batch to ENS Labs.
    function localBatch(q) {
        var h = q.slice(8);
        var arr = at(h, 0), n = at(h, arr), base = arr + 32, reqs = [];
        if (n > MAX_REQS) fail('batch too large');
        for (var i = 0; i < n; i++) {
            var t = base + at(h, base + 32 * i);
            reqs.push({ sender: '0x' + h.slice(t * 2 + 24, t * 2 + 64), urls: stringsAt(h, t + at(h, t + 32), MAX_URLS), data: bytesAt(h, t + at(h, t + 64)) });
        }
        return Promise.all(reqs.map(function (r) { return firstGateway(r.urls, r.sender, r.data); })).then(function (res) {
            var flags = word(res.length) + res.map(function () { return word(0); }).join('');
            var tails = res.map(bytesArg), heads = [], off = 32 * res.length;
            tails.forEach(function (tl) { heads.push(word(off)); off += tl.length / 2; });
            return word(0x40) + word(0x40 + flags.length / 2) + flags + word(res.length) + heads.join('') + tails.join('');
        });
    }

    // OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)
    function offchain(revert, hops) {
        var h = revert.slice(10);
        var sender = '0x' + h.slice(24, 64);
        if (sender.toLowerCase() !== UR) fail('offchain lookup from an unexpected contract');
        var urls = stringsAt(h, at(h, 32), MAX_URLS);
        var callData = bytesIn(h, 2), callback = h.slice(192, 200), extra = bytesIn(h, 4);
        var viaEns = function () { return firstGateway(urls.filter(function (u) { return u.indexOf('http') === 0; }).concat([GATEWAY]), sender, callData); };
        var answer = callData.slice(0, 8) === 'a780bab6' ? localBatch(callData).catch(viaEns) : viaEns();
        return answer.then(function (resp) {
            var a = bytesArg(resp);
            return call('0x' + callback + word(0x40) + word(0x40 + a.length / 2) + a + bytesArg(extra), hops + 1);
        });
    }

    function call(data, hops) {
        return ethCall(UR, data).catch(function (e) {
            var rev = e && e.data;
            if (typeof rev === 'string' && rev.slice(0, 10) === '0x556f1830') {
                if (hops >= MAX_HOPS) fail('too many offchain lookups');
                return offchain(rev, hops);
            }
            throw e;
        });
    }

    // (bytes result, address resolver) -> the inner record -> an address, or null if none is set.
    function addrFrom(res, coinType) {
        var h = typeof res === 'string' ? res.replace(/^0x/, '') : '';
        if (!isHex(h) || h.length < 128) fail('malformed resolver reply');
        var inner = bytesIn(h, 0);
        var a;
        if (coinType) {
            a = bytesIn(inner, 0);
        } else {
            if (inner.length !== 64 || !/^0{24}/.test(inner)) fail('malformed resolver reply');
            a = inner.slice(24);
        }
        return a.length === 40 && /[1-9a-f]/i.test(a) ? '0x' + a.toLowerCase() : null;
    }

    function resolve(name) {
        var n = normalize(name), node = namehash(n), dns = dnsEncode(n);
        var none = n + ': no Ethereum address is set for this name';
        // What a failure means: null = try the older addr(bytes32) record instead.
        function why(e) {
            var s = e && typeof e.data === 'string' ? e.data.slice(0, 10) : '';
            if (s === '0x77209fe8') return n + ': not registered';
            if (s === '0x1e9535f2') return n + ': its resolver is not a contract';
            if (s === '0x7b1c461b') return null;
            if (s === '0x95c0c752') return n + ': its resolver failed - try again later';
            if (/^0x[0-9a-f]{8}$/i.test(s)) return n + ': could not be resolved';
            return n + ': could not reach ENS - try again';
        }
        function legacy() {
            return call(resolveCall(dns, '3b3b57de' + node), 0).then(
                function (r) { return addrFrom(r, 0) || fail(none); },
                function (e) { fail(why(e) || none); });
        }
        // addr(bytes32, 60) first: the ENSIP-9 record every current resolver keeps for Ethereum.
        return call(resolveCall(dns, 'f1cb7e06' + node + word(60)), 0).then(
            function (r) { return addrFrom(r, 60) || legacy(); },
            function (e) { var m = why(e); if (m) fail(m); return legacy(); });
    }

    return { resolve: resolve, namehash: namehash, dnsEncode: dnsEncode, normalize: normalize };
}
if (typeof module !== 'undefined') module.exports = makeEnsResolver;
