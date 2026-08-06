# poap-saver

Save the metadata and artwork your POAP badges point at, before it disappears.

POAP shut down in August 2026. Every badge is a permanent ERC-721 token on
Gnosis Chain (a few were migrated to Ethereum mainnet), and the tokens are not
at risk. The problem is what they point at: each token's on-chain `tokenURI`
is a plain HTTP URL on `api.poap.tech`, and the artwork lives on
`assets.poap.xyz`. Neither is content-addressed, and the pointer baked into
the token cannot be changed — not by you, not by a migration to another chain,
not by anyone. When those hosts stop answering, every badge keeps proving you
were somewhere while losing every detail of where that was.

This tool saves that layer while the hosts still answer. It needs an address,
nothing more. It never asks for a wallet connection, because reading public
data requires no signature, and a tool like this must not train people to sign
things.

## In the browser

Open [`web/index.html`](web/) on any static host (or use the hosted copy at
[thebenmeadows.com/projects/poap-saver](https://thebenmeadows.com/projects/poap-saver/)).
Enter an address or ENS name. The page enumerates the badges over public RPC,
fetches each badge's metadata and artwork directly from POAP's hosts, records
a SHA-256 of every image as served, and downloads one zip: the archive plus a
gallery page that works offline from the unzipped folder.

Everything runs client-side. The page uploads nothing and has no server side.

## On the command line

Requires Python 3.9+. No dependencies. With [uv](https://docs.astral.sh/uv/)
or pipx, no install step either:

```
uvx --from git+https://github.com/mdws-org/poap-saver poap-saver rescue name.eth
pipx run --spec git+https://github.com/mdws-org/poap-saver poap-saver rescue name.eth
```

Or clone and run directly — the tool is a single file with no dependencies:

```
git clone https://github.com/mdws-org/poap-saver
cd poap-saver
./poap-saver rescue name.eth          # or a 0x address
```

`rescue` fetches everything and writes the gallery in one step. It is safe to
re-run: finished tokens are skipped, and a cached image is trusted only if its
recorded hash still verifies. If some fetches fail, run it again; only the
failures are retried. `poap-saver site <archive>` regenerates the gallery for
an existing archive — useful after the template improves — without touching
the network.

## The archive format

Both versions produce the same layout:

```
poap-archive-<addr>/
  index.html            gallery (self-contained; reads the files beside it)
  manifest.json         address, count, per-badge summary
  gnosis/<token-id>/
    metadata.json       as served by api.poap.tech, plus _archived_from/_ts
    image.<ext>         original bytes from assets.poap.xyz
    image.sha256        hash of those bytes as served
  eth/<token-id>/       same, for badges migrated to mainnet
```

The hash sidecars matter: they let anyone verify later that an archived image
is byte-identical to what POAP served while it was alive, without trusting the
person who archived it.

## The archive and its registry

The whole of POAP is archived, not just the badges people saved through the
tool: every event that existed when POAP shut down — 190,153 events, 174,498
unique artworks, all their metadata — crawled from POAP's own hosts in its
final days, verified byte-for-byte against the SHA-256 of every file as
served, and published to IPFS.

[`registry/corpus/`](registry/corpus/) is the permanent map. One row per
event: the artwork's SHA-256 as POAP served it, the artwork's IPFS CID, the
metadata's CID, and the original URLs. `gaps.jsonl` lists the 3,847 ids in
the 1–194,000 space that had nothing to save — recorded with their reason
while POAP still answered, which is the difference between an archive that is
missing something and an id that never existed. `summary.json` carries the
totals and two root CIDs that cover everything:

```
all artwork (~157 GB):  bafybeiedeqc3ycrt5elg3vp2ad2c4p6hpj6afnhysbzb4pi2rhxlhi5x3a
all metadata:           bafybeia7stlx5b3g7u2nv5lctjvkb7auo3x2l2t3grzuoffaxm66lau6ja
```

Anyone holding these registry files plus any copy of the blocks can rebuild
the entire archive, and verify it, without trusting whoever served the
blocks: a CID that does not match its content will not fetch.

## Pinning it yourself

This is the part that makes the archive outlive any single host. A CID only
one node can answer for is still one node away from gone; every additional
node that pins a badge is another place it survives.

Mirroring everything needs nothing but kubo and a running daemon — the two
root CIDs above are recursive pins, and re-running resumes an interrupted
transfer:

```
ipfs pin add bafybeiedeqc3ycrt5elg3vp2ad2c4p6hpj6afnhysbzb4pi2rhxlhi5x3a   # artwork, ~157 GB
ipfs pin add bafybeia7stlx5b3g7u2nv5lctjvkb7auo3x2l2t3grzuoffaxm66lau6ja   # metadata
```

For subsets, [`scripts/pin-mirror.py`](scripts/) reads the registry and pins
what you choose:

```
./scripts/pin-mirror.py                          # show what's available
./scripts/pin-mirror.py --archive poap-archive-you.eth/
                                                 # pin your own badges
./scripts/pin-mirror.py --events 4242,101250     # pin specific events
./scripts/pin-mirror.py --all                    # pin all ~157 GB
```

It needs kubo and nothing else. Content arrives over IPFS itself, so
integrity needs no separate check — your node rejects any block that does not
hash to its CID before storing it. Already-pinned objects are skipped, so an
interrupted run resumes where it stopped. `--archive` reads the badges out of
an archive the rescue tool produced, which makes the two-step "save my
badges, then make them permanent" flow:

```
./poap-saver rescue you.eth
./scripts/pin-mirror.py --archive poap-archive-you.eth
```

## The mirror

There is a read-only community mirror of POAP event artwork at
`poap-mirror.bemeadows.workers.dev` (an R2 bucket; the Worker is in
[`mirror/`](mirror/), MIT like the rest). It holds the events people saved
through the rescue tool while POAP's servers still answered.

Both the browser and the CLI use it only as a fallback: artwork is fetched
from POAP's own hosts, and the mirror is asked when POAP no longer answers
for an event. Nothing is ever sent to it. Pass `--no-mirror` on the command
line to skip the fallback and talk to POAP's hosts only.

While POAP's origin was alive, any rescue could grow the mirror through an
ingest endpoint that verified every image against POAP's own metadata before
storing it — proof only enforceable while that metadata API answered. Ingest
is retired: the reason to grow this bucket ended when the full corpus was
archived (see above), and the endpoint now answers `410 Gone`. What remains
is immutable — only what POAP itself served, filed under the event POAP said
it belonged to, each object carrying its SHA-256 as ingested.

Every object is also addressable by its IPFS CID:

```
curl -s https://poap-mirror.bemeadows.workers.dev/ipfs/<cid> | shasum -a 256
ipfs add --only-hash --cid-version=1 --offline -Q <the file you just saved>
```

Both should match the registry row for that event. This is a CID-addressed
mirror rather than a full IPFS gateway: it serves whole files, not the
individual blocks a verifying client would re-hash for itself, and it does not
join the DHT. What it gives you is content-addressed fetching and a way to
check the mirror against the registry without trusting either.

Everything in it is verifiable and copyable: [`registry/events.json`](registry/)
lists events with their SHA-256, size, source URL and IPFS CID, so anyone can
check an object byte-for-byte or pin the same content themselves without asking
anyone's permission.

The mirror also publishes that inventory live, so you never have to trust a
checked-in file to be current:

```
curl -s https://poap-mirror.bemeadows.workers.dev/events   # sizes, hashes, origins
curl -s https://poap-mirror.bemeadows.workers.dev/cids     # every CID it holds
```

Both are cursor-paginated: follow `cursor` while `truncated` is true.

The mirror's objects can also be pinned the legacy way —
`./scripts/pin-mirror.py --mirror` fetches each object over HTTP, re-hashes it
locally, and refuses any mismatch. The registry above supersedes this: it
covers five hundred times as many events, and IPFS transport makes the
integrity check inherent.

## What this cannot save

- **Badges held in POAP's email custody.** Badges claimed to an email address
  and never minted to a wallet lived only in POAP's database. The claim flow
  was retired with the collectors app; they are gone.
- **POAP Moments** (photos attached to drops). POAP-hosted only, no on-chain
  component, retired with the app.
- **Anything, once `api.poap.tech` and `assets.poap.xyz` stop answering.**
  Both still answer as of August 2026. Run this now, not later.

## Notes for the curious

- Enumeration is `balanceOf` / `tokenOfOwnerByIndex` / `tokenURI` against
  contract `0x22C1f6050E56d2876009903609a2cC3fEf83B415` — the same address on
  Gnosis and mainnet. No POAP API is involved.
- ENS resolution is done from scratch (namehash + registry + resolver), which
  is why both versions carry a small Keccak-256 implementation: Python's
  `sha3_256` is the FIPS variant with different padding and produces wrong
  hashes for this purpose.
- The CLI keeps one keep-alive connection per host and stays serial. POAP's
  CDN slow-walks sustained pulls that open a connection per request; reusing
  the connection is faster for you and lighter for them. Do not add
  concurrency to "fix" a slow rescue.
- The zip is store-only. Badge images are already compressed; deflate would
  add a dependency and save nothing.

## License

MIT.
