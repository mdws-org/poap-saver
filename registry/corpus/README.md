# The POAP archive registry

Every POAP event that existed when POAP shut down in August 2026: 190,153
events, 174,498 unique artworks, and all their metadata, crawled from POAP's
own hosts in their final days and verified byte-for-byte against the SHA-256
of every file as served. The tokens are permanent; this is the layer they
point at, which was not.

## Mirror the whole archive

Two commands, with [kubo](https://docs.ipfs.tech/install/) installed and
`ipfs daemon` running:

```
ipfs pin add bafybeiedeqc3ycrt5elg3vp2ad2c4p6hpj6afnhysbzb4pi2rhxlhi5x3a   # all artwork, ~157 GB
ipfs pin add bafybeia7stlx5b3g7u2nv5lctjvkb7auo3x2l2t3grzuoffaxm66lau6ja   # all metadata, ~1 GB
```

That is the entire archive. The transfer takes a while and is safe to
interrupt — re-running the same command resumes, because blocks already
fetched are skipped. Keep your daemon running afterwards: a pin on a node
that is offline preserves the content for you, but only an online node
serves it to everyone else.

To pin a subset instead — your own badges, or specific events — use
[`scripts/pin-mirror.py`](../../scripts/pin-mirror.py) from the repository
root:

```
./scripts/pin-mirror.py --archive poap-archive-you.eth/   # your own badges
./scripts/pin-mirror.py --events 4242,101250              # specific events
```

## What the files are

- `events-*.jsonl` — one row per archived event: the event id, the artwork's
  SHA-256 exactly as POAP served it, the artwork's CID, the metadata's CID,
  the size and content type, and the original `assets.poap.xyz` /
  `api.poap.tech` URLs. Sharded 10,000 event ids per file.
- `gaps.jsonl` — the 3,847 ids in the 1–194,000 space that had nothing to
  save, each with the reason observed while POAP still answered. This is what
  lets the archive claim completeness: an id is either in the registry or in
  here, never silently absent.
- `summary.json` — totals and the two root CIDs above.

## Trusting none of it

Nothing here asks for trust. A CID is the hash of its content, so whatever
node serves you a block, your own node verifies it before storing it. The
SHA-256 in each row is the hash of the artwork as POAP served it, so you can
check any object against what the origin was serving while it was alive:

```
ipfs cat <cid> | shasum -a 256    # matches the row's sha256
```

The registry files themselves live in this repository's history, signed and
forkable. Clone the repo and you hold the map; pin the roots and you hold
the territory.
