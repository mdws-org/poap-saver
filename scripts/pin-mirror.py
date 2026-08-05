#!/usr/bin/env python3
"""Pin the POAP mirror's artwork on your own IPFS node.

The mirror publishes every CID it holds. This walks that list, fetches each
object, checks the bytes really hash to the advertised CID, and adds them to
your node — which both stores them and starts announcing them to the network.

That last part is the point. A CID on someone else's server is a promise; a CID
pinned on your node is a copy that survives them. Once two or three people have
run this, the artwork is reachable over IPFS whether or not the mirror, or the
person paying for it, is still around.

Nothing here trusts the mirror. Every object is re-hashed locally and rejected
if it does not match, so a mirror serving altered bytes cannot get them pinned.

Usage:
    ./scripts/pin-mirror.py                # pin everything not already pinned
    ./scripts/pin-mirror.py --dry-run      # list what would be pinned
    ./scripts/pin-mirror.py --limit 50     # stop after 50 objects

Requires kubo (`brew install ipfs` / https://docs.ipfs.tech/install/) with a
running daemon, or at least an initialised repo. Safe to re-run: already-pinned
objects are skipped, so an interrupted run just picks up where it stopped.
"""
import argparse
import hashlib
import http.client
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse

MIRROR = os.environ.get("POAP_MIRROR",
                        "https://poap-mirror.bemeadows.workers.dev")
UA = "poap-saver-pin/1.0 (+https://github.com/mdws-org/poap-saver)"

# Must match how the CIDs were computed, or the check below will reject
# perfectly good bytes for hashing differently.
ADD = ["ipfs", "add", "--cid-version=1", "-Q"]


class _Conn:
    """One keep-alive connection to the mirror, reused for every request.

    Opening a fresh connection per object gets throttled hard by Cloudflare —
    a few objects a minute instead of dozens — which turns pinning a few
    hundred badges into hours. Holding one connection open avoids that
    entirely. Any failure drops the socket and the next try reconnects.
    """

    def __init__(self, base):
        p = urllib.parse.urlparse(base)
        self.host = p.netloc
        self.https = p.scheme == "https"
        self.prefix = p.path.rstrip("/")
        self.c = None

    def _connect(self):
        if self.https:
            return http.client.HTTPSConnection(
                self.host, context=ssl.create_default_context(), timeout=180)
        return http.client.HTTPConnection(self.host, timeout=180)

    def get(self, path, tries=4, raw=False):
        last = None
        for attempt in range(tries):
            try:
                if self.c is None:
                    self.c = self._connect()
                self.c.request("GET", self.prefix + path,
                               headers={"User-Agent": UA,
                                        "Connection": "keep-alive"})
                r = self.c.getresponse()
                body = r.read()
                if r.status != 200:
                    raise RuntimeError(f"HTTP {r.status}")
                return body if raw else json.loads(body)
            except Exception as e:  # noqa: BLE001 - retried, then reported
                last = e
                try:
                    self.c.close()
                except Exception:  # noqa: BLE001 - already broken
                    pass
                self.c = None
                if attempt + 1 < tries:
                    time.sleep(4 * (attempt + 1))
        raise SystemExit(f"GET {path} failed after {tries} tries: {last}")


_MIRROR_CONN = _Conn(MIRROR)


def get(path, tries=4, raw=False):
    return _MIRROR_CONN.get(path, tries=tries, raw=raw)


def all_cids():
    """Every (event, cid) the mirror publishes."""
    rows, cursor = [], None
    while True:
        page = get("/cids" + (f"?cursor={cursor}" if cursor else ""))
        rows.extend(page["cids"])
        if not page.get("truncated"):
            return rows
        cursor = page["cursor"]


def already_pinned():
    """CIDs this node already pins, so re-runs cost nothing."""
    out = subprocess.run(["ipfs", "pin", "ls", "--type=recursive", "--quiet"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        return set()
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would be pinned, pin nothing")
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after this many objects (0 = no limit)")
    args = ap.parse_args()

    if not shutil.which("ipfs"):
        raise SystemExit("kubo not found - see https://docs.ipfs.tech/install/")

    rows = all_cids()
    print(f"mirror publishes {len(rows)} CIDs")
    if args.dry_run:
        for r in rows[:args.limit or len(rows)]:
            print(f"  event {r['event']:>7}  {r['cid']}")
        return

    have = already_pinned()
    todo = [r for r in rows if r["cid"] not in have]
    # Count what is genuinely already held BEFORE --limit trims the list, or
    # the objects this run simply is not reaching get reported as "pinned".
    done = len(rows) - len(todo)
    if args.limit and len(todo) > args.limit:
        print(f"{done} already pinned, {len(todo)} outstanding; this run will "
              f"do {args.limit} of them (--limit)")
        todo = todo[:args.limit]
    else:
        print(f"{done} already pinned, {len(todo)} to fetch")

    tmp = tempfile.mkdtemp(prefix="poap-pin-")
    pinned = skipped = 0
    try:
        for n, r in enumerate(todo, 1):
            cid, ev = r["cid"], r["event"]
            blob = get("/ipfs/" + cid, raw=True)
            path = os.path.join(tmp, cid)
            with open(path, "wb") as f:
                f.write(blob)

            out = subprocess.run(ADD + [path], capture_output=True, text=True)
            os.remove(path)
            if out.returncode != 0:
                print(f"  event {ev}: ipfs add failed: {out.stderr.strip()}")
                skipped += 1
                continue

            got = out.stdout.strip()
            if got != cid:
                # The mirror served bytes that are not what it advertised.
                # Refuse them: pinning would republish altered artwork under a
                # CID people trust.
                print(f"  event {ev}: MISMATCH - advertised {cid}, got {got}; "
                      f"not pinning")
                skipped += 1
                continue

            pinned += 1
            if n % 25 == 0 or n == len(todo):
                print(f"  {n}/{len(todo)} ({pinned} pinned, {skipped} skipped)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\npinned {pinned}, skipped {skipped}")
    if pinned:
        print("Your node now holds and announces this artwork. Keep the daemon "
              "running (`ipfs daemon`) for others to fetch it from you.")
    if skipped:
        sys.exit(1)


if __name__ == "__main__":
    main()
