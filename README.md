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

## The mirror

The tool reads from and contributes to a community mirror of POAP event
artwork at `poap-mirror.bemeadows.workers.dev` (an R2 bucket; the Worker is in
[`mirror/`](mirror/)). The mirror never accepts uploaded bytes: an ingest
request names an event, the Worker fetches that event's artwork from POAP's
own origin, hashes what it received, and stores it immutably with the hash and
source URL. So the mirror can only contain what POAP actually served, and
every rescue that runs while POAP's hosts answer extends what survives after
they stop. When the origin dies, the mirror locks read-only. If the mirror is
unreachable, the tool falls back to POAP directly — it is an availability
layer, never a requirement.

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
