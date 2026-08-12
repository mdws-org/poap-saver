# The POAP archive registry

Every POAP event that existed when POAP shut down in August 2026: 197,577
events, 181,554 unique artworks, and all their metadata, crawled from POAP's
own hosts in their final days and verified byte-for-byte against the SHA-256
of every file as served. The tokens are permanent; this is the layer they
point at, which was not.

## Mirror the whole archive

Two commands, with [kubo](https://docs.ipfs.tech/install/) installed and
`ipfs daemon` running:

```
ipfs pin add bafybeickz3h6wnxdwsxeoixj3pxk24fnczqeymuqh7h7xge7iaownd4b3i   # all artwork, ~194 GB
ipfs pin add bafybeiglmxn6ta7bt76p5ed6mnmek4m4uvmftonxjqe6zemp6j73qzwwuu   # all metadata, 145 MB
```

The earlier roots (`bafybeiedeqc3…` artwork, `bafybeia7stlx…` metadata) still
resolve; they are simply the archive before the 7,424 events recovered from
above id 194,000 were added. Pin the roots above.

Two derivative trees exist for anyone who wants the archive browsable, not
just intact. Both regenerate from the artwork, so they matter less than the
roots above - but a mirror that serves readers wants them:

```
ipfs pin add bafybeia3q5zqbjdhzdmdny3vzoc6gddjn4tsi22p6jd2lsx3rcm362gin4   # 400px thumbnails, 4.4 GB
ipfs pin add bafybeibwodt254seymig7cbemxwgj4e5lztui3ccz6ypboafyl5i2ptn4a   # animation re-encodes, 47 MB
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
- `gaps.jsonl` — the 42,423 ids in the 1–240,000 space that had nothing to
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
