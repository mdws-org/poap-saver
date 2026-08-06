#!/usr/bin/env python3
"""Pin POAP artwork on your own IPFS node.

A CID on someone else's server is a promise; a CID pinned on your node is a
copy that survives them. Once a few people have done this, the artwork is
reachable over IPFS whether or not any particular host, or the person paying
for it, is still around.

There are two sources to pin from, and they differ in what they cover:

The REGISTRY (default) covers the whole archive: every POAP event that
existed when POAP shut down, 190,153 events and 174,498 unique artworks.
It lives in this repository under registry/corpus/ and maps each event to
the CID of its artwork and its metadata. Content is fetched over IPFS
itself, so integrity needs no extra checking - a block that does not hash
to its CID is rejected by your own node before it is stored.

The MIRROR (--mirror) is the original community mirror, an HTTP host holding
the events people saved through the rescue tool. Bytes fetched over HTTP
prove nothing, so this mode re-hashes everything locally and refuses
mismatches. It remains for completeness; the registry supersedes it.

Pinning the entire archive is a real commitment (see summary.json - the
artwork alone is ~157 GB), so you choose what to pin:

    ./scripts/pin-mirror.py                          # show what's available
    ./scripts/pin-mirror.py --archive poap-archive-you.eth/
                                                     # pin your own badges
    ./scripts/pin-mirror.py --events 4242,101250     # pin specific events
    ./scripts/pin-mirror.py --all                    # pin everything
    ./scripts/pin-mirror.py --mirror                 # legacy mirror mode

Requires kubo (https://docs.ipfs.tech/install/) with a running daemon. Safe
to re-run: pinned objects are skipped, so an interrupted run resumes where it
stopped.
"""
import argparse
import glob
import hashlib
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse

MIRROR = os.environ.get("POAP_MIRROR",
                        "https://poap-mirror.bemeadows.workers.dev")
REGISTRY = os.environ.get(
    "POAP_REGISTRY",
    "https://raw.githubusercontent.com/mdws-org/poap-saver/main/registry/corpus")
UA = "poap-saver-pin/2.0 (+https://github.com/mdws-org/poap-saver)"
SHARD = 10000

# How the archive's CIDs were computed. --nocopy on the archive node forces
# raw leaves, which --cid-version=1 defaults to as well, so plain adds here
# produce identical CIDs for identical bytes.
ADD = ["ipfs", "add", "--cid-version=1", "-Q"]


class Conn:
    """One keep-alive connection per host, reconnecting on failure.

    Opening a fresh connection per request gets throttled hard by CDNs -
    a few objects a minute instead of dozens. Any failure drops the socket
    and the next try reconnects.
    """

    _by_host = {}

    def __init__(self, base):
        p = urllib.parse.urlparse(base)
        self.host = p.netloc
        self.https = p.scheme == "https"
        self.c = None

    @classmethod
    def for_url(cls, url):
        host = urllib.parse.urlparse(url).netloc
        if host not in cls._by_host:
            cls._by_host[host] = cls(url)
        return cls._by_host[host]

    def _connect(self):
        if self.https:
            return http.client.HTTPSConnection(
                self.host, context=ssl.create_default_context(), timeout=180)
        return http.client.HTTPConnection(self.host, timeout=180)

    def get(self, url, tries=4):
        """Return (status, body). Retries everything but a clean 404."""
        path = urllib.parse.urlparse(url).path or "/"
        q = urllib.parse.urlparse(url).query
        if q:
            path += "?" + q
        last = None
        for attempt in range(tries):
            try:
                if self.c is None:
                    self.c = self._connect()
                self.c.request("GET", path, headers={
                    "User-Agent": UA, "Connection": "keep-alive"})
                r = self.c.getresponse()
                body = r.read()
                if r.status == 404:
                    return 404, b""
                if r.status != 200:
                    raise RuntimeError(f"HTTP {r.status}")
                return 200, body
            except Exception as e:  # noqa: BLE001 - retried, then reported
                last = e
                try:
                    self.c.close()
                except Exception:  # noqa: BLE001 - already broken
                    pass
                self.c = None
                if attempt + 1 < tries:
                    time.sleep(4 * (attempt + 1))
        raise SystemExit(f"GET {url} failed after {tries} tries: {last}")


def fetch(url):
    st, body = Conn.for_url(url).get(url)
    return None if st == 404 else body


# ---------------------------------------------------------------- registry

def registry_summary(base):
    if not base.startswith(("http://", "https://")):
        with open(os.path.join(base, "summary.json"), encoding="utf-8") as f:
            return json.load(f)
    body = fetch(base.rstrip("/") + "/summary.json")
    if body is None:
        raise SystemExit(f"no summary.json under {base} - wrong --registry?")
    return json.loads(body)


def registry_rows(base, summary, only_events=None):
    """Registry rows from a local checkout or over HTTP.

    When the caller already knows which events it wants, only the shard
    files containing them are read - pinning two badges should not cost a
    download of the whole registry.
    """
    lo, hi = summary["span"]
    shards = range(lo // SHARD, hi // SHARD + 1)
    if only_events is not None:
        wanted = {e // SHARD for e in only_events}
        shards = [s for s in shards if s in wanted]
    for shard in shards:
        a, b = shard * SHARD, shard * SHARD + SHARD - 1
        name = f"events-{a:06d}-{b:06d}.jsonl"
        if base.startswith(("http://", "https://")):
            body = fetch(base.rstrip("/") + "/" + name)
            if body is None:  # a span band with no events has no file
                continue
            lines = body.decode("utf-8").splitlines()
        else:
            path = os.path.join(base, name)
            if not os.path.exists(path):
                continue
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()
        for line in lines:
            if line.strip():
                yield json.loads(line)


def archive_events(archive_dir):
    """Event ids in a poap-saver archive.

    Every archived metadata.json carries _archived_from, the exact tokenURI
    it was fetched from, and that URL names the event:
    https://api.poap.tech/metadata/<eventId>/<tokenId>
    """
    ids = set()
    pattern = os.path.join(archive_dir, "*", "*", "metadata.json")
    for p in glob.glob(pattern):
        try:
            with open(p, encoding="utf-8") as f:
                src = json.load(f).get("_archived_from", "")
        except Exception:  # noqa: BLE001 - skip unreadable, count the rest
            continue
        m = re.search(r"/metadata/(\d+)/", src)
        if m:
            ids.add(int(m.group(1)))
    if not ids:
        raise SystemExit(f"no archived badges found under {archive_dir} - "
                         f"is this a poap-saver archive?")
    return ids


# ----------------------------------------------------------------- pinning

def already_pinned():
    out = subprocess.run(["ipfs", "pin", "ls", "--type=recursive", "--quiet"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        return set()
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


def pin_cids(cids, batch=10):
    """Pin over IPFS. Content arrives block-verified or not at all."""
    have = already_pinned()
    todo = [c for c in dict.fromkeys(cids) if c not in have]
    print(f"{len(cids) - len(todo)} already pinned, {len(todo)} to fetch")
    pinned = failed = 0
    for i in range(0, len(todo), batch):
        group = todo[i:i + batch]
        out = subprocess.run(["ipfs", "--timeout=900s", "pin", "add"] + group,
                             capture_output=True, text=True)
        if out.returncode == 0:
            pinned += len(group)
        else:
            # One unfindable CID fails its whole batch; salvage the rest.
            for cid in group:
                one = subprocess.run(["ipfs", "--timeout=300s", "pin", "add",
                                      cid], capture_output=True, text=True)
                if one.returncode == 0:
                    pinned += 1
                else:
                    failed += 1
                    print(f"  could not pin {cid}: "
                          f"{one.stderr.strip().splitlines()[-1] if one.stderr else 'timeout'}")
        done = min(i + batch, len(todo))
        if done % 50 < batch or done == len(todo):
            print(f"  {done}/{len(todo)} ({pinned} pinned, {failed} failed)")
    return pinned, failed


def pin_registry(args):
    base = args.registry
    summary = registry_summary(base)
    if args.all:
        gb = summary["artwork_bytes"] / 1e9
        print(f"pinning the ENTIRE archive: {summary['events']:,} events, "
              f"{summary['unique_artworks']:,} artworks, ~{gb:.0f} GB "
              f"plus metadata")
        print("two recursive pins cover everything:")
        cids = [summary["blob_root_cid"], summary["meta_root_cid"]]
    else:
        if args.archive:
            wanted = archive_events(args.archive)
            print(f"{len(wanted)} events in {args.archive}")
        else:
            wanted = set()
            for part in args.events.split(","):
                part = part.strip()
                if part:
                    wanted.add(int(part))
        rows = [r for r in registry_rows(base, summary, only_events=wanted)
                if r["event"] in wanted]
        missing = wanted - {r["event"] for r in rows}
        if missing:
            print(f"note: {len(missing)} event(s) not in the registry "
                  f"(never issued, or lost before archiving): "
                  f"{sorted(missing)[:8]}")
        total = sum(r["bytes"] for r in
                    {r["sha256"]: r for r in rows}.values())
        print(f"{len(rows)} events -> "
              f"{len({r['cid'] for r in rows})} artworks "
              f"({total / 1e6:.0f} MB) + metadata")
        cids = [r["cid"] for r in rows] + [r["meta_cid"] for r in rows]
    if args.dry_run:
        for c in dict.fromkeys(cids):
            print(f"  {c}")
        return 0
    pinned, failed = pin_cids(cids)
    print(f"\npinned {pinned}, failed {failed}")
    if pinned:
        print("Your node now holds and announces this content. Keep the "
              "daemon running (`ipfs daemon`) for others to fetch it from "
              "you.")
    return 1 if failed else 0


# ------------------------------------------------------- legacy mirror mode

def mirror_cids():
    rows, cursor = [], None
    while True:
        body = fetch(MIRROR + "/cids" + (f"?cursor={cursor}" if cursor else ""))
        page = json.loads(body)
        rows.extend(page["cids"])
        if not page.get("truncated"):
            return rows
        cursor = page["cursor"]


def pin_mirror(args):
    """Fetch from the HTTP mirror, verify locally, add to this node.

    HTTP bytes prove nothing, so every object is re-hashed and refused on
    mismatch - a mirror serving altered bytes cannot launder them through
    your node.
    """
    rows = mirror_cids()
    print(f"mirror publishes {len(rows)} CIDs")
    if args.dry_run:
        for r in rows:
            print(f"  event {r['event']:>7}  {r['cid']}")
        return 0
    have = already_pinned()
    todo = [r for r in rows if r["cid"] not in have]
    print(f"{len(rows) - len(todo)} already pinned, {len(todo)} to fetch")
    tmp = tempfile.mkdtemp(prefix="poap-pin-")
    pinned = skipped = 0
    try:
        for n, r in enumerate(todo, 1):
            blob = fetch(MIRROR + "/ipfs/" + r["cid"])
            if blob is None:
                print(f"  event {r['event']}: gone from mirror")
                skipped += 1
                continue
            path = os.path.join(tmp, r["cid"])
            with open(path, "wb") as f:
                f.write(blob)
            out = subprocess.run(ADD + [path], capture_output=True, text=True)
            os.remove(path)
            got = out.stdout.strip()
            if out.returncode != 0 or got != r["cid"]:
                print(f"  event {r['event']}: MISMATCH - advertised "
                      f"{r['cid']}, got {got or 'error'}; not pinning")
                skipped += 1
                continue
            pinned += 1
            if n % 25 == 0 or n == len(todo):
                print(f"  {n}/{len(todo)} ({pinned} pinned, {skipped} skipped)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\npinned {pinned}, skipped {skipped}")
    return 1 if skipped else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", default=None,
                    help="registry location (URL or local dir); defaults to "
                         "a local checkout if present, else GitHub")
    ap.add_argument("--all", action="store_true",
                    help="pin the entire archive via its two root CIDs")
    ap.add_argument("--events", default="",
                    help="comma-separated event ids to pin")
    ap.add_argument("--archive", default="",
                    help="pin the events in a poap-saver archive directory")
    ap.add_argument("--mirror", action="store_true",
                    help="legacy mode: pin from the HTTP community mirror")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would be pinned, pin nothing")
    args = ap.parse_args()

    if not shutil.which("ipfs"):
        raise SystemExit("kubo not found - see https://docs.ipfs.tech/install/")

    if args.registry is None:
        local = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             os.pardir, "registry", "corpus")
        args.registry = local if os.path.isdir(local) else REGISTRY

    if args.mirror:
        return pin_mirror(args)
    if args.all or args.events or args.archive:
        return pin_registry(args)

    s = registry_summary(args.registry)
    print(f"The registry covers {s['events']:,} events "
          f"({s['unique_artworks']:,} unique artworks, "
          f"{s['artwork_bytes'] / 1e9:.0f} GB) plus metadata, "
          f"and {s['gaps']:,} ids that never existed.")
    print("Choose what to pin:")
    print("  --archive <dir>      your own rescued badges")
    print("  --events 1,2,3       specific events")
    print("  --all                everything (a real disk commitment)")
    print("  --mirror             the legacy HTTP mirror instead")
    return 0


if __name__ == "__main__":
    sys.exit(main())
