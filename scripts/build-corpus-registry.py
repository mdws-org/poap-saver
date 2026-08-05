#!/usr/bin/env python3
"""Turn a finished corpus crawl into the registry that outlives it.

The crawl leaves three kinds of truth on disk: per-worker index logs saying
which event has which artwork (by SHA-256), the artwork itself, and miss logs
for ids that had nothing to save. `ipfs add --nocopy` then assigns every file
a CID. This joins the two: one registry row per archived event, carrying the
event id, the SHA-256 of the artwork as POAP served it, the artwork CID, the
metadata CID, and the original URLs.

The registry is the part that must outlive every host. A CID is useless if
nobody knows it belongs to event 4,242; these files are that knowledge, small
enough to live in a git repo forever and complete enough that anyone holding
them plus any copy of the blocks can rebuild the whole archive.

Gaps are recorded too. "Event 178,001 was a metadata 404 while POAP was still
alive" is the difference between an archive that is missing something and an
id that never existed; without it, completeness can never be claimed again.

Usage (after crawl + ipfs add, on the machine holding the corpus):
    ipfs add -r -q ... see runbook ... > add-blob.log; same for meta
    ./build-corpus-registry.py --corpus D:\\poap-corpus \\
        --blob-log add-blob.log --meta-log add-meta.log --out registry-out
"""
import argparse
import json
import os
import re
import sys

SHARD = 10000  # events per registry file: ~20 files, each a few MB

# `ipfs add` reports one line per object: "added <cid> <name>"
ADDED = re.compile(r"^added\s+(\S+)\s+(.+)$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def parse_add_log(path, root_name):
    """Map file stem -> CID from an `ipfs add -r` transcript.

    Directory lines (including the root) carry no file extension and are
    collected separately: the root's CID is the single handle that pins the
    entire tree.
    """
    stems, root = {}, None
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = ADDED.match(line.strip())
            if not m:
                continue
            cid, name = m.group(1), m.group(2).replace("\\", "/")
            if name == root_name:
                root = cid
                continue
            base = os.path.basename(name)
            stem, ext = os.path.splitext(base)
            if ext:  # files have extensions; intermediate dirs do not
                stems[stem] = cid
    if root is None:
        raise SystemExit(f"{path}: no root line 'added <cid> {root_name}' - "
                         f"was the add interrupted?")
    return stems, root


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:  # noqa: BLE001 - a torn last line is fine
                continue


def logs(corpus, prefix):
    return [os.path.join(corpus, f) for f in sorted(os.listdir(corpus))
            if f.startswith(prefix) and f.endswith(".jsonl")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--blob-log", required=True,
                    help="stdout of `ipfs add -r --nocopy` over blob/")
    ap.add_argument("--meta-log", required=True,
                    help="stdout of `ipfs add -r --nocopy` over meta/")
    ap.add_argument("--out", required=True,
                    help="directory to write the registry into")
    args = ap.parse_args()

    sha_cid, blob_root = parse_add_log(args.blob_log, "blob")
    meta_cid, meta_root = parse_add_log(args.meta_log, "meta")
    bad = [s for s in sha_cid if not HEX64.match(s)]
    if bad:
        raise SystemExit(f"blob log contains non-sha names: {bad[:3]}")

    events, gaps = {}, {}
    for p in logs(args.corpus, "index"):
        for r in read_jsonl(p):
            events[int(r["event"])] = r
    for p in logs(args.corpus, "misses"):
        for r in read_jsonl(p):
            eid = int(r["event"])
            if eid not in events:  # a later refetch beats an earlier miss
                gaps[eid] = r.get("why", "unknown")

    # Every archived event must resolve to both CIDs. A miss here means the
    # add pass and the crawl disagree about what exists - stop, don't publish.
    no_blob = [e for e, r in events.items() if r["sha256"] not in sha_cid]
    no_meta = [e for e in events if str(e) not in meta_cid]
    if no_blob or no_meta:
        raise SystemExit(f"unpublishable: {len(no_blob)} events without an "
                         f"artwork CID {no_blob[:5]}, {len(no_meta)} without "
                         f"a metadata CID {no_meta[:5]}")

    os.makedirs(args.out, exist_ok=True)
    shards = {}
    for eid in sorted(events):
        shards.setdefault(eid // SHARD, []).append(eid)

    for shard, ids in sorted(shards.items()):
        lo, hi = shard * SHARD, shard * SHARD + SHARD - 1
        path = os.path.join(args.out, f"events-{lo:06d}-{hi:06d}.jsonl")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            for eid in ids:
                r = events[eid]
                f.write(json.dumps({
                    "event": eid,
                    "sha256": r["sha256"],
                    "cid": sha_cid[r["sha256"]],
                    "meta_cid": meta_cid[str(eid)],
                    "bytes": r["bytes"],
                    "content_type": r.get("content_type", ""),
                    "image_url": r.get("image_url", ""),
                    "token_uri": r.get("token_uri", ""),
                }, sort_keys=True) + "\n")

    with open(os.path.join(args.out, "gaps.jsonl"), "w",
              encoding="utf-8", newline="\n") as f:
        for eid in sorted(gaps):
            f.write(json.dumps({"event": eid, "why": gaps[eid]},
                               sort_keys=True) + "\n")

    unique_cids = set(sha_cid.values())
    summary = {
        "events": len(events),
        "gaps": len(gaps),
        "span": [min(events), max(gaps | events.keys())],
        "unique_artworks": len(unique_cids),
        "artwork_bytes": sum(int(r["bytes"]) for r in events.values()),
        "blob_root_cid": blob_root,
        "meta_root_cid": meta_root,
        "cid_profile": "cid-version 1, raw leaves, 256 KiB chunks "
                       "(kubo defaults for --cid-version=1)",
    }
    with open(os.path.join(args.out, "summary.json"), "w",
              encoding="utf-8", newline="\n") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
        f.write("\n")

    print(f"{len(events):,} events -> {len(shards)} shard files, "
          f"{len(gaps):,} gaps, {len(unique_cids):,} unique artwork CIDs")
    print(f"blob root: {blob_root}")
    print(f"meta root: {meta_root}")


if __name__ == "__main__":
    sys.exit(main())
