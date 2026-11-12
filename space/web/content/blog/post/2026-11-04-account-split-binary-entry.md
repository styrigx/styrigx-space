---
title: "Two Sets of Tickets: Splitting the Account, Permissions from the Account, and a Binary Door"
description: "October 30 to November 4: account auth moved into its own account Worker and the gateway only asks for verdicts; entering the site no longer distinguishes guest from owner, only in or out; every write is authorized by the account. \"The site owns the door, the account owns permissions\" was settled here."
date: 2026-11-04
series: ["Styrigx Auth Spec: How It Evolved"]
seriesOrder: 6
tags: ["Styrigx UI", "auth", "Security", "Cloudflare"]
---

> Part of the "Styrigx Auth Spec: How It Evolved" series, following The Site Goes Private. Based on the target plan of November 3 and its PR task list.

The previous version sorted out names and tickets, but two problems remained: account auth code still lived in the gateway, with account and lock data crowded into one Worker and one database; and downstream services (subsite APIs, search, chat) still decided whether you could write by looking at the gateway's role. This version's goal fits in one line: **the site owns the door, the account owns permissions, and root borrows from Linux.**

## 1. Splitting out the account (10-30 → 10-31)

Account auth moved entirely into its own account Worker:

- the account Worker has no public route; browsers can only reach the gateway;
- after checking the door, the gateway forwards account paths to the account Worker over a service binding, stripping any internal headers that came in from outside so nobody can forge them;
- the gateway asks for account-session verdicts through one dedicated interface; all account code, bindings and keys were removed from the gateway;
- account data moved out of the gateway's database with a migration script in four steps (dry-run, verify, reverse, clean up) and a single atomic cutover.

The boundaries between layers were written into checks too: CI rules say which Worker may call which and what each may not touch.

## 2. A binary door (11-04)

With the split done, the lock side could be simplified a lot. One principle: **entry is either "in" or "not in".**

- lock sessions no longer distinguish guest and owner; a valid one means you're in;
- the role field, the role header and "owner only" checks were all deleted;
- the field recording how a session was obtained (password, passkey, temporary key) is for auditing only and is never a reason to allow or block. Roles were retired; that field must not become a new role;
- what the lock side used to call its root credential was renamed "space": it is the root credential for entering the site, and the word root was left to the account;
- creating and revoking temporary keys and share links now requires re-verifying the lock credential.

Being in lets you look. It isn't authorization.

## 3. Permissions come from the account (11-04)

Whether you can write or touch back-end data is always answered by the account:

- the account keeps a scope table: Curio writes, Daymark writes, preference sync, avatar writes and so on;
- the gateway passes the account's verdict downstream, and subsite APIs, search and chat trust only that verdict;
- the dependency flipped: the account used to look at the lock session; now the gateway asks the account for a verdict, and Workers trust only what the gateway passes on;
- lock and account don't reach into each other: "lock now" and "lock all devices" clear only entry sessions, never the account session, and signing out of the account doesn't touch the lock.

Search has two tiers: with an account session it covers every page, private ones included; without one, only public content. Signing in isn't required; it just widens the search when present.

## 4. Root borrows from Linux

This version stated for the first time that root is an account and user concept, borrowed from the Linux superuser; the lock is neither an account nor a user and needs no root. Apps get minimal scopes, and sensitive actions re-verify sudo-style, each side reusing its own short reauth ticket.

At the time this was a direction. Making root, users and groups one coherent system had to wait for v6.

## 5. Two sets of tickets

By this version the site effectively had two sets of tickets that never nest:

| | Entry (the site's door) | Account (permissions) |
|---|---|---|
| Question answered | Can you come in and look | Can you write, can you see private content |
| Credentials | Lock password / passkey, temporary key | Account password / passkey |
| Issued by | Gateway | Account Worker |

I later called this split the V3 principle; Account & Site Entry V3 a few days later is the version that finalized and shipped it.

## Why it changed again

The whole look switched to a terminal style soon after, and the account's keys still overlapped: the recovery key could both reset and reauth, and a single verification sometimes issued two tickets at once. The next post is about splitting the account's keys.
