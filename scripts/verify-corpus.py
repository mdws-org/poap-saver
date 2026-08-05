#!/usr/bin/env python3
"""Check that a corpus crawl is complete and internally consistent.

A crawl that ends without errors is not the same as a crawl that got
everything. Workers run in parallel over disjoint ranges and append to their
own logs, so the failure modes worth catching are structural: an id no worker
ever reached, an id two workers both claimed, an index row whose artwork is
missing from disk, or metadata that was never written.

The default pass is structural and reads only the logs and directory entries,
so it finishes in seconds on a corpus of any size. --deep additionally re-reads
every blob and checks it against the SHA-256 recorded when it was fetched,
which is the only way to catch bytes that rotted or were truncated on write.

Usage:
    ./verify-corpus.py --out D:\\poap-corpus --end 194000
    ./verify-corpus.py --out D:\\poap-corpus --end 194000 --deep
"""
import argparse
import hashlib
import json
import os
import sys

SAMPLE = 8  # how many offending ids to name before summarising


def rows(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:  # noqa: BLE001 - a torn last line is survivable
                continue


def show(label, ids):
    if not ids:
        return False
    head = ", ".join(str(i) for i in sorted(ids)[:SAMPLE])
    more = f", +{len(ids) - SAMPLE} more" if len(ids) > SAMPLE else ""
    print(f"  {label}: {len(ids):,}  [{head}{more}]")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=194000)
    ap.add_argument("--deep", action="store_true",
                    help="re-hash every blob against its recorded SHA-256")
    args = ap.parse_args()

    files = sorted(f for f in os.listdir(args.out)
                   if f.startswith(("index", "misses")) and f.endswith(".jsonl"))
    saved, missed, dupes = {}, {}, set()
    for fn in files:
        target = saved if fn.startswith("index") else missed
        for r in rows(os.path.join(args.out, fn)):
            eid = int(r["event"])
            if eid in saved or eid in missed:
                dupes.add(eid)
            target[eid] = r

    span = set(range(args.start, args.end + 1))
    seen = set(saved) | set(missed)
    problems = False

    print(f"span {args.start:,}-{args.end:,}: {len(saved):,} saved, "
          f"{len(missed):,} gaps, {len(seen):,} accounted for")
    problems |= show("NEVER REACHED", span - seen)
    problems |= show("OUTSIDE SPAN", seen - span)
    problems |= show("CLAIMED TWICE", dupes)

    # Every saved event needs both halves: the metadata and the artwork.
    no_meta, no_blob, bad_hash = set(), set(), set()
    blobs = {}
    for root, _dirs, names in os.walk(os.path.join(args.out, "blob")):
        for n in names:
            blobs[os.path.splitext(n)[0]] = os.path.join(root, n)

    for eid, r in saved.items():
        if not os.path.exists(os.path.join(args.out, "meta", f"{eid}.json")):
            no_meta.add(eid)
        if r["sha256"] not in blobs:
            no_blob.add(eid)

    problems |= show("METADATA MISSING", no_meta)
    problems |= show("ARTWORK MISSING", no_blob)

    if args.deep:
        print(f"re-hashing {len(blobs):,} blobs...")
        want = {r["sha256"]: eid for eid, r in saved.items()}
        for n, (sha, path) in enumerate(sorted(blobs.items()), 1):
            h = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    h.update(chunk)
            if h.hexdigest() != sha:
                bad_hash.add(want.get(sha, sha))
            if n % 10000 == 0:
                print(f"  {n:,}/{len(blobs):,}", flush=True)
        problems |= show("CORRUPT ARTWORK", bad_hash)

    print(f"unique artworks on disk: {len(blobs):,}")
    if problems:
        print("\nFAILED - see above")
        sys.exit(1)
    print("\nOK - every id accounted for exactly once, every saved event has "
          "its metadata and artwork")


if __name__ == "__main__":
    main()
