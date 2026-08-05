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

The registry is built from a local poap-saver archive, and it says so in the
file: it lists the events THAT ARCHIVE holds, which is a superset-or-equal of
what was contributed to the mirror from it, not a listing of the mirror's live
contents. The stamped mirror counts let a reader see at a glance whether the
two had diverged when it was written.

Usage:
    ./scripts/build-registry.py     # from a local archive

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


def mirror_stamp():
    """What the mirror reports right now, recorded for comparison."""
    try:
        req = urllib.request.Request(
            MIRROR + "/", headers={"User-Agent": "poap-saver-registry/1.0"})
        info = json.load(urllib.request.urlopen(req, timeout=30))
        return {"events": info.get("events"), "bytes": info.get("bytes")}
    except Exception as e:  # noqa: BLE001 - the stamp is informational
        return {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive",
                    default=os.path.expanduser(
                        "~/.config/benmeadowsbot/wallet/poap-archive"),
                    help="local poap-saver archive to read")
    args = ap.parse_args()

    if not shutil.which("ipfs"):
        raise SystemExit("kubo not found - install it with: brew install ipfs")

    _ensure_repo()
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

    out = {
        "what": ("POAP event artwork from a poap-saver archive, with SHA-256 "
                 "hashes and IPFS CIDs, so anyone can verify or re-pin the "
                 "same bytes"),
        "scope": ("Built from a local archive, not a listing of the mirror. "
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
