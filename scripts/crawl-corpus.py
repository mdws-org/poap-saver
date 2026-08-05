#!/usr/bin/env python3
"""Download every POAP event's metadata and artwork while POAP still answers.

POAP is shutting down. Each badge is a permanent token on Gnosis Chain, but its
name, description and artwork live on POAP's servers behind a pointer that can
never be changed. When those servers stop answering, that layer is gone for
every badge at once. This walks the event id space and keeps a copy.

Artwork is stored content-addressed, by SHA-256, so events that share the same
image share one file on disk. Metadata is stored per event. Progress is an
append-only log, so an interrupted run resumes without refetching anything.

Being a good guest matters more than being fast here: POAP gains nothing from
this traffic, and getting rate-limited into a block would end the rescue. One
keep-alive connection per host, one request at a time, paced by --rate.

Usage:
    ./crawl-corpus.py --out D:\\poap-corpus --end 194000
    ./crawl-corpus.py --out D:\\poap-corpus --end 194000 --rate 4
    ./crawl-corpus.py --out D:\\poap-corpus --status

Layout:
    index.jsonl     one row per event saved: id, sha256, bytes, urls
    misses.jsonl    events with no metadata or no usable image
    meta/<id>.json  that event's metadata, as POAP served it
    blob/<ab>/<sha256><ext>   the artwork, deduplicated by content
"""
import argparse
import errno
import hashlib
import http.client
import json
import os
import shutil
import ssl
import sys
import time
import urllib.parse

API = "api.poap.tech"
ASSETS_FALLBACK = "assets.poap.xyz"
UA = "poap-saver-archive/1.0 (+https://github.com/mdws-org/poap-saver)"

# Anything larger than this is not badge artwork; skip rather than fill a disk.
MAX_IMAGE = 64 * 1024 * 1024
# Stop before the volume is genuinely full, leaving room for the OS.
MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024

EXT = {
    "image/png": ".png", "image/gif": ".gif", "image/jpeg": ".jpg",
    "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg",
}


class Host:
    """One keep-alive connection to a host, reconnecting on failure.

    Cloudflare throttles connection-per-request pulls by roughly a hundred
    times, so holding the connection open is the difference between days and
    weeks for a crawl this size.
    """

    def __init__(self, host):
        self.host = host
        self.c = None
        self.ctx = ssl.create_default_context()

    def _open(self):
        return http.client.HTTPSConnection(self.host, context=self.ctx,
                                           timeout=60)

    def get(self, path, tries=3):
        """Return (status, headers, body). status 0 means it never answered."""
        last = None
        for attempt in range(tries):
            try:
                if self.c is None:
                    self.c = self._open()
                self.c.request("GET", path, headers={
                    "User-Agent": UA, "Accept": "*/*",
                    "Connection": "keep-alive"})
                r = self.c.getresponse()
                body = r.read()
                hdrs = {k.lower(): v for k, v in r.getheaders()}
                if r.status in (429, 500, 502, 503, 504):
                    # Back off hard: a shutting-down service under load is
                    # exactly where politeness decides whether we finish.
                    self.close()
                    last = f"HTTP {r.status}"
                    time.sleep(15 * (attempt + 1))
                    continue
                return r.status, hdrs, body
            except Exception as e:  # noqa: BLE001 - retried, then reported
                last = str(e)
                self.close()
                if attempt + 1 < tries:
                    time.sleep(5 * (attempt + 1))
        return 0, {}, str(last).encode()

    def close(self):
        try:
            if self.c:
                self.c.close()
        except Exception:  # noqa: BLE001 - already broken
            pass
        self.c = None


def free_bytes(path):
    return shutil.disk_usage(path).free


def log_files(out):
    """Every progress log in the archive, including per-worker shards.

    Workers append to their own file. Two processes appending to one file
    would interleave partial lines, and a torn line is a lost event.
    """
    if not os.path.isdir(out):
        return []
    return [os.path.join(out, f) for f in sorted(os.listdir(out))
            if (f.startswith(("index", "misses")) and f.endswith(".jsonl"))]


def load_done(out):
    """Event ids already handled, across every worker's logs."""
    done = set()
    for p in log_files(out):
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    done.add(int(json.loads(line)["event"]))
                except Exception:  # noqa: BLE001 - a torn last line is fine
                    continue
    return done


def append(path, row):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")
        f.flush()
        os.fsync(f.fileno())


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def image_target(url):
    """Split an image URL into (host, path) so it can be fetched keep-alive."""
    p = urllib.parse.urlparse(url)
    if p.scheme != "https" or not p.netloc:
        return None, None
    path = p.path or "/"
    if p.query:
        path += "?" + p.query
    return p.netloc, path


def status(out):
    saved = missed = 0
    for p in log_files(out):
        n = sum(1 for _ in open(p, encoding="utf-8"))
        if os.path.basename(p).startswith("index"):
            saved += n
        else:
            missed += n
    blobs = total = 0
    bdir = os.path.join(out, "blob")
    for root, _dirs, files in os.walk(bdir):
        for fn in files:
            blobs += 1
            try:
                total += os.path.getsize(os.path.join(root, fn))
            except OSError:
                pass
    print(f"saved events:  {saved:,}")
    print(f"missing/gaps:  {missed:,}")
    print(f"unique images: {blobs:,}  ({total / 1e9:.1f} GB)")
    if saved:
        print(f"dedupe:        {100 * (1 - blobs / max(saved, 1)):.1f}% of "
              f"events reuse another event's artwork")
    if os.path.exists(out):
        print(f"free on disk:  {free_bytes(out) / 1e9:.0f} GB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="directory to archive into")
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=194000)
    ap.add_argument("--rate", type=float, default=4.0,
                    help="events per second, upper bound (default 4)")
    ap.add_argument("--status", action="store_true",
                    help="report progress and exit")
    ap.add_argument("--shard", default="",
                    help="name for this worker's own log files, so several "
                         "workers can crawl disjoint ranges at once")
    args = ap.parse_args()

    if args.status:
        status(args.out)
        return

    os.makedirs(args.out, exist_ok=True)
    suffix = f"-{args.shard}" if args.shard else ""
    idx_path = os.path.join(args.out, f"index{suffix}.jsonl")
    mis_path = os.path.join(args.out, f"misses{suffix}.jsonl")

    done = load_done(args.out)
    todo = [e for e in range(args.start, args.end + 1) if e not in done]
    print(f"{len(done):,} events already handled, {len(todo):,} to go "
          f"({args.start}-{args.end})", flush=True)
    if not todo:
        return

    api = Host(API)
    images = {}
    interval = 1.0 / args.rate if args.rate > 0 else 0
    saved = missed = reused = 0
    t0 = time.time()

    for n, eid in enumerate(todo, 1):
        started = time.time()

        if free_bytes(args.out) < MIN_FREE_BYTES:
            print(f"stopping: under {MIN_FREE_BYTES / 1e9:.0f} GB free",
                  flush=True)
            break

        st, _h, body = api.get(f"/metadata/{eid}/1")
        if st != 200:
            append(mis_path, {"event": eid, "why": f"metadata {st}"})
            missed += 1
            continue
        try:
            meta = json.loads(body)
        except Exception:  # noqa: BLE001 - not JSON, nothing to save
            append(mis_path, {"event": eid, "why": "metadata not json"})
            missed += 1
            continue

        write_atomic(os.path.join(args.out, "meta", f"{eid}.json"), body)

        url = (meta.get("image_url") or meta.get("image") or "").strip()
        host, path = image_target(url) if url else (None, None)
        if not host:
            append(mis_path, {"event": eid, "why": "no usable image_url",
                              "image_url": url})
            missed += 1
            continue

        if host not in images:
            images[host] = Host(host)
        ist, ih, blob = images[host].get(path)
        if ist != 200 or not blob:
            append(mis_path, {"event": eid, "why": f"image {ist}",
                              "image_url": url})
            missed += 1
            continue
        if len(blob) > MAX_IMAGE:
            append(mis_path, {"event": eid, "why": f"image too large "
                                                   f"({len(blob)} bytes)",
                              "image_url": url})
            missed += 1
            continue

        sha = hashlib.sha256(blob).hexdigest()
        ctype = (ih.get("content-type") or "").split(";")[0].strip().lower()
        ext = EXT.get(ctype) or os.path.splitext(urllib.parse.urlparse(url).path)[1][:6] or ".bin"
        blob_path = os.path.join(args.out, "blob", sha[:2], sha + ext)
        if os.path.exists(blob_path):
            reused += 1
        else:
            write_atomic(blob_path, blob)

        append(idx_path, {"event": eid, "sha256": sha, "bytes": len(blob),
                          "content_type": ctype, "image_url": url,
                          "token_uri": f"https://{API}/metadata/{eid}/1"})
        saved += 1

        if n % 250 == 0:
            rate = n / max(time.time() - t0, 1)
            left = (len(todo) - n) / max(rate, 0.01) / 3600
            print(f"  {n:,}/{len(todo):,}  saved={saved:,} missed={missed:,} "
                  f"dedup={reused:,}  {rate:.1f}/s  ~{left:.1f}h left",
                  flush=True)

        elapsed = time.time() - started
        if interval > elapsed:
            time.sleep(interval - elapsed)

    api.close()
    for h in images.values():
        h.close()
    print(f"\ndone this run: saved={saved:,} missed={missed:,} "
          f"reused={reused:,}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted - rerun to resume", flush=True)
        sys.exit(130)
