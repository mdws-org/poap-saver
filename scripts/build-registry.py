#!/usr/bin/env python3
"""Build registry/events.json — the mirror's contents, independently verifiable.

For every event the mirror holds, the registry records the SHA-256 of the
artwork, its size, the POAP URL it came from, and its IPFS CID. That turns the
mirror from "a bucket someone runs" into something anyone can audit or copy:
fetch an object, hash it, compare; or pin the CIDs and hold the same bytes
without asking permission.

CIDs are computed offline with kubo — no daemon, no network, no pinning, just
the same merkle-DAG arithmetic any IPFS implementation does. Reproducibility
depends on the exact flags, so they are recorded in the registry file itself:
anyone running that command on the same bytes lands on the same CID.

There are two sources, and the registry records which one it used.

--from-mirror lists what the mirror actually holds, which is what anyone else
can fetch and pin. Because the mirror grows every time someone rescues a wallet
through it, this is the mode that keeps the published CID list current: it
computes a CID for every newly contributed event and, with --publish, records
it back so /ipfs/<cid> resolves for it too.

The default reads a local poap-saver archive instead. That is faster and needs
no downloads, but it lists the events THAT ARCHIVE holds, which is not the same
set as the mirror's. The stamped mirror counts show whether the two diverged.

Usage:
    ./scripts/build-registry.py                      # from a local archive
    ./scripts/build-registry.py --from-mirror        # from the mirror's own listing
    ./scripts/build-registry.py --from-mirror --publish   # ...and index new CIDs back

Requires kubo (`brew install ipfs`). Writes registry/events.json.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR = "https://poap-mirror.bemeadows.workers.dev"
CID_CMD = ["ipfs", "add", "--only-hash", "--cid-version=1", "--offline", "-Q"]

# Cloudflare's edge rejects urllib's default signature outright (error 1010),
# so every request here identifies itself. Nothing about this is a workaround:
# a tool talking to an API should say what it is.
UA = "poap-saver-registry/1.0 (+https://github.com/mdws-org/poap-saver)"

# The admin key is read from a file, never passed on the command line, so it
# cannot end up in shell history or a process listing.
KEY_FILE = os.environ.get(
    "POAP_MIRROR_ADMIN_KEY_FILE",
    os.path.expanduser("~/.config/architect/secrets/poap-mirror-admin-key"))

# kubo insists on a repo even to hash offline. Use a throwaway one so this
# never touches (or requires) the operator's real IPFS setup.
_ENV = dict(os.environ, IPFS_PATH=os.path.join(
    tempfile.gettempdir(), "poap-registry-ipfs"))


def _ensure_repo():
    if os.path.isdir(os.path.join(_ENV["IPFS_PATH"], "blocks")):
        return
    r = subprocess.run(["ipfs", "init", "--profile=test"],
                       env=_ENV, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isdir(
            os.path.join(_ENV["IPFS_PATH"], "blocks")):
        raise SystemExit("could not initialise a scratch IPFS repo at "
                         + _ENV["IPFS_PATH"] + ": " + r.stderr.strip())


def cid_of(path):
    out = subprocess.run(CID_CMD + [path], capture_output=True, text=True,
                         env=_ENV)
    if out.returncode != 0:
        raise SystemExit("kubo failed: " + out.stderr.strip())
    return out.stdout.strip()


def from_archive(archive):
    """Read events out of a local poap-saver archive."""
    manifest = json.load(open(os.path.join(archive, "manifest.json")))
    rows = {}
    for p in manifest["poaps"]:
        e = p.get("event_id")
        if not e or not p.get("image_file"):
            continue
        d = os.path.join(archive, p["chain"], str(p["token_id"]))
        img = os.path.join(d, p["image_file"])
        if e in rows or not os.path.exists(img):
            continue
        rows[e] = (img, p.get("image_url"))
    return rows


def _get(path, tries=4):
    """GET a mirror path as JSON, retrying transient failures."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                MIRROR + path, headers={"User-Agent": UA})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except Exception as e:  # noqa: BLE001 - retried, then reported
            last = e
            if attempt + 1 < tries:
                time.sleep(4 * (attempt + 1))
    raise SystemExit(f"mirror GET {path} failed: {last}")


def _get_bytes(path, tries=4):
    """GET raw bytes, retrying — a dropped read must not lose a whole run."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                MIRROR + path, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=180).read()
        except Exception as e:  # noqa: BLE001 - retried, then reported
            last = e
            if attempt + 1 < tries:
                time.sleep(4 * (attempt + 1))
    raise SystemExit(f"mirror GET {path} failed after {tries} tries: {last}")


def _pages(path, key):
    """Walk a cursor-paginated mirror listing, yielding each page's rows."""
    cursor = None
    while True:
        sep = "&" if "?" in path else "?"
        page = _get(path + (f"{sep}cursor={cursor}" if cursor else ""))
        yield page[key]
        if not page.get("truncated"):
            return
        cursor = page["cursor"]


def mirror_events():
    """Every event the mirror currently holds."""
    rows = {}
    for chunk in _pages("/events", "events"):
        rows.update(chunk)
        print(f"  listed {len(rows)} events")
    return rows


def mirror_cids():
    """event id -> CID, for events the mirror has already indexed."""
    known = {}
    for chunk in _pages("/cids", "cids"):
        for row in chunk:
            known[row["event"]] = row["cid"]
    return known


def from_mirror(tmp, publish=None):
    """Download every mirrored object and compute its CID.

    Each object is verified against the SHA-256 the mirror publishes for it
    before being hashed, so a corrupted download becomes a hard error rather
    than a wrong CID quietly entering the registry.

    CIDs are published in batches as they are computed, not all at the end:
    hashing hundreds of objects takes a while, and a failure late in the run
    should not discard the work already done. Publishing is idempotent, so a
    re-run after a failure simply skips whatever already landed.
    """
    rows = mirror_events()
    known = mirror_cids()
    print(f"{len(rows)} events held, {len(known)} already have a published CID")

    events, fresh, pending = {}, {}, {}
    for n, (eid, meta) in enumerate(sorted(rows.items(), key=lambda kv: int(kv[0])), 1):
        cid = known.get(eid)
        if not cid:
            blob = _get_bytes("/img/" + eid)
            got = hashlib.sha256(blob).hexdigest()
            if meta.get("sha256") and got != meta["sha256"]:
                raise SystemExit(
                    f"event {eid}: downloaded bytes hash {got}, mirror says "
                    f"{meta['sha256']} - refusing to publish a CID for this")
            path = os.path.join(tmp, eid)
            with open(path, "wb") as f:
                f.write(blob)
            cid = cid_of(path)
            os.remove(path)
            fresh[eid] = cid
            pending[eid] = cid
            if publish and len(pending) >= 50:
                publish(pending)
                pending = {}
        events[eid] = {
            "sha256": meta.get("sha256", ""),
            "size": meta.get("size", 0),
            "cid": cid,
            "source_url": meta.get("source_url", ""),
        }
        if n % 25 == 0:
            print(f"  {n}/{len(rows)} ({len(fresh)} new CIDs)")
    if publish and pending:
        publish(pending)
    return events, fresh


def make_publisher():
    """Return a callable that records computed CIDs into the mirror.

    The key is read once, up front, so a missing or unreadable key fails
    before hundreds of objects have been downloaded and hashed.
    """
    try:
        key = open(KEY_FILE).read().strip()
    except OSError as e:
        raise SystemExit(f"--publish needs the admin key at {KEY_FILE}: {e}")

    def publish(batch):
        pairs = [{"event": e, "cid": c} for e, c in sorted(batch.items())]
        req = urllib.request.Request(
            MIRROR + "/cid", data=json.dumps(pairs).encode(),
            headers={"content-type": "application/json",
                     "x-admin-key": key, "User-Agent": UA},
            method="POST")
        last = None
        for attempt in range(4):
            try:
                r = json.load(urllib.request.urlopen(req, timeout=120))
                if r.get("indexed") != len(pairs):
                    print(f"  WARNING: submitted {len(pairs)} pairs, mirror "
                          f"indexed {r.get('indexed')}; re-run to reconcile")
                print(f"  published {len(pairs)} CIDs")
                return
            except Exception as e:  # noqa: BLE001 - retried, then reported
                last = e
                if attempt + 1 < 4:
                    time.sleep(4 * (attempt + 1))
        raise SystemExit(f"publishing CIDs failed: {last}")

    return publish


def mirror_stamp():
    """What the mirror reports right now, recorded for comparison."""
    try:
        info = _get("/", tries=2)
        return {"events": info.get("events"), "bytes": info.get("bytes")}
    except Exception as e:  # noqa: BLE001 - the stamp is informational
        return {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive",
                    default=os.path.expanduser(
                        "~/.config/benmeadowsbot/wallet/poap-archive"),
                    help="local poap-saver archive to read")
    ap.add_argument("--from-mirror", action="store_true",
                    help="list the mirror's own contents instead of an archive")
    ap.add_argument("--publish", action="store_true",
                    help="with --from-mirror, record newly computed CIDs back "
                         "into the mirror so /ipfs/<cid> resolves for them")
    args = ap.parse_args()

    if args.publish and not args.from_mirror:
        raise SystemExit("--publish only applies with --from-mirror")
    if not shutil.which("ipfs"):
        raise SystemExit("kubo not found - install it with: brew install ipfs")

    _ensure_repo()
    tmp = tempfile.mkdtemp(prefix="poap-registry-")
    try:
        if args.from_mirror:
            publisher = make_publisher() if args.publish else None
            events, fresh = from_mirror(tmp, publish=publisher)
            if args.publish:
                print(f"published {len(fresh)} new CIDs")
            elif fresh:
                print(f"{len(fresh)} CIDs computed but not published "
                      f"(re-run with --publish to index them)")
        else:
            rows = from_archive(args.archive)
            print(f"{len(rows)} events")
            events = {}
            for n, (e, (img, src)) in enumerate(sorted(rows.items()), 1):
                blob = open(img, "rb").read()
                events[str(e)] = {
                    "sha256": hashlib.sha256(blob).hexdigest(),
                    "size": len(blob),
                    "cid": cid_of(img),
                    "source_url": src,
                }
                if n % 50 == 0:
                    print(f"  {n}/{len(rows)}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    out = {
        "what": ("POAP event artwork with SHA-256 hashes and IPFS CIDs, so "
                 "anyone can verify or re-pin the same bytes"),
        "source": "mirror listing" if args.from_mirror else "local archive",
        "scope": ("Every event the mirror held when this was written; fetch "
                  "any of them at <mirror>/ipfs/<cid> and pin it yourself."
                  if args.from_mirror else
                  "Built from a local archive, not a listing of the mirror. "
                  "mirror_at_build records what the mirror reported when this "
                  "file was written; if its event count has since grown, this "
                  "registry covers only part of the mirror."),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mirror": MIRROR,
        "mirror_at_build": mirror_stamp(),
        "verify_sha256": "curl -s " + MIRROR + "/img/<eventId> | shasum -a 256",
        "verify_cid": " ".join(CID_CMD) + " <file>",
        "note": ("CIDs are reproducible only with the exact command above - "
                 "chunker, CID version and offline mode all affect the hash."),
        "count": len(events),
        "events": events,
    }
    os.makedirs(os.path.join(HERE, "registry"), exist_ok=True)
    path = os.path.join(HERE, "registry", "events.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"wrote {path} ({os.path.getsize(path)//1024} KB, {len(events)} events)")


if __name__ == "__main__":
    main()
