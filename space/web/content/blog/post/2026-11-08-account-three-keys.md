---
title: "Three Account Keys: One Verification, One Ticket"
description: "November 8: the lock screen became a terminal with command unlock; on the account side, the catch-all AccountKey split into three keys (password, passkey, recovery key), three entries each sign their own ticket, and the recovery key can no longer sign in. Each feature its own job, each session its own life."
date: 2026-11-08
series: ["Styrigx Auth Spec: How It Evolved"]
seriesOrder: 7
tags: ["Styrigx UI", "auth", "Security", "Passkey"]
---

> Part of the "Styrigx Auth Spec: How It Evolved" series, following Two Sets of Tickets. Based on the account naming v2 plan settled that day.

Two things happened on November 8: in the morning the lock screen got a new look, and in the evening the account's keys were redrawn. One is interface, the other is model, but both answer the same question: **for a given action, which key are you using, and which ticket do you get?**

## 1. The lock screen becomes a terminal (morning)

With the whole site moving to a terminal style, the lock screen followed:

- the lock screen is a terminal; unlocking, temporary keys and resets are all commands;
- the "choose how to unlock" sheet and the verification dialogs were removed;
- the boot animation moved to play after unlocking.

The credential model didn't change here; the interaction did. Instead of tapping buttons to pick a method, you type a command. That paved the way for "one terminal for every identity action" later.

## 2. AccountKey was too broad

The AccountKey unified a little earlier actually wrapped three things: the account password, account passkeys, and the root credential used for recovery. The name was unified, but the uses crossed over:

- the recovery key could both reset the account and reauth;
- a sign-in that asked to "reauth too" issued a session ticket and a reauth ticket at once;
- when signed in without a reauth ticket, a reset ticket could stand in for one to change the password;
- signing out also cleared the reset ticket; the three tickets shared one epoch, so events on one decided whether another lived;
- sign-in, reauth and adding a key all used the same kind of passkey challenge, so one signed for one entry could be used at another.

None of these is big on its own. Together they meant you couldn't easily say what permissions you held at a given moment, or how you got them.

## 3. Three keys, three entries

The rule for this version was mine, set that day: **each feature does its own job, each session lives its own life.**

The keys split into three, each with its own name, stored under those names in the password manager:

- **account password** and **account passkey**: for signing in and reauth;
- **recovery key** (RecoveryKey, the former root credential): for reset only; it **cannot sign in and cannot reauth**.

The entries split into three too, each signing only one kind of ticket:

| Command | Uses | Signs |
|---|---|---|
| `sudo root` | Account password or passkey | A session only |
| `sudo root reauth` | Account password or passkey, with a session | Only a 3-minute reauth ticket, bound to this device's session |
| `sudo root reset` | Recovery key | Only a 3-minute reset ticket, no session |

Alongside:

- the reauth ticket carries a device marker and is only valid while the same device's session is, so it reads plainly as "a 3-minute elevation of one session";
- ending a session clears its reauth; ending reauth clears only reauth; ending reset clears only reset, with no knock-on effects;
- passkey challenges are split by entry: sign-in, reauth, adding a key in management, and adding a key during reset each sign their own;
- changing the password or deleting passkeys during reset doesn't touch any session; only the last step picks how to sign out: all devices, other devices, or none, defaulting to other devices;
- the account password uses its own pepper instead of sharing the lock's.

## 4. The account page becomes a terminal

The `/account/` page was deleted, and account actions moved into a terminal in the avatar dropdown. The API was split by entry, one each for session, reauth, reset, keys, devices and grants, and account tables all got an `account_` prefix.

The word root no longer appears in internal code. It appears only where users can see it: the `sudo root` command, the prompt and the copy.

## Why it changed again

The account side was sorted out, but the entry side still had the old structure: its names, commands and reauth didn't line up with the account's. Account & Site Entry V3 the next day made the two sides one system.
