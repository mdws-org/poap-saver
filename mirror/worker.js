/* poap-mirror — a community availability cache for POAP event artwork.
 *
 * POAP artwork is per-event and lives on assets.poap.xyz, which will not
 * outlive the company. This Worker fronts an R2 bucket keyed by event id:
 *
 *   GET  /img/<eventId>     the archived artwork for that event
 *   POST /ingest/<eventId>  ask the mirror to fetch and store that event's
 *                           artwork from POAP's own origin. Headers:
 *                             x-source-url    the assets.poap.xyz image URL
 *                             x-token-uri     that event's api.poap.tech
 *                                             metadata URL, used to prove the
 *                                             image really belongs to the event
 *   GET  /                  what this is, in JSON
 *   POST /recount           (admin) rebuild the usage ledger from the bucket
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
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-source-url,x-token-uri',
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
    const head = new TextDecoder().decode(b).trim().toLowerCase();
    return head.startsWith('<svg') || head.startsWith('<?xml');
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

function isAdmin(req, env) {
    return Boolean(env.ADMIN_KEY) && req.headers.get('x-admin-key') === env.ADMIN_KEY;
}

export default {
    /* Cron reconciliation: the ledger is a read-modify-write on one object, so
     * concurrent ingests lose updates permanently. A daily recount from the
     * real bucket listing bounds that drift to a day. */
    async scheduled(event, env) {
        await recount(env);
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
                keys: 'GET /img/<eventId>; POST /ingest/<eventId> with x-source-url + x-token-uri',
                writes: env.WRITES_OPEN === '1' ? 'open' : 'locked',
                events: u.objects,
                bytes: u.bytes,
                cap_bytes: CAP_BYTES,
                source: 'https://github.com/mdws-org/poap-saver',
            });
        }

        const img = url.pathname.match(/^\/img\/(\d{1,12})$/);

        if (img && req.method === 'DELETE') {
            if (!isAdmin(req, env)) return json(403, { error: 'admin only' });
            await env.MIRROR.delete('img/' + img[1]);
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

        if (url.pathname === '/recount' && req.method === 'POST') {
            if (!isAdmin(req, env)) return json(403, { error: 'admin only' });
            return json(200, { ok: true, ...(await recount(env)) });
        }

        const ing = url.pathname.match(/^\/ingest\/(\d{1,12})$/);
        if (ing && req.method === 'POST') {
            if (env.WRITES_OPEN !== '1') {
                return json(403, { error: 'mirror is read-only (origin gone)' });
            }
            const eventId = ing[1];
            const key = 'img/' + eventId;
            if (await env.MIRROR.head(key)) {
                return json(200, { ok: true, note: 'already mirrored' });
            }

            /* Rate limit before any origin work, so a flood costs us nothing
             * and costs POAP's servers nothing either. */
            if (env.INGEST_LIMIT) {
                const who = req.headers.get('cf-connecting-ip') || 'anon';
                const { success } = await env.INGEST_LIMIT.limit({ key: who });
                if (!success) return json(429, { error: 'slow down' });
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
             * can file one event's artwork under another event's id. */
            const turi = req.headers.get('x-token-uri') || '';
            if (!turi.startsWith('https://api.poap.tech/metadata/' + eventId + '/')) {
                return json(400, {
                    error: 'x-token-uri must be the api.poap.tech metadata URL for event ' + eventId,
                });
            }
            let meta;
            try {
                const m = await fetch(turi, { headers: { 'user-agent': 'poap-mirror/1.0' } });
                if (!m.ok) return json(502, { error: 'metadata origin answered ' + m.status });
                meta = await m.json();
            } catch {
                return json(502, { error: 'metadata origin unreachable' });
            }
            if ((meta.image_url || meta.image || '') !== src) {
                return json(409, {
                    error: 'x-source-url is not the image POAP lists for this event',
                });
            }

            const o = await fetch(src, { headers: { 'user-agent': 'poap-mirror/1.0' } });
            if (!o.ok) return json(502, { error: 'origin answered ' + o.status });
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
                onlyIf: { etagDoesNotMatch: '*' },
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
