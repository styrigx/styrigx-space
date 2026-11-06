---
title: "Styrigx UI Auth Spec 2.0: Three Doors for Lock Screen, Owner, and Apps"
description: "Styrigx UI Auth Spec 2.0: three credential layers (root/owner/lock) each governing their own; passkeys in owner/lock/app classes; lock-screen entries adapt to configuration; two-step lock-screen reset; three entries on the Security page."
date: 2026-10-11
series: ["Styrigx UI Auth Spec"]
seriesOrder: 2
tags: ["Styrigx UI", "auth", "security", "Passkey", "Cloudflare"]
---

> This is the second edition of the "Styrigx UI Auth Spec" series. The previous edition is [Styrigx Key Specification Whitepaper v1.0](/post/2026-10-11-key-spec-whitepaper/) (Chinese only).

## 0. Summary

Styrigx consists of one main site (styrigx.com) and several sub-sites (blog, book, and future apps like music), sharing login state under `.styrigx.com`. This specification defines the naming, purpose, storage, issuance, and verification of all signing keys and passkeys across the site group, plus the complete auth flow from visitor entry to sensitive operations on sub-sites.

v1.0 isolated three credential types with three Ed25519 key pairs, but sensitive operations on sub-sites required a main-site step-up first, then an exchange for a sub-site pass — two nested layers. The main-site key governed security settings *and* sat in the issuance chain for APP passes, so one missing configuration could break two unrelated things at once. v2.0 redraws the model as **three non-nested trust domains**:

| Trust domain | Key | Analogy | Governs |
|---|---|---|---|
| Lock domain (LOCK) | `SGX_LOCK_*` | Phone fingerprint unlock | Unlock state across all three sites |
| App domain (APP) | `SGX_APP_*` | Logins on ordinary websites | Specific operations on sub-sites (book upload, delete, cover change) |
| Main-site domain (STEPUP) | `SGX_STEPUP_*` | "Verify identity before changing" in system settings | Only the main site's Security & Privacy core settings |

v2.0 (revised 2026-10-12) layers "who may manage the keys" on top of the three domains. Eight core principles:

1. **One key pair per purpose**, never reused across purposes.
2. **Only the main site issues**; sub-sites only hold public keys. The main-site key's public and private parts stay on the main site.
3. **Three trust domains do not nest**: APP verification does not depend on the main-site key, and the main-site key plays no role in issuing any sub-site credential.
4. **Three credential layers, each governing its own**:
   - **Root credential** (recovery): the last-resort recovery method, unused in daily life;
   - **Owner credential** (owner passkey / owner password): step-up for the "Manage credentials" entry;
   - **Lock credential** (lock passkey / lock-screen password): unlock only.
   Once a layer's own credential is configured, the root credential stops working for that layer — this is called "takeover".
5. **Passkeys in three classes**: owner (`owner`), lock (`lock`), and app (`app`) — registered and verified separately; the server rejects mixing in both directions.
6. **Missing configuration means rejection** (fail closed); nothing degrades into access.
7. **All credentials expire and are revocable**: the session epoch invalidates every credential at once; the app epoch invalidates one app's credentials independently.
8. **A recovery channel is an attack channel**: any in-site recovery requires two credentials (root plus owner — neither alone suffices); the final off-site recovery is independent of the site, temporarily enabled from the hosting platform account and expiring automatically. Principles only — if the platform account is compromised, nothing else matters.

## 1. Scope and Roles

| Role | Description |
|---|---|
| Main site (space) | The sole issuer; holds all private keys, the main-site public key, and the root credential; handles unlock, step-up, APP verification, passkey management, and root-credential recovery |
| Sub-site (blog, book, etc.) | Verifies only, never issues; holds only the public keys it needs |
| Owner | The only person who can manage security settings and perform sensitive operations |
| Visitor | Enters via human verification; can browse public content and some read-only pages; all sensitive operations are rejected |
| CI | Generates throwaway test key pairs on every run, written only to preview and test environments |

## 2. Threat Model

This specification defends against:

- **Credential forgery**: constructing a cookie that passes verification without the private key.
- **Credential privilege escalation**: using a low-privilege credential for high-privilege actions, e.g. a visitor session changing settings, an unlock session uploading directly, or book's pass being used on music.
- **Passkey mixing**: using an unlock passkey to approve sub-site operations, or vice versa.
- **Long-lived credentials**: old credentials remaining usable after device loss, cookie leak, or passkey deletion.
- **Sub-site compromise implicating the main site**: a leaked sub-site configuration or code letting an attacker issue credentials.
- **Missing configuration leading to access**: skipped variables at deploy time, or bypassing functions to serve static pages when platform quota is exhausted.
- **Redirect loops and open redirects**: auth redirects bouncing between sites, or the `return` parameter being abused to jump to external sites.
- **Brute force**: repeated password attempts.

Out of scope: the Cloudflare account itself being taken over, the owner's devices being fully compromised, browser zero-days, screenshots.

## 3. Naming

```
SGX_<PURPOSE>_PRIVATE   private key (PKCS8 PEM)
SGX_<PURPOSE>_PUBLIC    public key (SPKI PEM)
```

Local filenames are `<purpose>.key` and `<purpose>.pub`. Names express purpose, not algorithm; the algorithm is uniformly Ed25519.

Three fixed names: **lock key, APP key, main-site key**. "Step-up" remains only as the name of an action ("perform a step-up"), no longer referring to a key.

The root credential is not a signing key pair but a recovery secret held only in a main-site Secret (`SGX_ROOT_KEY`); the UI calls it "Root credential".

## 4. Three Signing Key Pairs

| Name | Variables | Issues | Lifetime | Private key on | Public key on | Governs |
|---|---|---|---|---|---|---|
| Lock key | `SGX_LOCK_PRIVATE` / `SGX_LOCK_PUBLIC` | `sgx-verified` | owner 12h, visitor 1h | main site | main site, all sub-sites | unlock state across three sites |
| APP key | `SGX_APP_PRIVATE` / `SGX_APP_PUBLIC` | `sgx-app` | 10 min | main site | sub-sites that need it (currently only book) | sensitive operations on sub-sites |
| Main-site key | `SGX_STEPUP_PRIVATE` / `SGX_STEPUP_PUBLIC` | `sgx-stepup` | 10 min | main site | main site | main-site Security & Privacy core settings |

### 4.1 Why Three Pairs, and Why Non-Nested

- **Leak isolation**: a problem with any one pair affects only its own purpose; rotation touches only that pair.
- **Cryptographic privilege separation**: the three credential types are signed with different private keys, so an `sgx-verified` cookie can never pass `sgx-app` or `sgx-stepup` verification. This doesn't depend on type checks in code being written correctly.
- **Failure isolation**: in v1.0, APP passes required an `sgx-stepup` first, so a missing main-site key broke sub-site uploads too. In v2.0, the main-site key only affects security settings; sub-site operations continue normally.
- **Minimal exposure**: the main-site public key exists only on the main site — sub-sites don't even know about it. The APP public key goes only to sub-sites that actually need it.

### 4.2 Credential Format

All credentials are dot-separated strings; the last segment is an Ed25519 signature (base64url) over everything before it:

```
sgx-verified = role.epoch.exp.sig
sgx-stepup   = by.scope.epoch.iat.exp.sig
sgx-app      = owner.epoch.appEpoch.iat.exp.aud.scope.sig
```

| Field | Meaning |
|---|---|
| `role` | `owner` or `visitor`; `sgx-stepup` and `sgx-app` are only issued to owner |
| `by` | what the `sgx-stepup` was issued on: `root` (root credential) or `owner` (owner credential) |
| `scope` | what the `sgx-stepup` is for: `root` (owner-credential management), `keys` (manage credentials), `lockreset` (lock-screen reset) |
| `epoch` | session epoch, see §8 |
| `appEpoch` | the app epoch for this `aud`, see §8 |
| `iat` / `exp` | issued-at and expiry (milliseconds) |
| `aud` / `scope` | which sub-site the pass is for and what kind of action, constrained by the main-site whitelist, e.g. `book` / `upload` |

The four-segment `sgx-verified` format is a cross-site contract: when the main site changes the format, every sub-site must update in the same change set. Each of the three repositories has a contract test guarding it — otherwise a sub-site would treat valid sessions as invalid and fall into redirect loops.

### 4.3 Cookie Attributes

| Cookie | Attributes |
|---|---|
| `sgx-verified` | `Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax` |
| `sgx-app` | `Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` |
| `sgx-stepup` | `Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict` |

`sgx-app` uses `Lax` rather than `Strict` because it must travel with the top-level navigation "main-site verification complete → back to sub-site". Forgery protection comes from the signature, `aud`, and the very short lifetime — not from SameSite. `sgx-stepup` is only used within the main site, so `Strict`.

## 5. Passkey Classification

Signing keys answer "who signed this credential"; passkeys (WebAuthn) answer "who approved issuance". The spec splits passkeys into three classes:

| Class | `class` | Used for | Can be exchanged for |
|---|---|---|---|
| Owner | `owner` | Step-up for the "Manage credentials" entry | `sgx-stepup` (`scope=keys`) |
| Lock | `lock` | Unlocking all three sites | `sgx-verified` (owner) |
| App | `app` | Approving sensitive operations on one sub-site, one key per app | that app's `sgx-app` |

### 5.1 Mandatory Rules

- Every credential record **must** store `class` server-side; app-class records **must** also store `aud`.
- Each class's auth challenges **must** list only that `class`'s credentials, and the server **must** re-check the class at verification. Rationale: the browser's credential picker is not a security boundary — filtering only on the frontend can be bypassed with a crafted request.
- APP auth challenges **must** list only `class=app` credentials whose `aud` equals the requested `aud`; the server re-checks as well. Book's key cannot open music.
- Authentication **must** require user verification (UV — biometrics or PIN); challenges are isolated per purpose, single-use, and expire after 5 minutes.
- **Passwords must never** be exchanged for `sgx-stepup` or `sgx-app`; passwords only unlock. The root credential may be exchanged for a scoped `sgx-stepup` (see 6.8) but **must never** be exchanged for `sgx-app`.
- **Lock-class passkeys must never** mint `sgx-stepup` — the lock key opens doors; it doesn't change settings.

### 5.2 Fixed Names at Registration

Password managers (e.g. Samsung Pass) display the username and display name written at registration, and changing them afterwards is painful. Registration parameters are therefore hardcoded — the user fills in nothing:

| Field | Owner class | Lock class | App class |
|---|---|---|---|
| `rp.id` | `styrigx.com` | `styrigx.com` | `styrigx.com` |
| `user.displayName` | `Sloan Gray` | `Sloan Gray` | `Sloan Gray` |
| `user.name` | `ownerkey` | `lockkey` | the app's `aud` lowercased plus `key`, e.g. `bookkey` |
| `user.id` | dedicated random value for the owner class | dedicated random value for the lock class | per-`aud` random value |

Distinct `user.id` values make password managers store them as separate entries — at a glance you can tell which key is for owner management, which unlocks, and which belongs to which app.

### 5.3 App Whitelist

The app list is a configuration on the main site (currently only `book`). Adding an app is one line: `aud`, allowed `scope`s, allowed `return` origin. Registering an `aud` not on the whitelist returns 400; at issuance, any `aud`, `scope`, or `return` not on the whitelist is rejected.

## 6. Complete Auth Flow

This section follows the user's actual journey, step by step, from opening a site to completing a sensitive operation.

### 6.1 Entry and Lock Screen

1. Visiting any site. Each request first passes through that site's middleware, which checks `sgx-verified`: signature, not expired, `epoch` not below the main site's current value.
2. No valid session:
   - Page requests redirect to the main-site lock screen `https://styrigx.com/?lock=1`, carrying the original URL as `return`;
   - API requests return `401` JSON — **never** 302. Rationale: frontend `fetch` silently follows 302s and receives a lock-screen HTML page, surfacing as a baffling "load failed".
3. The lock screen shows only an avatar. Tapping it opens options determined by the lock-credential configuration; "Visitor" is always first:
   - Both set → Visitor / Passkey / Password / Reset lock screen
   - Passkey only → Visitor / Passkey / Reset lock screen
   - Password only → Visitor / Password / Reset lock screen
   - Neither set → Visitor / Root credential (no reset entry)

   Configuration state comes from the server; read failures are treated as "configured" so the root-credential entry is never exposed.

### 6.2 Visitor Entry

1. Choose "Visitor" and complete Cloudflare Turnstile human verification.
2. The main site's `/api/verify` re-checks the result with Cloudflare, then issues `sgx-verified` with `role=visitor`, valid 1 hour.
3. Visitors can access: the desktop and apps, the blog, the book library's public content, Settings and its sub-pages, the Security & Privacy overview, My Files, and "Lock now" (current device only).
4. Visitors **cannot** access: owner-credential management, manage-credentials, locking all devices, or the corresponding management APIs. On the Security & Privacy page, visitors see the same three entries (Owner credential / Manage credentials / Lock now) with identical appearance, but the owner-credential and manage-credentials entries are decoys: whatever is submitted returns a generic failure message with no real verification.

### 6.3 Owner Unlock

1. Choose "Passkey": complete WebAuthn with a lock-class passkey. Or choose "Password": submit the lock-screen password.
2. On success the main site issues `sgx-verified` with `role=owner`, valid 12 hours; no further verification is needed on any of the three sites during that window.
3. Password verification **must** be rate-limited. Passkey unlock is not subject to the password rate limit — nobody can lock the owner out by burning through failure counts.
4. With neither lock credential configured, choose "Root credential": submit the root credential, exchange it for an owner session (1 hour), and enter owner mode. Once any lock credential is configured, this entry disappears.

### 6.4 Visitor In-Place Upgrade

1. On the Security & Privacy overview, owner-only entries show a lock icon.
2. When a visitor taps one, **no navigation happens** — an upgrade sheet opens in place, showing only "Passkey" and "Password", never the visitor entry.
3. After verification the main site swaps the current session for an owner session and the page enters the target setting directly.
4. A visitor opening an owner-only path directly, or returning to the homepage with `return=<owner-only path>`, **redirects at most once** and lands on the upgrade sheet. Rationale: "the exclusive page sends the visitor back home, and home sends a valid session back to the original path" forms a redirect loop — one side must terminate it.

### 6.5 Main-Site Security Settings (STEPUP)

The Security & Privacy page has exactly three entries: **Owner credential**, **Manage credentials**, and **Lock now**.

**Entry 1 — "Owner credential"**: manages owner-class passkeys and the owner password.

1. Requires a valid lock session (owner). Tapping it opens a prompt for the root credential.
2. After the root credential passes, the main site issues `sgx-stepup` (`by=root, scope=root`, 10 minutes) and enters owner-credential management.
3. Here you can add/remove owner passkeys and set or change the owner password. The owner password must not equal the lock-screen password.

**Entry 2 — "Manage credentials"**: manages lock credentials, app credentials, and sessions.

1. Requires a valid lock session (owner). Tapping it opens step-up verification; the buttons depend on the owner-credential configuration:
   - Nothing set → only "Root credential"
   - Passkey only → "Verify with passkey"
   - Password only → "Verify with password"
   - Both set → both buttons, no root credential
2. After the owner credential passes, the main site issues `sgx-stepup` (`by=owner, scope=keys`, 10 minutes) and enters management.
3. Here you can: add/remove lock-class passkeys, add/remove app-class passkeys, set the lock-screen password, view sessions, and lock all devices.
4. Once an owner credential is configured, the root credential stops working for the "Manage credentials" entry (takeover).

`sgx-stepup` has the format `by.scope.epoch.iat.exp.sig`, where `by` is `root` or `owner` and `scope` is `root`, `keys`, or `lockreset`. Endpoints check `scope`; mismatches are 403.

**Lock now**: an emergency button that only reduces privilege; no extra gate, available to visitors and owners alike.

Exceptions, each with its reason:

- **No exception for the first owner credential**: with no owner credential yet, the "Manage credentials" entry shows only "Root credential" — verify with the root credential.
- **Lock all devices**: inside the "Manage credentials" entry; an emergency button, no extra gate, visitors excluded.
- **The last owner unlock method cannot be deleted**: with no lock-screen password set, the final lock-class passkey cannot be removed.

### 6.6 Sub-Site Sensitive Operations (APP — book upload as example)

1. Before a book upload, deletion, or cover change with no valid `sgx-app`, book redirects to `https://styrigx.com/app-verify/?aud=book&scope=upload&return=<book URL>`.
2. The main site checks: owner session; `aud` and `scope` on the whitelist; `return`'s origin strictly equals the app's registered origin — otherwise rejected.
3. The main site performs WebAuthn with that `aud`'s app-class passkey, UV enforced. If the app has no app-class passkey yet, it prompts "first add book's key under Security & Privacy → Manage credentials" — no password option is offered.
4. On success the frontend calls `POST /api/app-token`. The endpoint requires `Origin: https://styrigx.com` and `Content-Type: application/json` (CSRF protection), signs `sgx-app` with the APP private key, writes the cookie, and returns to `return`. **No `sgx-stepup` is involved at any point.**
5. Book verifies with the APP public key, checking `role=owner`, `aud=book`, `scope`, not expired, and `epoch`/`appEpoch` not below the main site's current values — then performs the operation.
6. Large uploads: the pass is checked only when the upload task is created. The task is registered in book's database for 2 hours along with the `appEpoch` at issuance; subsequent chunks, completion, and cancellation need only an owner session plus a valid task ID, while the registered `appEpoch` is still current. Rationale: large files aren't interrupted by the 10-minute pass expiring, yet deleting the key immediately kills in-flight tasks.

### 6.7 Lock, Lock All Devices, and Multi-Tab Sync

| Action | Who | Effect |
|---|---|---|
| Lock now | owner, visitor | clears the session cookie on the current device only |
| Lock all devices | owner only | session epoch +1; all three credential types on all devices become invalid |

Multi-tab sync **must not** rely on BroadcastChannel, localStorage, or frontend memory. Each tab re-checks its session with the server on `visibilitychange`, `pageshow`, and `focus`. Rationale: tabs across subdomains share no reliable frontend channel — the server is the single source of truth.

### 6.8 Root Credential (Recovery)

The root credential is the last-resort recovery method, used to regain control when owner and lock credentials are both unavailable.

1. `POST /api/root-auth { key }`: POST only, Origin checked, constant-time comparison. Missing Origin returns 403; a wrong root credential returns 401.
2. On success it issues a scoped `sgx-stepup` (10 minutes) depending on context:
   - With a lock session → `by=root, scope=root`, for entering the "Owner credential" entry;
   - With no lock session and no lock credential configured → exchanged for an owner session (1 hour), entering owner mode.
3. The root credential **never** issues `sgx-app`; nor can it alone unlock, enter the "Manage credentials" entry, or reset the lock screen (see 6.9 for the recovery switch exception).
4. Failure rate limits: 5 consecutive failures from one IP lock it for 15 minutes; 20 failures site-wide within an hour pause verification for 1 hour; over the limit returns `429`. Any error reading or writing the counters is a rejection (`503`).
5. Every use (success, failure, or rate-limited) writes an audit record with only the time, IP prefix, and outcome, kept for 7 days. The audit list is viewable inside the "Manage credentials" entry.
6. A missing root credential or related private key means rejection (500 or 503).
7. After changing the root credential, redeploy the main site for it to take effect.

### 6.9 Resetting the Lock Screen

Used to recover when the lock credentials (passkey or password) are lost. The flow is fixed at two steps — neither alone suffices:

1. **Step 1 — root credential.** Submit the root credential at the lock screen's "Reset lock screen" entry. A wrong root credential returns a generic failure message revealing nothing about configuration.
2. **Step 2.** After the root credential passes, the server checks the recovery switch:
   - Recovery switch valid (temporarily enabled from the hosting platform, valid 24 hours, single use) → issues the `lockreset` ticket directly;
   - Otherwise → requires the owner credential (passkey and/or password buttons per configuration); on success issues the `lockreset` ticket.

   With no owner credential configured and an invalid recovery switch, reset is unavailable — a generic failure message, no reason given.

3. The `lockreset` ticket can only reset lock-screen passkeys and the lock-screen password: it **cannot** mint `sgx-verified`, **cannot** enter the main page, and **cannot** touch app credentials, sessions, or either management entry. Afterwards the session epoch advances, all old sessions die, and the owner unlocks normally with the new lock credentials.
4. The reset flow counts toward root-credential rate limiting throughout; every failure returns the same generic message — root wrong, switch invalid, or owner wrong are indistinguishable.

## 7. Storage and Configuration

### 7.1 Per-Site Variables

| Project | Variables |
|---|---|
| Main site | `SGX_LOCK_PRIVATE`, `SGX_APP_PRIVATE`, `SGX_STEPUP_PRIVATE`, `SGX_LOCK_PUBLIC`, `SGX_STEPUP_PUBLIC`, `SGX_APP_PUBLIC` (only for the `/api/diag-keys` self-check), `SGX_ROOT_KEY`, `SGX_PW_PEPPER`, `SGX_SITE=space` |
| blog | `SGX_LOCK_PUBLIC`, `SGX_SITE=blog` |
| book | `SGX_LOCK_PUBLIC`, `SGX_APP_PUBLIC`, `SGX_SITE=book` |
| Future sub-sites | `SGX_LOCK_PUBLIC`, `SGX_SITE`; add `SGX_APP_PUBLIC` and join the app whitelist when sensitive operations are needed |

### 7.2 Rules

- Private keys **must** be configured as Secrets. Public keys aren't secret — Text (visible in the console, easy to compare) or Secret both work; when a project's plaintext variables are managed by `wrangler.toml` and the console only allows adding Secrets, use Secret. Either way, public keys **must never** be committed to the repo or `wrangler.toml` — production has exactly one source of truth.
- Sub-sites **must not** contain any `*_PRIVATE`, any `SGX_STEPUP_*`, or `SGX_ROOT_KEY`; they hold public keys only. CI statically checks sub-site sources; any occurrence fails the build. A missing or wrong `SGX_SITE` fails closed: blog always redirects to the main-site lock screen, book always returns `500`.
- The main site's `/api/app-token` chain **must not** reference the main-site key or `SGX_ROOT_KEY`; `sgx-stepup` verification is only allowed in the `owner-passkey`, `owner-password`, and `stepup` endpoints. Enforced by static tests in CI.
- All three sites can compare lock public-key fingerprints (first 16 hex chars of SHA-256) via the main site's `/api/key-fingerprint` and each site's same-named endpoint — only the public-key hash is exposed.
- Keep a copy of each private key in a password manager, filed under "lock key / APP key / main-site key".
- Production and preview environments use completely separate keys; CI generates throwaway pairs every run.
- Every Pages project with functions **must** set over-quota behavior to **Fail closed**. Rationale: with Fail open, requests bypass functions and serve static assets directly once the free quota is exhausted — equivalent to bypassing the lock screen. All three projects (space, blog, book) are set to Fail closed.

Generation:

```
openssl genpkey -algorithm ed25519 -out <purpose>.key
openssl pkey -in <purpose>.key -pubout -out <purpose>.pub
```

## 8. Revocation: Session Epoch and App Epoch

The main site keeps two kinds of monotonically increasing integers in KV:

| Epoch | KV key | Incremented when | Invalidates |
|---|---|---|---|
| Session epoch | `session-epoch` | lock all devices, setting or changing the password, password deletion, deleting a lock-class passkey | all three credential types |
| App epoch | `app-epoch:<aud>` | deleting any app-class passkey for that app (advances only the app epoch, not the session epoch) | that app's `sgx-app` and in-flight upload tasks |

Why a separate app epoch instead of reusing the session epoch: deleting book's key should only invalidate book's passes — not lock every device. Per-app separation also keeps deleting book's key from affecting music's future passes.

Sub-sites fetch the latest values from the main site's `/api/session-epoch` (returns the session epoch plus each app epoch), cached in memory for 60 seconds — so revocation takes effect on sub-sites within 60 seconds at most. If the read fails with no cache, reject. If KV reads error, the endpoint returns `503` — never treated as 0, and never writes a smaller value.

## 9. Failure Behavior (fail closed)

| Situation | Behavior |
|---|---|
| Missing lock public key | pages go to lock screen, APIs 401, only whitelisted paths pass |
| Missing any private key | refuse to issue the corresponding credential, return 500, no downgrade |
| Missing APP public key | all sub-site sensitive operations 403 |
| Missing main-site public or private key | security settings 403 or 500 across the board, and root-credential recovery is refused (500); lock-screen unlock and APP verification unaffected |
| Missing `SGX_ROOT_KEY` | `/api/root-auth` returns 500 |
| KV error on root-credential rate-limit counters | 503, rejected |
| Sub-site `SGX_SITE` missing or wrong | blog redirects to lock screen, book returns 500 |
| Unauthenticated call to `/api/diag-keys` | 401 |
| Epoch unreachable with no cache | reject |
| KV read error | 503, no writes |
| Bad signature, expired, stale epoch, aud/scope mismatch, role not owner | reject |
| Passkey class or aud mismatch | reject |
| `return` not on whitelist | reject, no redirect |
| Platform quota exhausted | Fail closed, no static pages |

There is no "unconfigured means allow" switch anywhere, and tests never pass by way of allowing.

## 10. Rotation and Incident Response

**Planned rotation** (yearly recommended, or when devices or collaboration change):

1. Generate a new key pair.
2. Configure the new private and public keys on the corresponding projects.
3. Deploy the main site, then the sub-sites.
4. Increment the session epoch (or just the app epoch when rotating the APP key) to invalidate old credentials.
5. Re-unlock all devices, confirm everything works, then delete the old key from the password manager.

**Emergency rotation** (suspected private-key leak): run steps 1–4 immediately — rotate first, investigate after. Only rotate the affected pair; leave the other two alone.

**Lost passkey** (lost device): unlock with another device or the password → perform one step-up → delete the passkey on the lost device (deleting a lock-class key automatically advances the session epoch, so every device must unlock again; deleting an app-class key advances only that app's epoch). If every unlock method is lost, go through the lock-screen reset flow (see 6.9), then reconfigure the lock credentials.

**Root-credential rotation**: replace `SGX_ROOT_KEY` in the main-site Secret and redeploy the main site. Credentials already issued are unaffected; to invalidate them too, lock all devices afterwards.

## 11. Acceptance Criteria

Every change touching keys or auth **must** ship with CI-integrated functional tests. "It worked locally" doesn't count.

- Missing variables fail closed.
- Expired, epoch-changed, tampered, forged-signature, and visitor credentials are all rejected.
- Cross-purpose rejection: `sgx-verified` can't stand in for `sgx-app` or `sgx-stepup`; `sgx-stepup` can't stand in for `sgx-app`; aud/scope mismatches rejected.
- Passkey classification: each class's challenges list only that `class`; lock-class rejected at `/app-verify/`; app-class rejected at the lock screen; an `aud=book` credential rejected for `aud=music`; registering a non-whitelisted `aud` returns 400; lock-class passkeys cannot mint `sgx-stepup`.
- Decoupling: an app-class passkey can still mint `sgx-app` with no `sgx-stepup`; registering any passkey class without an owner session returns 401; adding/removing any class without `sgx-stepup` returns 403.
- Revocation: after deleting an app-class passkey, the old `sgx-app` returns 403 on the sub-site, and in-flight uploads are rejected.
- Root credential: correct → the matching scoped `sgx-stepup` or an owner session; wrong → 401 and counted; over the limit → 429; missing `SGX_ROOT_KEY` or `SGX_STEPUP_PRIVATE` → rejected; KV errors fail closed; every use writes an audit record; `/api/app-token` never references `SGX_ROOT_KEY`; missing Origin returns 403.
- Lock-screen reset: root credential → recovery switch or owner credential → `lockreset` ticket; the ticket can only reset lock credentials, never enter the main page; every failure returns the same generic message.
- Deleting an app-class passkey advances only `app-epoch:<aud>`, never the session epoch.
- Self-check: `/api/diag-keys` returns 401 when unauthenticated; matched pairs return true, mismatched false, missing "missing".
- Registration parameters: `user.displayName` is `Sloan Gray`; `user.name` is `ownerkey`, `lockkey`, and `<aud>key` (e.g. `bookkey`).
- Visitor scope: visitors can open Settings, the security overview, and My Files, and can lock now; owner-only paths redirect at most once and land on the upgrade sheet; owner-only APIs return 403 to visitors; the Security page shows visitors the same three entries as owners.
- Lock-screen entries: four states per lock-credential configuration; read failures are treated as configured and never expose the root-credential entry.
- Cross-site contract: an `sgx-verified` issued by the main site parses on every sub-site.
- Valid credentials pass; uploads complete after the pass expires.

The merge bar is a fully green production CI. Fix the implementation — **never** rewrite tests to accommodate it; visual-baseline changes can't substitute for functional assertions.

## 12. Implementation Roadmap

| Phase | Content | Status |
|---|---|---|
| 0 | Lock key (three-site unlock) live | Done |
| 1 | Unified rename to `SGX_<PURPOSE>_*` | Done |
| 2 | Session roles (owner / visitor) | Done |
| 3 | Main-site key: issuance, verification, wired into main-site sensitive operations | Done |
| 4 | APP key with book upload (v1.0 approach via main-site step-up) | Done, superseded by phase 6 |
| 5 | Visitor scope narrowing and in-place upgrade | Done |
| 6 | Three-domain split: passkey classification, independent APP verification, app epoch | Done (2.10.0) |
| 7 | CI key-distribution checks | Done (2.10.0) |
| 8 | Root credential as recovery credential, anonymous registration closed, key self-check `/api/diag-keys` | Done (2.10.1) |

## Appendix

### A. Glossary

- **Ed25519**: an elliptic-curve signature algorithm — short keys, fast verification, no extra parameters.
- **Passkey**: a WebAuthn passwordless credential; the private key stays on the device or in a password manager, the site keeps only the public key.
- **UV (User Verification)**: requiring the person's biometrics or PIN at authentication — not just "the device is present".
- **Fail closed**: refusing on error or missing configuration, rather than allowing.
- **Session epoch / app epoch**: monotonically increasing integers used to invalidate issued credentials in one shot.
- **aud / scope**: the pass's intended audience and purpose.
- **Turnstile**: Cloudflare's human verification; this site uses it only to issue visitor sessions.

### B. API Reference (Main Site)

| Endpoint | Purpose | Visitor |
|---|---|---|
| `/api/verify` | Turnstile re-check, issues visitor session | allowed |
| `/api/root-auth` | root credential (recovery): issues the matching scoped `sgx-stepup` or an owner session, never `sgx-app`; rate-limited on failure, every use audited | allowed (needs root credential) |
| `/api/root-session` | root credential exchanged for an owner session (no lock credential configured) | allowed (needs root credential) |\n| `/api/lockreset` | reset lock screen: root credential → recovery switch or owner credential → `lockreset` ticket | allowed (verified per flow) |\n| `/api/lock` | lock now (current device) | allowed |
| `/api/session-check` | multi-tab session re-check | allowed |
| `/api/session-epoch` | session epoch and app epochs | public |
| `/api/key-fingerprint` | lock public-key fingerprint | public |
| `/api/stepup` | owner-class passkey exchanged for `sgx-stepup` (`scope=keys`) | 403 |
| `/api/owner-password` | `verify` unlocks with the lock-screen password; `set`/`change`/`remove` manage it (needs `sgx-stepup`) | only `verify` allowed (for upgrade) |
| `/api/owner-passkey` | `auth` unlocks with a passkey; register, list, rename, delete by `class` (needs `sgx-stepup`) | only `challenge` and `auth` allowed (for upgrade) |
| `/api/lock-all-devices` | lock all devices | 403 |
| `/api/app-token` | app-class passkey exchanged for `sgx-app` | 403 |
| `/api/diag-keys` | key-pair self-check for all three pairs, returns only true / false / "missing" | 401 (owner session only) |

### C. Changelog

| Version | Date | Notes |
|---|---|---|
| v2.0 | 2026-10-11 (revised 2026-10-12) | Trust model changed to three non-nested domains; APP verification no longer goes through main-site step-up, and the main-site key only governs security settings with its key pair staying on the main site; passkeys split into lock and app classes, one key per app, server rejects mixing both ways; fixed naming for registration; new app epoch — deleting an app-class passkey invalidates that app's credentials; `sgx-app` format gains the app epoch, cookie changed to `SameSite=Lax` with rationale; public keys may be Text or Secret but never enter the repo; new complete auth flow (visitor entry, owner unlock, in-place upgrade, security settings, sub-site operations, lock sync); new Pages Fail-closed requirement, CI key-distribution checks, API reference; expanded acceptance criteria.<br><br>2026-10-12 revision (three credential layers): root credential (`SGX_ROOT_KEY`, recovery), owner credential (`owner`-class passkey / owner password), and lock credential (`lock`-class passkey / lock-screen password) — each governing its own layer, with the root credential auto-disabled for a layer once that layer is configured (takeover); passkeys in three classes (owner/lock/app), `user.name` fixed to `ownerkey` / `lockkey` / `<aud>key`, `user.displayName` fixed to `Sloan Gray`; lock-screen entries in four states per lock-credential configuration; Security & Privacy page reduced to three entries (Owner credential / Manage credentials / Lock now), visitors seeing identical appearance; `sgx-stepup` changed to `by.scope.epoch.iat.exp` format (`by=root|owner`, `scope=root|keys|lockreset`) with `scope` checked by endpoints; new lock-screen reset flow (root credential → recovery switch or owner credential → `lockreset` ticket, which can only reset lock credentials); root-credential rate limiting (5 failures from one IP lock 15 minutes, 20 site-wide failures per hour pause verification for 1 hour); password pepper; `/api/owner-auth` renamed to `/api/root-auth`. |
| v1.0 | 2026-10-11 | Initial: three Ed25519 key pairs, naming rules, issuance and verification flow, epoch revocation, fail closed, rotation. |

---

*Agents must read this document before starting any work involving auth or keys. Where it conflicts with the owner's ad-hoc instructions, the owner's latest written confirmation prevails.*
