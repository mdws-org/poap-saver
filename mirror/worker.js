/* poap-mirror — a community availability cache for POAP event artwork.
 *
 * POAP artwork is per-event and lives on assets.poap.xyz, which will not
 * outlive the company. This Worker fronts an R2 bucket keyed by event id:
 *
 *   GET  /img/<eventId>     the archived artwork for that event
 *   POST /ingest/<eventId>  ask the mirror to fetch and store that event's
 *                           artwork from POAP's own origin (header
 *                           x-source-url, must be assets.poap.xyz)
 *   GET  /                  what this is, in JSON
 *
 * The mirror never accepts uploaded bytes. Ingest fetches from POAP's origin
 * server-side, hashes what it received, and stores that — so the bucket can
 * only ever contain what POAP actually served, and a stored object records
 * the sha256 and source URL it was born with. Objects are immutable once
 * written. When the origin stops answering, set WRITES_OPEN to anything but
 * "1" and the mirror becomes read-only, holding whatever the community
 * ingested while it could.
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-source-url',
    'Access-Control-Expose-Headers': 'x-sha256,x-source-url,etag',
};

const MAX_BYTES = 15 * 1024 * 1024;

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

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        if (url.pathname === '/' || url.pathname === '') {
            return json(200, {
                what: 'poap-mirror: community availability cache for POAP event artwork',
                keys: 'GET /img/<eventId>; POST /ingest/<eventId> with x-source-url (assets.poap.xyz only)',
                writes: env.WRITES_OPEN === '1' ? 'open' : 'locked',
                source: 'https://github.com/mdws-org/poap-saver',
            });
        }

        const img = url.pathname.match(/^\/img\/(\d{1,12})$/);
        if (img && (req.method === 'GET' || req.method === 'HEAD')) {
            const obj = await env.MIRROR.get('img/' + img[1]);
            if (!obj) return json(404, { error: 'event not mirrored' });
            const h = {
                'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
                'cache-control': 'public, max-age=31536000, immutable',
                'x-sha256': obj.customMetadata?.sha256 || '',
                'x-source-url': obj.customMetadata?.source || '',
                etag: '"' + (obj.customMetadata?.sha256 || img[1]) + '"',
                ...CORS,
            };
            if (req.method === 'HEAD') return new Response(null, { headers: h });
            return new Response(obj.body, { headers: h });
        }

        const ing = url.pathname.match(/^\/ingest\/(\d{1,12})$/);
        if (ing && req.method === 'POST') {
            if (env.WRITES_OPEN !== '1') {
                return json(403, { error: 'mirror is read-only (origin gone)' });
            }
            const key = 'img/' + ing[1];
            if (await env.MIRROR.head(key)) {
                return json(200, { ok: true, note: 'already mirrored' });
            }
            const src = req.headers.get('x-source-url') || '';
            if (!src.startsWith('https://assets.poap.xyz/')) {
                return json(400, { error: 'x-source-url must be an assets.poap.xyz URL' });
            }
            const o = await fetch(src, { headers: { 'user-agent': 'poap-mirror/1.0' } });
            if (!o.ok) {
                return json(502, { error: 'origin answered ' + o.status });
            }
            const buf = await o.arrayBuffer();
            if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
                return json(413, { error: 'origin object empty or over ' + MAX_BYTES + ' bytes' });
            }
            const sha = hex(await crypto.subtle.digest('SHA-256', buf));
            await env.MIRROR.put(key, buf, {
                httpMetadata: {
                    contentType: o.headers.get('content-type') || 'application/octet-stream',
                },
                customMetadata: { sha256: sha, source: src, ingested: String(Date.now()) },
            });
            return json(201, { ok: true, event: ing[1], sha256: sha, bytes: buf.byteLength });
        }

        return json(404, { error: 'not found' });
    },
};
