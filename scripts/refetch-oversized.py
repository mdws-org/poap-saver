#!/usr/bin/env python3
"""Fetch the artwork the corpus crawl skipped for being too large.

The crawler caps images at 64 MB so one pathological file cannot fill a disk
mid-run, and records what it skipped. A handful of POAP events point at files
far above that — mostly long GIFs, one of them 220 MB. They are still badge
artwork, and there are few enough of them to fetch deliberately once the crawl
is done and the disk cost is known.

Run this after the crawl finishes, not during it: --prune-misses rewrites the
miss logs, and a worker appending to one at the same moment would lose rows.

Usage:
    ./refetch-oversized.py --out D:\\poap-corpus --list
    ./refetch-oversized.py --out D:\\poap-corpus
    ./refetch-oversized.py --out D:\\poap-corpus --prune-misses
"""
import argparse
import hashlib
import importlib.util
import json
import os
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
MARKER = "image too large"


def _crawler():
    """Reuse the crawler's own HTTP and disk primitives rather than restate them."""
    path = os.path.join(HERE, "crawl-corpus.py")
    spec = importlib.util.spec_from_file_location("crawl_corpus", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CC = _crawler()


def miss_files(out):
    return [os.path.join(out, f) for f in sorted(os.listdir(out))
            if f.startswith("misses") and f.endswith(".jsonl")]


def oversized(out):
    """Every event skipped for size, newest row per event winning."""
    found = {}
    for p in miss_files(out):
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:  # noqa: BLE001 - a torn last line is fine
                    continue
                if str(row.get("why", "")).startswith(MARKER):
                    found[int(row["event"])] = row
    return [found[k] for k in sorted(found)]


def prune(out, done_ids):
    """Drop the size-skip rows for events now archived, leaving the rest intact."""
    for p in miss_files(out):
        with open(p, encoding="utf-8") as f:
            lines = f.readlines()
        keep = []
        for line in lines:
            s = line.strip()
            if s:
                try:
                    row = json.loads(s)
                    if (str(row.get("why", "")).startswith(MARKER)
                            and int(row["event"]) in done_ids):
                        continue
                except Exception:  # noqa: BLE001 - keep anything unparseable
                    pass
            keep.append(line)
        if len(keep) != len(lines):
            CC.write_atomic(p, "".join(keep).encode("utf-8"))
            print(f"  pruned {len(lines) - len(keep)} row(s) from "
                  f"{os.path.basename(p)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="the corpus directory")
    ap.add_argument("--max-bytes", type=int, default=512 * 1024 * 1024,
                    help="refuse anything above this (default 512 MB)")
    ap.add_argument("--list", action="store_true",
                    help="show what was skipped and exit")
    ap.add_argument("--prune-misses", action="store_true",
                    help="remove the size-skip rows for events now archived; "
                         "only safe once the crawl has finished")
    args = ap.parse_args()

    rows = oversized(args.out)
    if not rows:
        print("nothing was skipped for size")
        return
    total = 0
    for r in rows:
        n = int(str(r["why"]).split("(")[1].split()[0])
        total += n
        if args.list:
            print(f"  event {r['event']:>7}  {n / 1e6:8.1f} MB  {r['image_url']}")
    print(f"{len(rows)} event(s) skipped for size, {total / 1e9:.2f} GB total")
    if args.list:
        return
    if total > CC.free_bytes(args.out) - CC.MIN_FREE_BYTES:
        raise SystemExit("not enough free space to fetch these safely")

    idx = os.path.join(args.out, "index-oversized.jsonl")
    hosts, saved, failed = {}, set(), 0
    for r in rows:
        eid, url = int(r["event"]), r["image_url"]
        host, path = CC.image_target(url)
        if not host:
            print(f"  event {eid}: unusable url {url}")
            failed += 1
            continue
        if host not in hosts:
            hosts[host] = CC.Host(host)
        st, hdrs, blob = hosts[host].get(path)
        if st != 200 or not blob:
            print(f"  event {eid}: image {st}")
            failed += 1
            continue
        if len(blob) > args.max_bytes:
            print(f"  event {eid}: {len(blob) / 1e6:.1f} MB is over "
                  f"--max-bytes; skipping")
            failed += 1
            continue

        sha = hashlib.sha256(blob).hexdigest()
        ctype = (hdrs.get("content-type") or "").split(";")[0].strip().lower()
        ext = (CC.EXT.get(ctype)
               or os.path.splitext(urllib.parse.urlparse(url).path)[1][:6]
               or ".bin")
        blob_path = os.path.join(args.out, "blob", sha[:2], sha + ext)
        if not os.path.exists(blob_path):
            CC.write_atomic(blob_path, blob)
        CC.append(idx, {"event": eid, "sha256": sha, "bytes": len(blob),
                        "content_type": ctype, "image_url": url,
                        "token_uri": f"https://{CC.API}/metadata/{eid}/1"})
        saved.add(eid)
        print(f"  event {eid}: {len(blob) / 1e6:.1f} MB  {sha[:16]}...")

    for h in hosts.values():
        h.close()
    print(f"\nfetched {len(saved)}, failed {failed}")

    if args.prune_misses and saved:
        prune(args.out, saved)
    elif saved:
        print("miss rows left in place; rerun with --prune-misses to clear "
              "them once you are sure the crawl has finished")

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
