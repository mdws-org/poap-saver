/* ENS forward resolution for ENS v1 and v2, no libraries.
   One call to the ENS Universal Resolver (0xeEeE…EeEe), which walks the v2
   registry tree and falls back to v1, so v1 names, migrated names and native
   v2 names all resolve the same way. Offchain names (CCIP-Read, EIP-3668)
   revert with OffchainLookup; those are answered through ENS Labs' gateway
   and the reply is handed back to the resolver.
   Needs: ethCall(to, data) -> Promise<hex result>, rejecting with the revert
   data on a revert; keccak256(Uint8Array) -> Uint8Array(32). */
function makeEnsResolver(ethCall, keccak256) {
    var UR = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee';
    var GATEWAY = 'https://ccip-v3.ens.xyz';

    function hex(b) { return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
    function utf8(s) { return new TextEncoder().encode(s); }
    function word(n) { return BigInt(n).toString(16).padStart(64, '0'); }
    function bytesArg(h) { // ABI tail for one `bytes` value, h without 0x
        var len = h.length / 2;
        return word(len) + h + '0'.repeat((64 - (h.length % 64)) % 64);
    }

    function normalize(name) {
        var n = String(name).trim().toLowerCase();
        if (!/^[\x21-\x7e]+$/.test(n)) throw new Error(name + ': only plain ASCII ENS names are supported here - paste the 0x address instead');
        if (!/^([a-z0-9_-]+\.)+[a-z0-9-]+$/.test(n)) throw new Error(name + ': not an ENS name');
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
            if (b.length > 255) throw new Error('label too long');
            return b.length.toString(16).padStart(2, '0') + hex(b);
        }).join('') + '00';
    }
    // resolve(bytes name, bytes data)
    function resolveCall(nameHex, dataHex) {
        var a = bytesArg(nameHex);
        return '0x9061b923' + word(0x40) + word(0x40 + a.length / 2) + a + bytesArg(dataHex);
    }
    function readBytes(h, at) { // the `bytes` whose offset sits in word `at` of h (no 0x)
        var off = parseInt(h.slice(at * 64, at * 64 + 64), 16) * 2;
        var len = parseInt(h.slice(off, off + 64), 16) * 2;
        return h.slice(off + 64, off + 64 + len);
    }

    function at(h, off) { return parseInt(h.slice(off * 2, off * 2 + 64), 16); }
    function bytesAt(h, off) { var len = at(h, off); return h.slice(off * 2 + 64, off * 2 + 64 + len * 2); }

    // One EIP-3668 gateway request: GET when the URL carries {data}, POST otherwise.
    function fetchGateway(url, sender, data) {
        var get = url.indexOf('{data}') >= 0;
        var u = url.replace('{sender}', sender.toLowerCase()).replace('{data}', '0x' + data);
        return fetch(u, get ? {} : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: '0x' + data, sender: sender.toLowerCase() }),
        }).then(function (r) {
            if (!r.ok) throw new Error('gateway HTTP ' + r.status);
            return r.json();
        }).then(function (j) {
            if (typeof j.data !== 'string') throw new Error('gateway gave no data');
            return j.data.replace(/^0x/, '');
        });
    }
    function firstGateway(urls, sender, data) {
        var p = Promise.reject(new Error('no gateway'));
        urls.forEach(function (u) { p = p.catch(function () { return fetchGateway(u, sender, data); }); });
        return p;
    }

    // The batch gateway done locally (ENSIP-21): query((address,string[],bytes)[]) -> (bool[], bytes[]).
    function localBatch(q) {
        var h = q.slice(8); // past the selector
        var arr = at(h, 0), n = at(h, arr), base = arr + 32;
        var reqs = [];
        for (var i = 0; i < n; i++) {
            var t = base + at(h, base + 32 * i);
            var sender = '0x' + h.slice(t * 2 + 24, t * 2 + 64);
            var us = t + at(h, t + 32), m = at(h, us), urls = [];
            for (var k = 0; k < m; k++) urls.push(new TextDecoder().decode(new Uint8Array((bytesAt(h, us + 32 + at(h, us + 32 + 32 * k)).match(/../g) || []).map(function (x) { return parseInt(x, 16); }))));
            reqs.push({ sender: sender, urls: urls, data: bytesAt(h, t + at(h, t + 64)) });
        }
        return Promise.all(reqs.map(function (r) {
            return firstGateway(r.urls, r.sender, r.data).then(function (d) { return { ok: true, d: d }; },
                function (e) { return { ok: false, d: '08c379a0' + word(32) + bytesArg(hex(utf8(String(e.message)))) }; });
        })).then(function (res) {
            var flags = word(res.length) + res.map(function (x) { return word(x.ok ? 0 : 1); }).join('');
            var tails = res.map(function (x) { return bytesArg(x.d); });
            var heads = [], off = 32 * res.length;
            tails.forEach(function (t) { heads.push(word(off)); off += t.length / 2; });
            var bytesArr = word(res.length) + heads.join('') + tails.join('');
            if (res.every(function (x) { return !x.ok; })) throw new Error('every gateway failed');
            return word(0x40) + word(0x40 + flags.length / 2) + flags + bytesArr;
        });
    }

    // OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)
    function offchain(revert) {
        var h = revert.slice(10);
        var sender = '0x' + h.slice(24, 64);
        var callData = readBytes(h, 2);
        var callback = h.slice(192, 200);
        var extra = readBytes(h, 4);
        if (sender.toLowerCase() !== UR) throw new Error('offchain lookup from an unexpected contract');
        var answer = (callData.slice(0, 8) === 'a780bab6' ? localBatch(callData) : Promise.reject(new Error('not a batch')))
            .catch(function () { return fetchGateway(GATEWAY, sender, callData); });
        return answer.then(function (resp) {
            var a = bytesArg(resp);
            return ethCall(UR, '0x' + callback + word(0x40) + word(0x40 + a.length / 2) + a + bytesArg(extra));
        });
    }

    function call(data, hops) {
        return ethCall(UR, data).catch(function (e) {
            var rev = e && e.data;
            if (typeof rev === 'string' && rev.slice(0, 10) === '0x556f1830' && hops < 4) {
                return offchain(rev).catch(function (e2) {
                    var r2 = e2 && e2.data;
                    if (typeof r2 === 'string' && r2.slice(0, 10) === '0x556f1830') return offchain(r2);
                    throw e2;
                });
            }
            throw e;
        });
    }

    function addrFrom(res, coinType) { // (bytes result, address resolver) -> inner result -> address
        var inner = readBytes(res.slice(2), 0);
        if (coinType) {
            var b = readBytes(inner, 0);
            return b.length === 40 ? '0x' + b : null;
        }
        var a = inner.slice(24, 64);
        return a && /[1-9a-f]/.test(a) ? '0x' + a : null;
    }

    function resolve(name) {
        var n = normalize(name), node = namehash(n), dns = dnsEncode(n);
        var notFound = function () { throw new Error(n + ': no Ethereum address is set for this name'); };
        // addr(bytes32, 60) first: the ENSIP-9 record every resolver keeps for Ethereum.
        return call(resolveCall(dns, 'f1cb7e06' + node + word(60)), 0)
            .then(function (r) { return addrFrom(r, 60); }, function () { return null; })
            .then(function (a) {
                if (a) return a;
                // older resolvers only answer addr(bytes32)
                return call(resolveCall(dns, '3b3b57de' + node), 0)
                    .then(function (r) { return addrFrom(r, 0) || notFound(); }, notFound);
            });
    }

    return { resolve: resolve, namehash: namehash, dnsEncode: dnsEncode, normalize: normalize };
}
if (typeof module !== 'undefined') module.exports = makeEnsResolver;
