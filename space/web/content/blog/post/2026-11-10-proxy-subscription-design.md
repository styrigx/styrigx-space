---
title: "Proxy Subscriptions: Two Keys, One On-Device Decrypt, and One Link per Source"
description: "Handing my proxy subscriptions and hand-written nodes to my own Worker: the download path is age-encrypted and the Worker only holds the public key; links and nodes in the database are sealed with a second key. P0 benchmarks ruled out typage in favor of a minimal age implementation, CMFA decrypted it on a real phone, and the design moved from one merged file to one link per source."
date: 2026-11-10
tags: ["Cloudflare", "Mihomo", "age", "Workers"]
---

CMFA (Clash Meta for Android) on my phone has always held my proxy subscription URLs directly. A subscription URL is a key: whoever has it can spend my traffic, and it ends up scattered across config files, backups and screenshots. The goal this time was simple: only my own Worker keeps the subscription URLs, and the phone pulls a node file that **only it can open**.

The design went through seven drafts. Not much survived, but every piece that did has a reason.

## Two keys

| Key | Where | Protects | Direction |
|---|---|---|---|
| age private / public key | Private key only in CMFA on the phone; public key in the database | The node files the phone downloads | One-way: the Worker can lock, never unlock |
| Database key (AES-256-GCM) | Cloudflare Secrets Store, bound to this one Worker | Subscription URLs and per-source nodes at rest | Two-way: the Worker must unlock URLs to fetch them |

The first key is the point. Since 1.19.27, mihomo supports `age-secret-key`: if a provider download is age ASCII armor, the core decrypts it with that private key. So the Worker only needs the phone's **public** key. Even if the Worker, the database and the download link all leaked at once, all anyone gets is ciphertext.

Where the private key is born is settled too: CMFA's "Meta features › Age key" generates an X25519 key pair on the phone. The private key never leaves the device, and no computer is involved.

The second key covers the raw material: subscription URLs and the last good nodes. The Worker has to read them (or it can't refresh on schedule), so it's symmetric encryption with a random IV per value and associated data bound to the row id and field name, so ciphertext moved to another row won't open.

## P0: measure CPU before writing code

The Cloudflare free plan caps CPU at 10 ms per invocation. Encryption runs in the Worker, so first I needed to know whether it fits.

Round one used typage, the TypeScript age implementation: 9 ms median for 200 nodes, 31 ms for 5,000, post-quantum (ML-KEM-768 hybrid) slower still, and 137 KB of bundle. Over budget.

So I wrote a minimal implementation: encrypt only, X25519 recipients only, armor output only. X25519, HKDF and HMAC via WebCrypto; ChaCha20-Poly1305 via `node:crypto` (with `nodejs_compat`). 6.7 KB, 2.2 ms median for 200 nodes, 4.3 ms for 1,000. typage decrypts its output, including the edge lengths (0, 1, 65535, 65536, 65537 bytes).

Passing in the cloud wasn't enough. On the phone: a config with three fake nodes (`192.0.2.x`), encrypted to a test public key, imported straight into CMFA. All three nodes showed up on the proxy page, and the log had no `decrypt config error`. Only then was P0 done.

What went into the design: accept `age1…` (X25519) only, keep post-quantum off for now, cap each source at about 1,000 nodes.

## From one merged file to one link per source

The first design merged every source into a single provider and prefixed node names with `[source]`. Right after the device test, the problem was obvious: my proxy groups are already split by provider — one group uses A, another uses B and C, and the per-region speed-test groups only draw from A. With one merged file, every group would need a prefix filter. Saving two subscription lines isn't worth a pile of filters.

So now there's one link per source: the same token, path `/s/<token>/<source>`, each source encrypted on its own. The phone config keeps one provider per source and `use:` doesn't change at all; only the URLs point at my Worker. The Worker gets cheaper too: no cross-source merge, prefixes or dedupe, and one broken source doesn't hold the others back.

## Refresh and download

- A scheduled refresh every 6 hours, plus an automatic one after adding a source, changing a URL, toggling, or swapping the public key.
- Refresh takes a lock first (one conditional UPDATE, 60-second expiry), and output is written only if it's newer *and* the lock is still ours, so overlapping refreshes never clobber each other.
- Fetching a provider: 15-second timeout, 2 MB cap, https only, and only `proxies:` is kept — the provider's own rules and groups are dropped. On failure it records an error category (never content) and keeps the last good nodes.
- Parsing YAML costs more than encrypting: 1,000 nodes take 7.7 ms to parse locally. So each source refreshes in its own service-binding call, with its own CPU budget.
- Download: only a SHA-256 of the token is stored, compared in constant time. Wrong token, disabled source, or no output yet — all 404, no redirect, no caching. WAF rate limiting sits in front, and the Worker has its own limit behind it.
- There is no management or refresh endpoint on the public internet. Management goes through the account page only: requests are forwarded after the session checks out, and swapping the key or minting a download link asks for re-authentication.

## Not done yet

The backend (P1) is up as a PR. Next come the `sub-*` terminal commands and a settings page on the account side, built after the screenshots are signed off. Real node counts will set the per-source CPU, so the caps get tuned from logs after launch.

Every time a big feature's design is finalized, I'll write it up like this: why it's built this way is worth keeping more than what was built.
