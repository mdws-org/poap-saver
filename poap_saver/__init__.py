"""poap-saver — archive the metadata and artwork your POAPs point at.

POAP badges are permanent ERC-721 tokens on Gnosis Chain (a few migrated to
Ethereum mainnet), but each token's on-chain tokenURI is a plain HTTP URL on
POAP's servers, and the artwork lives on POAP's image host. Neither is
content-addressed, and the pointer baked into the token cannot be changed.
When those servers go dark, the tokens keep proving you were somewhere while
losing every detail of where that was.

This tool saves that layer while the servers still answer:

  poap-saver rescue <address|name.eth>   fetch every badge's metadata + image
  poap-saver site   <archive-dir>        write a browsable gallery into it

The archive is plain files: one directory per token holding metadata.json, the
original image, and a sha256 of the image bytes as served. Re-running rescue is
safe — finished tokens are skipped, and a cached image is trusted only if its
hash still verifies.

Requires Python 3.9+. No dependencies.
"""
import argparse
import hashlib
import http.client
import ipaddress
import json
import mimetypes
import os
import re
import socket
import sys
import time
import urllib.parse

POAP_CONTRACT = "0x22C1f6050E56d2876009903609a2cC3fEf83B415"
RPCS = {
    "gnosis": ["https://rpc.gnosischain.com", "https://gnosis-rpc.publicnode.com",
               "https://gnosis.drpc.org"],
    "eth": ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
}
UA = "poap-saver/1.0 (+https://github.com/mdws-org/poap-saver)"

# Read-only mirror of POAP event artwork (see mirror/ in the repo). Used only
# as a fallback when POAP's own host stops answering; nothing is ever sent to
# it. An availability layer, never a requirement.
MIRROR = "https://poap-mirror.bemeadows.workers.dev"

SEL_BALANCE = "0x70a08231"
SEL_TOKEN_OF_OWNER = "0x2f745c59"
SEL_TOKEN_URI = "0xc87b56dd"
# ENS Universal Resolver: walks the ENSv2 registry tree (live 2026-10-27) and
# falls back to v1, so v1, migrated and native v2 names resolve the same way.
ENS_UNIVERSAL_RESOLVER = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee"
ENS_GATEWAY = "https://ccip-v3.ens.xyz"


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- keccak-256
# ENS namehash needs keccak-256, and hashlib's sha3_256 is the FIPS variant
# with different padding. This is the plain Keccak-f[1600] permutation.

_KECCAK_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A,
    0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008A,
    0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800A, 0x800000008000000A, 0x8000000080008081,
    0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_KECCAK_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M = (1 << 64) - 1


def _rotl(x, n):
    return ((x << n) | (x >> (64 - n))) & _M


def keccak256(data):
    rate = 136
    st = [[0] * 5 for _ in range(5)]
    padded = bytearray(data) + b"\x01" + b"\x00" * (rate - (len(data) % rate) - 1)
    padded[-1] |= 0x80
    for off in range(0, len(padded), rate):
        block = padded[off:off + rate]
        for i in range(rate // 8):
            st[i % 5][i // 5] ^= int.from_bytes(block[i * 8:i * 8 + 8], "little")
        for rnd in range(24):
            c = [st[x][0] ^ st[x][1] ^ st[x][2] ^ st[x][3] ^ st[x][4] for x in range(5)]
            d = [c[(x - 1) % 5] ^ _rotl(c[(x + 1) % 5], 1) for x in range(5)]
            for x in range(5):
                for y in range(5):
                    st[x][y] ^= d[x]
            b = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    b[y][(2 * x + 3 * y) % 5] = _rotl(st[x][y], _KECCAK_ROT[x][y])
            for x in range(5):
                for y in range(5):
                    st[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
            st[0][0] ^= _KECCAK_RC[rnd]
    out = b""
    for i in range(4):
        out += st[i % 5][i // 5].to_bytes(8, "little")
    return out


def namehash(name):
    node = b"\x00" * 32
    if name:
        for label in reversed(name.lower().split(".")):
            node = keccak256(node + keccak256(label.encode()))
    return node


# ------------------------------------------------------------------ JSON-RPC
def rpc_batch(chain, calls, to=POAP_CONTRACT):
    if not calls:
        return []
    payload = [
        {"jsonrpc": "2.0", "id": i, "method": "eth_call",
         "params": [{"to": to, "data": d}, "latest"]}
        for i, d in enumerate(calls)
    ]
    last_err = None
    for url in RPCS[chain]:
        for attempt in range(3):
            try:
                p = urllib.parse.urlparse(url)
                c = http.client.HTTPSConnection(p.netloc, timeout=60)
                c.request("POST", p.path or "/", body=json.dumps(payload),
                          headers={"content-type": "application/json",
                                   "user-agent": UA})
                r = c.getresponse()
                out = json.load(r)
                c.close()
                if isinstance(out, dict):
                    raise RuntimeError(out.get("error", out))
                by_id = {o["id"]: o.get("result") for o in out}
                results = [by_id.get(i) for i in range(len(calls))]
                # A missing/None sub-result is a per-call error (rate limit,
                # node lag). Decoding it as zero would silently drop badges,
                # so treat it as an endpoint failure and move on.
                if any(r is None for r in results):
                    errs = [o.get("error") for o in out if o.get("error")]
                    raise RuntimeError(
                        f"{sum(1 for r in results if r is None)}/{len(calls)}"
                        f" calls failed: {errs[:1]}")
                return results
            except Exception as e:  # noqa: BLE001 - try the next endpoint
                last_err = e
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"all RPC endpoints failed for {chain}: {last_err}")


def decode_uint(h):
    return int(h, 16) if h and h != "0x" else 0


def decode_string(h):
    b = bytes.fromhex(h[2:])
    off = int.from_bytes(b[0:32], "big")
    ln = int.from_bytes(b[off:off + 32], "big")
    return b[off + 32:off + 32 + ln].decode("utf-8", "replace")


class Revert(Exception):
    """An eth_call that reverted, with its revert data."""

    def __init__(self, data):
        super().__init__(data)
        self.data = data or ""


def eth_call(to, data):
    """One eth_call that keeps revert data; ENS offchain names need it."""
    last_err = None
    for url in RPCS["eth"]:
        try:
            out = _post_json(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                                   "params": [{"to": to, "data": data}, "latest"]})
            if out.get("error"):
                raise Revert(out["error"].get("data"))
            return out["result"]
        except Revert:
            raise
        except Exception as e:  # noqa: BLE001 - try the next endpoint
            last_err = e
    raise RuntimeError(f"all RPC endpoints failed for eth: {last_err}")


def _post_json(url, body=None):
    p = urllib.parse.urlparse(url)
    c = http.client.HTTPSConnection(p.netloc, timeout=30)
    path = (p.path or "/") + (("?" + p.query) if p.query else "")
    if body is None:
        c.request("GET", path, headers={"user-agent": UA, "accept": "application/json"})
    else:
        c.request("POST", path, body=json.dumps(body),
                  headers={"content-type": "application/json", "user-agent": UA})
    r = c.getresponse()
    raw = r.read()
    c.close()
    if r.status != 200:
        raise RuntimeError(f"HTTP {r.status} from {p.netloc}")
    return json.loads(raw)


def _w(n):
    return format(n, "064x")


def _bytes_arg(h):
    return _w(len(h) // 2) + h + "0" * ((64 - len(h) % 64) % 64)


def _at(h, off):
    return int(h[off * 2:off * 2 + 64], 16)


def _bytes_at(h, off):
    ln = _at(h, off)
    return h[off * 2 + 64:off * 2 + 64 + ln * 2]


def _gateway(url, sender, data):
    """One EIP-3668 request: GET when the URL carries {data}, POST otherwise."""
    if "{data}" in url:
        out = _post_json(url.replace("{sender}", sender.lower()).replace("{data}", "0x" + data))
    else:
        out = _post_json(url.replace("{sender}", sender.lower()),
                         {"data": "0x" + data, "sender": sender.lower()})
    if not isinstance(out.get("data"), str):
        raise RuntimeError("gateway gave no data")
    return out["data"].removeprefix("0x")


def _local_batch(q):
    """ENSIP-21 batch gateway: query((address,string[],bytes)[]) -> (bool[], bytes[])."""
    h = q[8:]
    arr = _at(h, 0)
    base = arr + 32
    results = []
    for i in range(_at(h, arr)):
        t = base + _at(h, base + 32 * i)
        sender = "0x" + h[t * 2 + 24:t * 2 + 64]
        us = t + _at(h, t + 32)
        urls = [bytes.fromhex(_bytes_at(h, us + 32 + _at(h, us + 32 + 32 * k))).decode()
                for k in range(_at(h, us))]
        data = _bytes_at(h, t + _at(h, t + 64))
        for u in urls:
            try:
                results.append((True, _gateway(u, sender, data)))
                break
            except Exception as e:  # noqa: BLE001 - next URL
                err = str(e)
        else:
            results.append((False, "08c379a0" + _w(32) + _bytes_arg(err.encode().hex())))
    if not any(ok for ok, _ in results):
        raise RuntimeError("every gateway failed")
    flags = _w(len(results)) + "".join(_w(0 if ok else 1) for ok, _ in results)
    tails = [_bytes_arg(d) for _, d in results]
    heads, off = [], 32 * len(results)
    for t in tails:
        heads.append(_w(off))
        off += len(t) // 2
    arr_bytes = _w(len(results)) + "".join(heads) + "".join(tails)
    return _w(0x40) + _w(0x40 + len(flags) // 2) + flags + arr_bytes


def _ur_call(data):
    """eth_call to the Universal Resolver, answering OffchainLookup (EIP-3668)."""
    for _ in range(4):
        try:
            return eth_call(ENS_UNIVERSAL_RESOLVER, data)
        except Revert as rv:
            if not rv.data.startswith("0x556f1830"):
                raise
            h = rv.data[10:]
            sender = "0x" + h[24:64]
            if sender.lower() != ENS_UNIVERSAL_RESOLVER:
                raise RuntimeError("offchain lookup from an unexpected contract") from None
            call_data = _bytes_at(h, _at(h, 64))
            callback = h[192:200]
            extra = _bytes_at(h, _at(h, 128))
            try:
                if call_data[:8] != "a780bab6":
                    raise RuntimeError("not a batch")
                resp = _local_batch(call_data)
            except Exception:  # noqa: BLE001 - fall back to ENS Labs' gateway
                resp = _gateway(ENS_GATEWAY, sender, call_data)
            a = _bytes_arg(resp)
            data = "0x" + callback + _w(0x40) + _w(0x40 + len(a) // 2) + a + _bytes_arg(extra)
    raise RuntimeError("too many offchain lookups")


def resolve_ens(name):
    n = name.strip().lower()
    if not re.fullmatch(r"([a-z0-9_-]+\.)+[a-z0-9-]+", n):
        raise SystemExit(f"{name}: only plain ASCII ENS names are supported - pass the 0x address instead")
    node = namehash(n).hex()
    dns = "".join(format(len(lb), "02x") + lb.encode().hex() for lb in n.split(".")) + "00"

    def resolve(inner):
        a = _bytes_arg(dns)
        res = _ur_call("0x9061b923" + _w(0x40) + _w(0x40 + len(a) // 2) + a + _bytes_arg(inner))
        return _bytes_at(res[2:], _at(res[2:], 0))

    try:  # addr(bytes32, 60): the ENSIP-9 Ethereum record
        b = _bytes_at(resolve("f1cb7e06" + node + _w(60)), 0)
        if len(b) == 40:
            return "0x" + b
    except Exception:  # noqa: BLE001 - older resolvers only answer addr(bytes32)
        pass
    try:
        a = resolve("3b3b57de" + node)[24:64]
        if a and int(a, 16):
            return "0x" + a
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(f"{n}: no Ethereum address is set for this name")


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def enumerate_tokens(chain, addr):
    arg = "0" * 24 + addr[2:].lower()
    bal = decode_uint(rpc_batch(chain, [SEL_BALANCE + arg])[0])
    if not bal:
        return []
    log(f"  {chain}: {bal} POAPs")
    calls = [SEL_TOKEN_OF_OWNER + arg + f"{i:064x}" for i in range(bal)]
    ids = []
    for batch in chunked(calls, 50):
        ids += [decode_uint(r) for r in rpc_batch(chain, batch)]
    ids = [i for i in ids if i]
    uris = []
    for batch in chunked([SEL_TOKEN_URI + f"{t:064x}" for t in ids], 50):
        uris += [decode_string(r) if r else None for r in rpc_batch(chain, batch)]
    return list(zip(ids, uris))


# ------------------------------------------------------- HTTP with keep-alive
# POAP sits behind a CDN that slow-walks a sustained pull opened as one
# connection per request. One keep-alive connection per host is both faster
# for you and lighter for them. Stay serial; do not add concurrency.
_CONNS = {}


# Metadata and image URLs come from whoever made each event, so a URL (or a
# redirect) can name loopback, the LAN or a cloud metadata address. Each
# connection resolves its host once, refuses any address that is not public,
# and connects to the address it checked.
class Refused(Exception):
    """A URL this tool will not fetch. Retrying cannot change the answer."""


def _public_addrs(host, port):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as e:
        raise RuntimeError(f"{host}: {e}") from None
    addrs = list(dict.fromkeys(sa[0] for *_, sa in infos))
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%")[0])
        if not ip.is_global or ip.is_multicast:
            raise Refused(f"refusing {host}: it resolves to {ip}, which is not a public address")
    return addrs


def _connect_any(addrs, port, timeout):
    err = OSError("no address to connect to")
    for a in addrs:
        try:
            return socket.create_connection((a, port), timeout)
        except OSError as e:
            err = e
    raise err


class _PinnedHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = _connect_any(self._addrs, self.port, self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        sock = _connect_any(self._addrs, self.port, self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _conn(scheme, host):
    key = (scheme, host)
    if key not in _CONNS:
        c = (_PinnedHTTP if scheme == "http" else _PinnedHTTPS)(host, timeout=45)
        c._addrs = _public_addrs(c.host, c.port)
        _CONNS[key] = c
    return _CONNS[key]


def _drop(scheme, host):
    try:
        _CONNS.pop((scheme, host)).close()
    except Exception:  # noqa: BLE001
        pass


def fetch(url, binary=False, _depth=0, tries=3):
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise Refused(f"refusing {url[:80]}: only http and https URLs are fetched")
    path = p.path + ("?" + p.query if p.query else "")
    last = None
    for attempt in range(tries):
        try:
            c = _conn(p.scheme, p.netloc)
            c.request("GET", path, headers={"User-Agent": UA, "Accept": "*/*",
                                            "Connection": "keep-alive"})
            r = c.getresponse()
            data = r.read()
            ctype = r.headers.get("content-type", "")
            if r.status in (301, 302, 303, 307, 308):
                loc = r.headers.get("location")
                if loc:
                    if _depth >= 5:
                        raise RuntimeError("too many redirects")
                    nxt = urllib.parse.urljoin(url, loc)
                    if p.scheme == "https" and urllib.parse.urlparse(nxt).scheme != "https":
                        raise Refused(f"refusing a redirect from https to {nxt[:80]}")
                    return fetch(nxt, binary, _depth + 1, tries)
            if r.status == 429 or r.status >= 500:
                _drop(p.scheme, p.netloc)
                last = RuntimeError(f"HTTP {r.status}")
                if attempt + 1 >= tries:
                    break
                time.sleep(10 * (attempt + 1))
                continue
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            return (data, ctype) if binary else (json.loads(data), ctype)
        except Refused:
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            _drop(p.scheme, p.netloc)
            if attempt + 1 < tries:
                time.sleep(2 * (attempt + 1))
    raise last


def _write_atomic(path, data):
    tmp = path + ".tmp"
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(tmp, mode) as f:
        f.write(data)
    os.replace(tmp, path)


# -------------------------------------------------------------------- rescue
def archive_token(outdir, chain, wallet, token_id, uri, stats, failures,
                  use_mirror=True):
    tdir = os.path.join(outdir, chain, str(token_id))
    meta_path = os.path.join(tdir, "metadata.json")
    os.makedirs(tdir, exist_ok=True)

    meta = None
    if os.path.exists(meta_path):
        # A crash mid-write leaves a truncated file; treat it as absent
        # rather than wedging every later run.
        try:
            meta = json.load(open(meta_path))
            stats["meta_cached"] += 1
        except (json.JSONDecodeError, OSError):
            meta = None
    if meta is None:
        try:
            meta, _ = fetch(uri)
        except Exception as e:  # noqa: BLE001
            log(f"    !! metadata {token_id}: {e}")
            stats["meta_fail"] += 1
            failures.append(f"{chain}/{token_id}: metadata: {e}")
            return None
        meta["_archived_from"] = uri
        meta["_archived_ts"] = int(time.time())
        _write_atomic(meta_path,
                      json.dumps(meta, indent=2, ensure_ascii=False))
        stats["meta_new"] += 1
        time.sleep(0.25)

    event_id = None
    parts = (uri or "").rstrip("/").split("/")
    if len(parts) >= 2 and parts[-2].isdigit():
        event_id = int(parts[-2])

    img_url = meta.get("image_url") or meta.get("image")
    img_file = None
    img_source = None
    if img_url:
        side = os.path.join(tdir, "image.sha256")
        cached = None
        for f_ in os.listdir(tdir):
            if f_.startswith("image.") and not f_.endswith(".sha256") \
                    and not f_.endswith(".tmp"):
                if os.path.exists(side):
                    parts = open(side).read().split()
                    want = parts[0] if parts else None
                    got = hashlib.sha256(
                        open(os.path.join(tdir, f_), "rb").read()).hexdigest()
                    if want == got:
                        cached = f_
                break
        if cached:
            img_file = cached
            stats["img_cached"] += 1
        else:
            try:
                # POAP's own host first; the read-only mirror only when it
                # no longer answers for this event.
                try:
                    blob, ctype = fetch(img_url, binary=True)
                    img_source = "origin"
                except Exception:  # noqa: BLE001 - origin gone, try mirror
                    if not (use_mirror and event_id):
                        raise
                    blob, ctype = fetch(f"{MIRROR}/img/{event_id}",
                                        binary=True, tries=1)
                    img_source = "mirror"
                ext = (mimetypes.guess_extension(ctype.split(";")[0].strip())
                       or os.path.splitext(urllib.parse.urlparse(img_url).path)[1]
                       or ".bin")
                if ext == ".jpe":
                    ext = ".jpg"
                img_file = "image" + ext
                _write_atomic(os.path.join(tdir, img_file), blob)
                _write_atomic(side, hashlib.sha256(blob).hexdigest()
                              + "  " + img_file + "\n")
                stats["img_new"] += 1
                if img_source == "mirror":
                    stats["img_mirror"] += 1
                time.sleep(0.25)
            except Exception as e:  # noqa: BLE001
                log(f"    !! image {token_id}: {e}")
                stats["img_fail"] += 1
                failures.append(f"{chain}/{token_id}: image: {e}")

    return {
        "chain": chain, "wallet": wallet, "token_id": token_id,
        "event_id": event_id, "name": meta.get("name"),
        "description": meta.get("description"), "year": meta.get("year"),
        "image_url": img_url, "image_file": img_file,
        "image_source": img_source, "token_uri": uri,
        "attributes": meta.get("attributes"),
    }


def cmd_rescue(args):
    target = args.address
    if re.fullmatch(r"0[xX][0-9a-fA-F]{40}", target):
        target = "0x" + target[2:]
    else:
        if not target.isascii():
            raise SystemExit(
                f"{target}: non-ASCII ENS names need UTS-46 normalization, "
                "which this tool does not implement - paste the 0x address "
                "instead")
        log(f"resolving {target} via ENS…")
        target = resolve_ens(target)
        log(f"  -> {target}")
    outdir = args.out or f"poap-archive-{target[2:10].lower()}"
    os.makedirs(outdir, exist_ok=True)

    use_mirror = not getattr(args, "no_mirror", False)
    stats = dict(meta_new=0, meta_cached=0, meta_fail=0,
                 img_new=0, img_cached=0, img_fail=0, img_mirror=0)
    rows = []
    failures = []
    for chain in ("gnosis", "eth"):
        log(f"[{chain}] enumerating…")
        try:
            toks = enumerate_tokens(chain, target)
        except Exception as e:  # noqa: BLE001
            log(f"  !! {chain}: enumeration FAILED: {e}")
            failures.append(f"{chain}: enumeration: {e}")
            continue
        t0 = time.time()
        for n, (token_id, uri) in enumerate(toks, 1):
            if not uri:
                failures.append(f"{chain}/{token_id}: empty tokenURI")
                continue
            r = archive_token(outdir, chain, target, token_id, uri, stats,
                              failures, use_mirror=use_mirror)
            if r:
                rows.append(r)
            if n % 25 == 0:
                rate = n / max(time.time() - t0, 1e-9) * 60
                log(f"    {n}/{len(toks)}  ({rate:.0f}/min)")

    # Merge with any existing manifest so a run with one chain's RPC down
    # cannot erase the other chain's previously archived rows.
    merged = {}
    mpath = os.path.join(outdir, "manifest.json")
    if os.path.exists(mpath):
        try:
            for p_ in json.load(open(mpath)).get("poaps", []):
                merged[(p_.get("chain"), str(p_.get("token_id")))] = p_
        except (json.JSONDecodeError, OSError):
            pass
    for r in rows:
        merged[(r["chain"], str(r["token_id"]))] = r
    allrows = list(merged.values())
    _write_atomic(mpath, json.dumps(
        {"generated": int(time.time()), "address": target,
         "count": len(allrows), "contract": POAP_CONTRACT,
         "failures": failures, "poaps": allrows},
        indent=2, ensure_ascii=False))
    rows = allrows

    log(f"\nsaved {len(rows)} POAPs -> {outdir}/")
    log(f"  metadata: {stats['meta_new']} new, {stats['meta_cached']} cached, "
        f"{stats['meta_fail']} FAILED")
    log(f"  images:   {stats['img_new']} new ({stats['img_mirror']} via mirror), "
        f"{stats['img_cached']} cached, {stats['img_fail']} FAILED")
    class _A:
        archive = outdir
    cmd_site(_A)
    if stats["meta_fail"] or stats["img_fail"]:
        log("re-run to retry the failures; finished tokens are skipped.")
        return 1
    return 0


# ---------------------------------------------------------------------- site
def cmd_site(args):
    outdir = args.archive
    mpath = os.path.join(outdir, "manifest.json")
    if not os.path.exists(mpath):
        raise SystemExit(f"{mpath} not found — run rescue first")
    manifest = json.load(open(mpath))
    rows = []
    for p in manifest["poaps"]:
        img = (f"{p['chain']}/{p['token_id']}/{p['image_file']}"
               if p.get("image_file") else None)
        sha = None
        side = os.path.join(outdir, p["chain"], str(p["token_id"]), "image.sha256")
        if os.path.exists(side):
            parts = open(side).read().split()
            sha = parts[0] if parts else None
        rows.append({"c": p["chain"], "t": str(p["token_id"]),
                     "e": p.get("event_id"), "n": p.get("name") or "POAP",
                     "d": (p.get("description") or "").strip(),
                     "y": p.get("year"), "img": img, "sha": sha,
                     "uri": p.get("token_uri"), "src": p.get("image_url")})
    html = gallery_html(manifest["address"], rows)
    out = os.path.join(outdir, "index.html")
    with open(out, "w") as f:
        f.write(html)
    log(f"gallery: {out} — open it in a browser")
    return 0


def gallery_html(address, rows):
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "gallery-template.html"),
                 os.path.join(here, "..", "web", "gallery-template.html")):
        if os.path.exists(cand):
            tpl = open(cand).read()
            break
    else:
        raise SystemExit("gallery-template.html not found")
    # No "<" may appear inside the inline <script> block: badge metadata is
    # third-party text, and "</script>" ends the element while "<!--<script"
    # changes how the browser finds its end. JSON reads \u003c back as "<".
    data = json.dumps(rows, ensure_ascii=False,
                      separators=(",", ":")).replace("<", "\\u003c")
    return (tpl.replace("__ADDRESS__", address)
               .replace("__COUNT__", str(len(rows)))
               .replace("__DATA__", data))


def main():
    ap = argparse.ArgumentParser(prog="poap-saver", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("rescue", help="archive every POAP an address holds")
    r.add_argument("address", help="0x address or ENS name")
    r.add_argument("--out", help="archive directory (default: poap-archive-<addr>)")
    r.add_argument("--no-mirror", action="store_true",
                   help="never fall back to the read-only community mirror; "
                        "talk to POAP's hosts only")
    r.set_defaults(fn=cmd_rescue)
    s = sub.add_parser("site", help="write a gallery index.html into an archive")
    s.add_argument("archive", help="archive directory from rescue")
    s.set_defaults(fn=cmd_site)
    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
