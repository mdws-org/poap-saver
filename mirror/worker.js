/* poap-mirror — a community availability cache for POAP event artwork.
 *
 * POAP artwork is per-event and lives on assets.poap.xyz, which will not
 * outlive the company. This Worker fronts an R2 bucket keyed by event id:
 *
 *   GET  /img/<eventId>     the archived artwork for that event
 *   GET  /ipfs/<cid>        the same artwork addressed by its IPFS CID
 *   POST /ingest/<eventId>  ask the mirror to fetch and store that event's
 *                           artwork from POAP's own origin. Headers:
 *                             x-source-url    the assets.poap.xyz image URL
 *                             x-token-uri     that event's api.poap.tech
 *                                             metadata URL, used to prove the
 *                                             image really belongs to the event
 *   GET  /                  what this is, in JSON
 *   GET  /events            every event held, with size, sha256 and origin URL
 *   GET  /cids              every CID held, paired with its event
 *   POST /recount           (admin) rebuild the usage ledger from the bucket
 *   POST /cid               (admin) record the CID of an event's object
 *   DELETE /img/<eventId>   (admin) remove a poisoned object
 *
 * The mirror never accepts uploaded bytes. Ingest fetches from POAP's origin
 * server-side, verifies the image belongs to the event by reading POAP's own
 * metadata, checks the bytes are actually an image, hashes them, and stores
 * that. So the bucket can only ever contain what POAP served, filed under the
 * event POAP itself says it belongs to. Objects are immutable once written.
 * When the origin stops answering, set WRITES_OPEN to anything but "1" and the
 * mirror becomes read-only, holding whatever the community ingested while it
 * could — and the binding check is exactly why that window matters: it can
 * only be enforced while POAP's metadata API still answers.
 *
 * CIDs are computed offline (scripts/build-registry.py, kubo) and recorded
 * here, so /ipfs/<cid> resolves to exactly the bytes that hash to that CID.
 * /events and /cids publish that inventory live, so anyone can enumerate what
 * the mirror holds and pin it themselves without asking or being trusted.
 * This is a CID-ADDRESSED MIRROR, not yet a trustless gateway: it serves whole
 * files, not the individual blocks a verifying client would re-hash. Fetching
 * by CID and checking it yourself against registry/events.json is the
 * verification path today.
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-source-url,x-token-uri,x-admin-key',
    'Access-Control-Expose-Headers': 'x-sha256,x-source-url,etag',
};

const MAX_BYTES = 15 * 1024 * 1024;

/* Hard spend cap. R2 storage is $0.015/GB-month and the only unbounded cost
 * dimension, so the mirror refuses new ingests past this total. 180 GiB is
 * ~193 GB: about $2.90/month gross, ~$2.75 after R2's 10 GB free tier (which
 * is account-wide, not per-bucket). The ledger below can drift under
 * concurrency; the scheduled recount reconciles it. */
const CAP_BYTES = 180 * 1024 * 1024 * 1024;

/* Only real images get stored. POAP's CDN can answer 200 with an HTML error
 * body, and an immutable HTML "image" would poison that event for everyone. */
const OK_TYPES = ['image/png', 'image/gif', 'image/jpeg', 'image/webp',
                  'image/avif', 'image/svg+xml'];

function looksLikeImage(bytes) {
    const b = new Uint8Array(bytes.slice(0, 16));
    const starts = (...sig) => sig.every((v, i) => b[i] === v);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return true;                  // PNG
    if (starts(0x47, 0x49, 0x46, 0x38)) return true;                  // GIF8
    if (starts(0xff, 0xd8, 0xff)) return true;                        // JPEG
    if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57) return true; // RIFF/WEBP
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
        return true;                                                  // ISO-BMFF (AVIF)
    }
    /* SVG needs a wider window than the binary signatures: exporters put a
       DOCTYPE or a generator comment before the root element. */
    const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 512)))
        .trim().toLowerCase();
    return head.includes('<svg');
}

function json(status, obj) {
    return new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { 'content-type': 'application/json', ...CORS },
    });
}

function hex(buf) {
    return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function usage(env) {
    const o = await env.MIRROR.get('_usage');
    if (!o) return { bytes: 0, objects: 0 };
    try { return await o.json(); } catch { return { bytes: 0, objects: 0 }; }
}

async function recount(env) {
    let bytes = 0, objects = 0, cursor;
    do {
        const page = await env.MIRROR.list({ cursor, limit: 1000 });
        for (const o of page.objects) {
            if (o.key.startsWith('img/')) { bytes += o.size; objects += 1; }
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await env.MIRROR.put('_usage', JSON.stringify({ bytes, objects }));
    return { bytes, objects };
}

/* R2 caps list() at 1000; clamp rather than letting a bad ?limit throw. */
function listLimit(url) {
    const n = parseInt(url.searchParams.get('limit') || '1000', 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), 1000) : 1000;
}

function isAdmin(req, env) {
    return Boolean(env.ADMIN_KEY) && req.headers.get('x-admin-key') === env.ADMIN_KEY;
}

export default {
    /* Cron reconciliation: the ledger is a read-modify-write on one object, so
     * concurrent ingests lose updates permanently. A daily recount from the
     * real bucket listing bounds that drift to a day. */
    async scheduled(event, env) {
        try {
            const u = await recount(env);
            console.log('recount ok', JSON.stringify(u));
        } catch (e) {
            console.error('recount FAILED', e && e.message);
            throw e;
        }
    },

    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        if (url.pathname === '/' || url.pathname === '') {
            const u = await usage(env);
            return json(200, {
                what: 'poap-mirror: community availability cache for POAP event artwork',
                keys: 'GET /img/<eventId>; GET /ipfs/<cid>; GET /events; GET /cids; POST /ingest/<eventId> with x-source-url + x-token-uri',
                writes: env.WRITES_OPEN === '1' ? 'open' : 'locked',
                events: u.objects,
                bytes: u.bytes,
                cap_bytes: CAP_BYTES,
                rate_limited: Boolean(env.INGEST_LIMIT),
                source: 'https://github.com/mdws-org/poap-saver',
            });
        }

        /* One canonical key per event: no leading zeros, so 007 and 7 cannot
           both be stored (which would also multiply the storage cap). */
        const img = url.pathname.match(/^\/img\/(0|[1-9]\d{0,11})$/);

        if (img && req.method === 'DELETE') {
            if (!isAdmin(req, env)) return json(403, { error: 'admin only' });
            await env.MIRROR.delete('img/' + img[1]);
            /* Drop both CID index rows pointing at the object just removed, so
               /ipfs/<cid> cannot outlive the bytes it addresses. The cidmap
               prefix names this event's CIDs directly, so this is a single
               scoped listing rather than a scan of every CID in the bucket. */
            let cursor;
            do {
                const page = await env.MIRROR.list({
                    prefix: 'cidmap/' + img[1] + '/', cursor, limit: 1000,
                });
                for (const o of page.objects) {
                    await env.MIRROR.delete(['cid/' + o.key.slice(o.key.indexOf('/', 7) + 1), o.key]);
                }
                cursor = page.truncated ? page.cursor : undefined;
            } while (cursor);
            const u = await recount(env);
            return json(200, { ok: true, deleted: img[1], ...u });
        }

        if (img && (req.method === 'GET' || req.method === 'HEAD')) {
            const obj = await env.MIRROR.get('img/' + img[1]);
            if (!obj) return json(404, { error: 'event not mirrored' });
            const h = {
                'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
                'cache-control': 'public, max-age=31536000, immutable',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
                'x-sha256': obj.customMetadata?.sha256 || '',
                'x-source-url': obj.customMetadata?.source || '',
                etag: '"' + (obj.customMetadata?.sha256 || img[1]) + '"',
                ...CORS,
            };
            if (req.method === 'HEAD') return new Response(null, { headers: h });
            return new Response(obj.body, { headers: h });
        }

        /* Public inventory. Anyone can enumerate what the mirror holds, verify
           it against POAP's own origin, and pin the CIDs on their own node.
           Both endpoints are cursor-paginated straight off the bucket listing,
           so they stay cheap as the mirror grows. */
        if (url.pathname === '/events' && (req.method === 'GET' || req.method === 'HEAD')) {
            const page = await env.MIRROR.list({
                prefix: 'img/',
                limit: listLimit(url),
                cursor: url.searchParams.get('cursor') || undefined,
                include: ['customMetadata', 'httpMetadata'],
            });
            const events = {};
            for (const o of page.objects) {
                events[o.key.slice(4)] = {
                    size: o.size,
                    sha256: o.customMetadata?.sha256 || '',
                    content_type: o.httpMetadata?.contentType || '',
                    source_url: o.customMetadata?.source || '',
                };
            }
            return json(200, {
                count: page.objects.length,
                truncated: page.truncated,
                cursor: page.truncated ? page.cursor : null,
                verify: 'curl -s <mirror>/img/<eventId> | shasum -a 256',
                events,
            });
        }

        if (url.pathname === '/cids' && (req.method === 'GET' || req.method === 'HEAD')) {
            const page = await env.MIRROR.list({
                prefix: 'cidmap/',
                limit: listLimit(url),
                cursor: url.searchParams.get('cursor') || undefined,
            });
            const cids = [];
            for (const o of page.objects) {
                const slash = o.key.indexOf('/', 7);
                if (slash < 0) continue;
                cids.push({ event: o.key.slice(7, slash), cid: o.key.slice(slash + 1) });
            }
            return json(200, {
                count: cids.length,
                truncated: page.truncated,
                cursor: page.truncated ? page.cursor : null,
                pin: 'ipfs pin add <cid>, after fetching it from <mirror>/ipfs/<cid>',
                note: 'CIDs are kubo defaults: ipfs add --cid-version=1 --offline',
                cids,
            });
        }

        /* CID-addressed read. The cid -> event index is written by the admin
           /cid endpoint from offline-computed CIDs; unknown CIDs 404 rather
           than guessing. */
        const ipfs = url.pathname.match(/^\/ipfs\/(b[a-z2-7]{20,120})$/);
        if (ipfs && (req.method === 'GET' || req.method === 'HEAD')) {
            const idx = await env.MIRROR.get('cid/' + ipfs[1]);
            if (!idx) return json(404, { error: 'cid not held by this mirror' });
            const eventId = (await idx.text()).trim();
            const obj = await env.MIRROR.get('img/' + eventId);
            if (!obj) return json(404, { error: 'cid indexed but object missing' });
            const h = {
                'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
                'cache-control': 'public, max-age=31536000, immutable',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
                'x-sha256': obj.customMetadata?.sha256 || '',
                'x-source-url': obj.customMetadata?.source || '',
                'x-poap-event': eventId,
                etag: '"' + ipfs[1] + '"',
                ...CORS,
            };
            if (req.method === 'HEAD') return new Response(null, { headers: h });
            return new Response(obj.body, { headers: h });
        }

        /* Record an offline-computed CID for an event. Admin-only: the Worker
           cannot verify a CID without implementing UnixFS chunking, so this
           trusts the operator's kubo output rather than pretending otherwise. */
        if (url.pathname === '/cid' && req.method === 'POST') {
            if (!isAdmin(req, env)) return json(403, { error: 'admin only' });
            let body;
            try {
                body = await req.json();
            } catch {
                return json(400, { error: 'body must be JSON' });
            }
            const pairs = Array.isArray(body) ? body : [body];
            let wrote = 0;
            for (const p of pairs) {
                const ev = String(p && p.event || '');
                const cid = String(p && p.cid || '');
                if (!/^(0|[1-9]\d{0,11})$/.test(ev) || !/^b[a-z2-7]{20,120}$/.test(cid)) {
                    continue;
                }
                if (!(await env.MIRROR.head('img/' + ev))) continue;
                await env.MIRROR.put('cid/' + cid, ev);
                /* Reverse index, in the KEY rather than the body: listing a
                   prefix returns key names only, so /cids can enumerate every
                   pair with one list call per 1000 instead of one GET each. */
                await env.MIRROR.put('cidmap/' + ev + '/' + cid, '');
                wrote += 1;
            }
            return json(200, { ok: true, indexed: wrote, submitted: pairs.length });
        }

        if (url.pathname === '/recount' && req.method === 'POST') {
            if (!isAdmin(req, env)) return json(403, { error: 'admin only' });
            return json(200, { ok: true, ...(await recount(env)) });
        }

        const ing = url.pathname.match(/^\/ingest\/(0|[1-9]\d{0,11})$/);
        if (ing && req.method === 'POST') {
            if (env.WRITES_OPEN !== '1') {
                return json(403, { error: 'mirror is read-only (origin gone)' });
            }
            const eventId = ing[1];
            const key = 'img/' + eventId;

            /* Rate limit first — before the already-mirrored check, so
             * replaying known ids cannot run up unmetered work either. */
            if (env.INGEST_LIMIT) {
                const who = req.headers.get('cf-connecting-ip') || 'anon';
                const { success } = await env.INGEST_LIMIT.limit({ key: who });
                if (!success) return json(429, { error: 'slow down' });
            }

            if (await env.MIRROR.head(key)) {
                return json(200, { ok: true, note: 'already mirrored' });
            }

            const u = await usage(env);
            if (u.bytes >= CAP_BYTES) {
                return json(507, { error: 'mirror is at its storage cap' });
            }

            const src = req.headers.get('x-source-url') || '';
            if (!src.startsWith('https://assets.poap.xyz/')) {
                return json(400, { error: 'x-source-url must be an assets.poap.xyz URL' });
            }

            /* Bind the image to the event using POAP's own metadata, so nobody
             * can file one event's artwork under another event's id.
             *
             * Compare the PARSED url, never the raw string: fetch() applies
             * WHATWG normalization, so ".../metadata/100/../1/1" starts with
             * ".../metadata/100/" as text but actually resolves to event 1.
             * Parsing first collapses dot segments (and %2e escapes) before
             * the comparison, which is what closes that hole. */
            const turiRaw = req.headers.get('x-token-uri') || '';
            let turiUrl;
            try {
                turiUrl = new URL(turiRaw);
            } catch {
                return json(400, { error: 'x-token-uri is not a URL' });
            }
            const turi = turiUrl.toString();
            if (turiUrl.origin !== 'https://api.poap.tech'
                || !turiUrl.pathname.startsWith('/metadata/' + eventId + '/')) {
                return json(400, {
                    error: 'x-token-uri must be the api.poap.tech metadata URL for event ' + eventId,
                });
            }
            let meta;
            try {
                const m = await fetch(turi, { headers: { 'user-agent': 'poap-mirror/1.0' } });
                if (!m.ok) return json(502, { error: 'metadata origin answered ' + m.status });
                /* Redirects are followed, so the checked URL is only the first
                   hop. Re-pin the host the response actually came from. */
                if (m.url && new URL(m.url).origin !== 'https://api.poap.tech') {
                    return json(502, { error: 'metadata redirected off api.poap.tech' });
                }
                meta = await m.json();
            } catch {
                return json(502, { error: 'metadata origin unreachable' });
            }
            if (!meta || typeof meta !== 'object'
                || (meta.image_url || meta.image || '') !== src) {
                return json(409, {
                    error: 'x-source-url is not the image POAP lists for this event',
                });
            }

            const o = await fetch(src, { headers: { 'user-agent': 'poap-mirror/1.0' } });
            if (!o.ok) return json(502, { error: 'origin answered ' + o.status });
            if (o.url && new URL(o.url).origin !== 'https://assets.poap.xyz') {
                return json(502, { error: 'image redirected off assets.poap.xyz' });
            }
            const ctype = (o.headers.get('content-type') || '')
                .split(';')[0].trim().toLowerCase();
            const buf = await o.arrayBuffer();
            if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
                return json(413, { error: 'origin object empty or over ' + MAX_BYTES + ' bytes' });
            }
            if (!OK_TYPES.includes(ctype) || !looksLikeImage(buf)) {
                return json(415, {
                    error: 'origin did not return an image (content-type ' + (ctype || 'none') + ')',
                });
            }

            const sha = hex(await crypto.subtle.digest('SHA-256', buf));
            /* Conditional put: only the first writer of this key lands, so a
             * concurrent double-ingest can neither overwrite an object nor
             * double-count the ledger. */
            const put = await env.MIRROR.put(key, buf, {
                onlyIf: new Headers({ 'If-None-Match': '*' }),
                httpMetadata: { contentType: ctype },
                customMetadata: { sha256: sha, source: src, ingested: String(Date.now()) },
            });
            if (!put) return json(200, { ok: true, note: 'already mirrored' });

            u.bytes += buf.byteLength;
            u.objects += 1;
            await env.MIRROR.put('_usage', JSON.stringify(u));
            return json(201, { ok: true, event: eventId, sha256: sha, bytes: buf.byteLength });
        }

        return json(404, { error: 'not found' });
    },
};
