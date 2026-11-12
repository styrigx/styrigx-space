---
title: "The Site Goes Private: Temporary Keys Replace the Captcha, Six Tickets in One Table"
description: "October 23 to 28: guests no longer get in through a captcha but with a temporary key the owner issues; key names unify as AccountKey, LockKey and RootKey; every ticket goes into one table, and auth state moves from KV to D1. Here is why."
date: 2026-10-24
series: ["Styrigx Auth Spec: How It Evolved"]
seriesOrder: 5
tags: ["Styrigx UI", "auth", "Security", "Cloudflare"]
---

> Part of the "Styrigx Auth Spec: How It Evolved" series, following The Owner Credential Becomes an Account. There is no written final design for this version; it is pieced together from patch notes, task briefs and PRs of the time.

The previous version made the owner credential an account but left two things open: guests still got in through a captcha and ended up with a session not much different from the owner's, and owner, account and lock were still used interchangeably. This week fixed both, and reworked the whole set of tickets and storage along the way.

## 1. Unified key names (10-23)

First the names users can see. Each kind of credential got one word:

- **AccountKey**: the account password and passkeys;
- **LockKey**: the lock-screen password and passkeys used to enter the site;
- **RootKey**: the root credential, for recovery only.

WebAuthn user names and password-manager entries follow these three names, so they're easy to tell apart in the phone's key manager. Internal names such as endpoints and cookies were left for the layered rename later.

## 2. The site goes private: temporary keys (10-24)

The biggest change of this version. Guests no longer pass a third-party captcha; instead they use **a temporary key the owner issues**:

- the key is a 12-character code like `XXXX-XXXX-XXXX`, case-insensitive, with look-alike characters (O and 0, I and 1) normalized;
- it lasts 1–24 hours, or 3, 7, 15 or 30 days; it can be named, up to 20 can exist at once, and any can be revoked;
- the server stores only a hash, and the code is shown once, at creation;
- a guest who enters with a key gets a session tied to that key: once the key expires or is revoked, the next request counts as signed out;
- a wrong code always gets the same "invalid or expired" message, and 5 misses from one IP lock it for 15 minutes.

Every guest session issued through the captcha became invalid on launch day. The captcha endpoint, script, config and tests were deleted.

Why? A captcha only proves "you're not a robot", not "you're someone I'm willing to let in". This is a personal space; a guest should be someone I know and handed a key to. When the key expires, access goes away by itself.

Share links came the same day: a time-limited link that issues its own key, so opening it gets you in without copying a 12-character code by hand.

## 3. Six tickets in one table (10-25)

With the names unified, the internals had to follow. The rename went in three layers, one PR and one deploy each, moving on only when fully green:

1. **Endpoints and core files**: `owner-password` became `lock-password`, `session-check` became `lock-session-check`, and so on. The endpoints called "owner" had only ever handled the lock, and now the names said so.
2. **Tickets and roles**: every ticket went into one table, one row each for ticket name, cookie, signing key, lifetime, cookie attributes, allowed verification methods and epoch. The six tickets are lock session, lock reset, lock reauth, account session, account reset and account reauth. The signed string carries the cookie name as a prefix, so tickets signed by the same key can't pose as each other. The role "owner" became "admin".
3. **KV key names**: unified with full `lock-`, `account-` and `root-` prefixes, with a one-time migration script: dry-run first, then write new keys and verify each, then delete the old ones.

One more rule came with it: **RootKey signs no session.** It only trades for a 3-minute reauth or reset ticket, used to set new credentials, after which you sign in normally. The root credential is for emergencies, not another way to sign in day to day.

After deploying, everyone's old cookies were invalid. That was intended: no compatibility layer.

## 4. Security audit (10-25 → 10-26)

Alongside the rename came an audit, landed over several PRs:

- open redirects: `return` only accepts on-site paths;
- a global rate limit on RootKey, and escalating cooldowns on the lock password;
- missing environment config now closes the door instead of opening it;
- the lock epoch must match exactly;
- CI gates and least privilege; the passkey end-to-end tests started actually running from here;
- security headers: HSTS, CSP, X-Frame-Options, Permissions-Policy and more.

## 5. Auth state moves to D1 (10-28)

The last step was storage. Auth state used to live in KV, which is eventually consistent: tap "lock all devices" on one device, and another might not notice for a while.

This version moved all of it to D1: the epoch is read from the primary every time, challenges are consumed once with `DELETE … RETURNING` so they can't be used twice, and "lock all devices" takes effect immediately.

## Why it changed again

Names and tickets were in order, but the account auth code still lived in the gateway, and account data shared a Worker and a database with lock data. The next step was splitting the account out.
