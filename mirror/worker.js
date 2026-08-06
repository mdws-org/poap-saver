/* poap-mirror — a read-only archive of POAP event artwork saved through the
 * rescue tool while POAP's servers still answered.
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

    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        if (url.pathname === '/' || url.pathname === '') {
            const u = await usage(env);
            return json(200, {
                what: 'poap-mirror: read-only archive of POAP artwork saved through the rescue tool',
                keys: 'GET /img/<eventId>; GET /ipfs/<cid>; GET /events; GET /cids',
                writes: 'retired - the full corpus is archived and on IPFS',
                events: u.objects,
                bytes: u.bytes,
                registry: REGISTRY,
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
