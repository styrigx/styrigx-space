---
title: "The Owner Credential Becomes an Account: Dropping Stepup and App Credentials"
description: "From October 19 to 21, the owner credential grew from a settings page into a full account system; stepup and app credentials were deleted outright, signing keys went from four pairs to two, and the lock screen got a door of its own. Here is why."
date: 2026-10-21
series: ["Styrigx Auth Spec: How It Evolved"]
seriesOrder: 4
tags: ["Styrigx UI", "auth", "Security", "Passkey"]
---

> Part of the "Styrigx Auth Spec: How It Evolved" series, following Auth Becomes a Gateway. There is no written final design for this version; it is pieced together from patch notes and PRs of the time.

Once the gateway move was done, problems in the credential model itself came to the surface. Version 2.1 had left three layers of credentials (root, owner, lock), two doors, plus stepup tickets and app credentials. Each made sense on its own, but together they made a simple question hard to answer: **who exactly is the owner, and how do they prove it?**

## 1. The owner credential becomes an account (10-19)

The "owner credential" used to be just one page in security settings: a password and a few passkeys. It wasn't an account and had no session of its own; when needed, it was checked on the spot and a short ticket was signed.

This version made it a full account system:

- the account has its own sign-in page, settings page, session and API;
- three ways in: account passkey, account password, or the root credential; any one of them issues an account session;
- the account session uses its own cookie and lasts until you sign out;
- the old owner credential page was deleted, and credential management moved to "Security & privacy" on the account page.

This wasn't a rename. A rename would only have made the word "owner credential" disappear; after the upgrade, the owner had, for the first time, an identity that could stay signed in, see its own devices and manage its own keys.

## 2. Stepup and app credentials deleted outright (10-20)

In 2.0 and 2.1, sensitive actions needed a stepup ticket, and writes on subsites needed an APP ticket obtained with app credentials. Once there was an account session, both were redundant: if you're already signed in, signing another "I just verified" ticket is doing the same thing twice.

So this version deleted them completely:

- the `/api/stepup` and `/api/app-token` endpoints, along with the app credential pages, the allow-list generator and related CI;
- the stepup and APP signing key pairs.

Signing keys went from four pairs to two: one for account tickets, one for lock tickets. No compatibility layer.

There was actually another draft on the evening of 10-20: separate doors for lock credentials and app credentials, each with its own key. I changed my mind the same evening: delete app credentials entirely, no second door.

## 3. The lock screen gets its own door (10-20)

With stepup gone, sensitive lock-side actions like changing credentials or resetting still needed re-verification. So the lock screen got a door of its own:

- a 3-minute door ticket in two kinds, "lock" and "lock reset", bound to the session epoch and void as soon as the epoch changes;
- the lock entry accepts only the lock password, lock passkeys and the root credential; the guest option is hard-wired to fail on the server and reads no storage;
- lock reset: with the recovery switch on, the root credential alone is enough; otherwise it needs the root credential plus the account credential, and the reset ticket can only change the unlock password and add or remove lock passkeys.

The security page kept only the lock credentials and "lock now"; account credentials stayed on the account page. **The lock screen handles the lock, the account handles the account.** That boundary starts here.

## 4. One state machine (10-21)

Routing and sign-in state for the three sites went into one state machine: whether you're in, whether there's an account session, whether a door ticket is still valid, all derived in one place and shared by every site instead of each deciding on its own.

## 5. A detail after launch

The deleted `/api/stepup` returns 401 from outside, not 404. That isn't a missed deletion: the gateway answers 401 to any unauthenticated `/api/*` before routing, so it never reveals which endpoints exist.

## Why it changed again

The concepts were clearer, but the names were still a mess: owner, account and lock were used interchangeably, and guests still got in through a captcha, ending up with a session much like the owner's. The next version starts on those two.
