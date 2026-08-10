/* poap-mirror — a read-only mirror of the POAP event artwork this project's
 * own rescues saved while POAP's servers still answered. The complete
 * archive of every event lives in registry/corpus/ and on IPFS; this bucket
 * is a fast HTTP copy of the badges we personally care about.
 *
 * This Worker fronts an R2 bucket keyed by event id:
 *
 *   GET  /img/<eventId>     the archived artwork for that event
 *   GET  /ipfs/<cid>        the same artwork addressed by its IPFS CID
 *   GET  /                  what this is, in JSON
 *   GET  /events            every event held, with size, sha256 and origin URL
 *   GET  /cids              every CID held, paired with its event
 *   POST /recount           (admin) rebuild the usage ledger from the bucket
 *   POST /cid               (admin) record the CID of an event's object
 *   DELETE /img/<eventId>   (admin) remove a poisoned object
 *
 * Ingest is retired. While POAP's origin answered, POST /ingest let any rescue
 * extend the mirror, with the artwork-to-event binding proven against POAP's
 * own metadata; that proof was only enforceable while the origin lived, and
 * the reason to grow this bucket ended when the full corpus was archived —
 * every event, verified byte-for-byte, published to IPFS and mapped in
 * registry/corpus/ in this repository. The endpoint answers 410 so old
 * clients get a clean, non-retryable no (they fall back to fetching from
 * POAP directly, which was always the design).
 *
 * What remains is immutable: only what POAP itself served, filed under the
 * event POAP said it belonged to, each object carrying its SHA-256 as
 * ingested. CIDs were computed offline with kubo and recorded here, so
 * /ipfs/<cid> resolves to exactly the bytes that hash to that CID, and
 * /events + /cids publish the inventory so nobody has to trust this host.
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-admin-key',
    'Access-Control-Expose-Headers': 'x-sha256,x-source-url,etag',
};

const REGISTRY =
    'https://github.com/mdws-org/poap-saver/tree/main/registry/corpus';

/* ------------------------------------------------------------------ corpus
 * The COMPLETE archive (every event, 197,577 of them) lives in a private
 * bucket of S3-compatible object storage, mirrored from the verified corpus.
 * This Worker is its only public face: it signs requests (SigV4), streams the
 * object through, and parks the response in Cloudflare's edge cache, so the
 * origin sees each object roughly once per point of presence.
 *
 *   GET /corpus/img/<eventId>    original artwork for that event
 *   GET /corpus/meta/<eventId>   the metadata JSON POAP served for it
 *   GET /corpus/thumb/<eventId>  400px WebP still, for grid browsing
 *
 * The blob store is content-addressed and deduplicated, so by-event lookup
 * goes through cindex/ shards (1000 events each) that live next to the data.
 * Credentials are Worker secrets scoped to that one bucket; nothing here can
 * touch any other storage.
 */
const CORPUS = {
    host: 's3.us-west-002.backblazeb2.com',
    bucket: 'poap-corpus-mirror',
    region: 'us-west-002',
};
/* Ext codes as written by the crawler - jpeg and jpg both landed as .jpg. */
const CORPUS_EXT = {
    p: ['png', 'image/png'],
    g: ['gif', 'image/gif'],
    j: ['jpg', 'image/jpeg'],
    w: ['webp', 'image/webp'],
};

const te = new TextEncoder();

async function sha256hex(s) {
    const d = await crypto.subtle.digest('SHA-256', te.encode(s));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, msg) {
    const k = await crypto.subtle.importKey(
        'raw', key instanceof Uint8Array ? key : te.encode(key),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(msg)));
}

/* Minimal SigV4 for GET: unsigned payload, three signed headers. */
async function corpusFetch(env, key) {
    const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const date = amz.slice(0, 8);
    const uri = '/' + CORPUS.bucket + '/' +
        key.split('/').map(encodeURIComponent).join('/');
    const scope = date + '/' + CORPUS.region + '/s3/aws4_request';
    const canonical = [
        'GET', uri, '',
        'host:' + CORPUS.host,
        'x-amz-content-sha256:UNSIGNED-PAYLOAD',
        'x-amz-date:' + amz,
        '',
        'host;x-amz-content-sha256;x-amz-date',
        'UNSIGNED-PAYLOAD',
    ].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amz, scope,
        await sha256hex(canonical)].join('\n');
    let k = await hmac('AWS4' + env.CORPUS_APP_KEY, date);
    k = await hmac(k, CORPUS.region);
    k = await hmac(k, 's3');
    k = await hmac(k, 'aws4_request');
    const sig = [...await hmac(k, toSign)]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    return fetch('https://' + CORPUS.host + uri, {
        headers: {
            authorization: 'AWS4-HMAC-SHA256 Credential=' + env.CORPUS_KEY_ID +
                '/' + scope +
                ', SignedHeaders=host;x-amz-content-sha256;x-amz-date' +
                ', Signature=' + sig,
            'x-amz-date': amz,
            'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        },
    });
}

/* Origin-once: everything the corpus serves is immutable, so cache under a
 * synthetic URL keyed by object name and let the edge absorb repeats. */
async function corpusCached(env, ctx, key, contentType) {
    const cacheKey = 'https://corpus-cache.invalid/' + key;
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
    const up = await corpusFetch(env, key);
    if (!up.ok) {
        return null;
    }
    const res = new Response(await up.arrayBuffer(), {
        headers: {
            'content-type': contentType,
            'cache-control': 'public, max-age=31536000, immutable',
        },
    });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    return res;
}

function corpusHeaders(extra) {
    return {
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        ...CORS,
        ...extra,
    };
}

function json(status, obj) {
    return new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { 'content-type': 'application/json', ...CORS },
    });
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

    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        if (url.pathname === '/' || url.pathname === '') {
            const u = await usage(env);
            return json(200, {
                what: 'poap-mirror: read-only archive of POAP artwork saved through the rescue tool',
                keys: 'GET /img/<eventId>; GET /ipfs/<cid>; GET /corpus/img/<eventId>; GET /corpus/meta/<eventId>; GET /corpus/thumb/<eventId>; GET /corpus/anim/<eventId>; GET /events; GET /cids',
                writes: 'retired - the full corpus is archived and on IPFS',
                corpus: 'complete archive of every POAP event, served from S3-compatible object storage',
                events: u.objects,
                bytes: u.bytes,
                registry: REGISTRY,
                source: 'https://github.com/mdws-org/poap-saver',
            });
        }

        /* Membership index, one shard per 1000 events: lets a page answer
           "is event N archived?" for a whole wallet with a handful of small
           cached fetches instead of one probe per badge. */
        const cidx = url.pathname.match(/^\/corpus\/index\/(0|[1-9]\d{0,6})$/);
        if (cidx && (req.method === 'GET' || req.method === 'HEAD')) {
            if (!env.CORPUS_KEY_ID || !env.CORPUS_APP_KEY) {
                return json(503, { error: 'corpus tier not configured' });
            }
            const res = await corpusCached(env, ctx,
                'cindex/' + cidx[1] + '.json', 'application/json');
            if (!res) return json(404, { error: 'no such index shard' });
            const h = corpusHeaders({
                'content-type': 'application/json',
                etag: '"cindex-' + cidx[1] + '"',
            });
            if (req.method === 'HEAD') return new Response(null, { headers: h });
            return new Response(res.body, { headers: h });
        }

        /* Animation derivatives. GIF has no modern interframe compression, so
           the originals average 1.8 MB and are the slowest thing any reader
           waits on. These are re-encodes: H.264 where the badge is opaque,
           animated WebP where it genuinely uses transparency (H.264 has no
           alpha and would matte it to a solid colour). The original GIF is
           still served by /corpus/img/<eventId> and remains the preserved,
           hash-verified artifact - this route is for playback only.

           Format is discovered rather than guessed: try mp4, fall back to
           webp, so the caller does not need to know which one a badge got. */
        const anim = url.pathname.match(/^\/corpus\/anim\/(0|[1-9]\d{0,11})$/);
        if (anim && (req.method === 'GET' || req.method === 'HEAD')) {
            if (!env.CORPUS_KEY_ID || !env.CORPUS_APP_KEY) {
                return json(503, { error: 'corpus tier not configured' });
            }
            const eventId = anim[1];
            for (const [ext, ct] of [['mp4', 'video/mp4'], ['webp', 'image/webp']]) {
                const res = await corpusCached(env, ctx,
                    'anim/' + eventId + '.' + ext, ct);
                if (!res) continue;
                const h = corpusHeaders({
                    'content-type': ct,
                    'x-poap-event': eventId,
                    'x-anim-format': ext,
                    etag: '"anim-' + eventId + '-' + ext + '"',
                });
                if (req.method === 'HEAD') return new Response(null, { headers: h });
                return new Response(res.body, { headers: h });
            }
            return json(404, {
                error: 'no animation derivative for this event',
                note: 'the original is at /corpus/img/<eventId>',
            });
        }

        /* ------------------------------------------------ complete corpus */
        const corp = url.pathname.match(/^\/corpus\/(img|meta|thumb)\/(0|[1-9]\d{0,11})$/);
        if (corp && (req.method === 'GET' || req.method === 'HEAD')) {
            if (!env.CORPUS_KEY_ID || !env.CORPUS_APP_KEY) {
                return json(503, { error: 'corpus tier not configured' });
            }
            const eventId = corp[2];

            if (corp[1] === 'meta') {
                const res = await corpusCached(env, ctx,
                    'meta/' + eventId + '.json', 'application/json');
                if (!res) return json(404, { error: 'event not in corpus', registry: REGISTRY });
                const h = corpusHeaders({
                    'content-type': 'application/json',
                    'x-poap-event': eventId,
                    etag: '"meta-' + eventId + '"',
                });
                if (req.method === 'HEAD') return new Response(null, { headers: h });
                return new Response(res.body, { headers: h });
            }

            const shard = await corpusCached(env, ctx,
                'cindex/' + Math.floor(Number(eventId) / 1000) + '.json',
                'application/json');
            if (!shard) return json(404, { error: 'event not in corpus', registry: REGISTRY });
            const entry = (await shard.clone().json())[eventId];
            if (!entry) {
                return json(404, {
                    error: 'event not in corpus',
                    note: 'either it never existed or POAP never stored artwork for it - see gaps.jsonl in the registry',
                    registry: REGISTRY,
                });
            }
            const [sha, code] = entry;
            const [ext, ct] = CORPUS_EXT[code] || ['bin', 'application/octet-stream'];

            /* Thumbnails are keyed by SHA exactly like the blobs, so the 24,449
               events that share artwork share one 400px render too. */
            if (corp[1] === 'thumb') {
                const t = await corpusCached(env, ctx,
                    'thumb/' + sha.slice(0, 2) + '/' + sha + '.webp', 'image/webp');
                if (!t) {
                    return json(404, {
                        error: 'no thumbnail for this event',
                        note: 'a small number of archived blobs are not decodable images - POAP served a data: URI, a video, or a truncated file - so no thumbnail exists. The original bytes are still at /corpus/img/<eventId>.',
                    });
                }
                const th = corpusHeaders({
                    'content-type': 'image/webp',
                    'x-sha256': sha,
                    'x-poap-event': eventId,
                    etag: '"thumb-' + sha + '"',
                });
                if (req.method === 'HEAD') return new Response(null, { headers: th });
                return new Response(t.body, { headers: th });
            }

            const res = await corpusCached(env, ctx,
                'blob/' + sha.slice(0, 2) + '/' + sha + '.' + ext, ct);
            if (!res) return json(404, { error: 'blob missing from corpus store' });
            const h = corpusHeaders({
                'content-type': ct,
                'x-sha256': sha,
                'x-poap-event': eventId,
                etag: '"' + sha + '"',
            });
            if (req.method === 'HEAD') return new Response(null, { headers: h });
            return new Response(res.body, { headers: h });
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

        /* Ingest is retired: the full corpus is archived and on IPFS. 410
         * rather than 404 so old clients get a definitive, non-retryable no;
         * they fall back to fetching from POAP directly. */
        if (url.pathname.startsWith('/ingest/') && req.method === 'POST') {
            return json(410, {
                error: 'ingest is retired - every POAP event is already archived',
                registry: REGISTRY,
            });
        }

        return json(404, { error: 'not found' });
    },
};
