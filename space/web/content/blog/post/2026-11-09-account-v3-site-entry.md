---
title: "Account & Site Entry V3: The Site Owns the Door, the Account Owns Permissions"
description: "This site is locked by default. V3 splits \"can you come in\" and \"can you write\" into two separate tickets: one lock for all four sites, reauth only with long-term credentials, share links that need only a session, and a lock button that locks this device only. Here is why."
date: 2026-11-09
tags: ["Styrigx UI", "auth", "Security", "Passkey"]
---

This website is my personal space. It isn't open to the public, and every page starts at a lock screen. Since October the entry and account design has gone through several rounds: first a front-end-only lock screen with a captcha, then server-signed sessions, then the account split out into its own service. The version from November 9 (I call it V3) is the first one that feels properly sorted out, so I'm writing it down.

![The lock screen: a terminal, type sudo styrigx to enter](/blog/img/2026-11-09/lock-dex-en.webp)

## The problem: one ticket doing two jobs

Early on there was a single "lock credential" that answered two questions at once: can you come in, and can you manage or write data. To tell light actions from heavy ones, more layers grew on top: a root credential, an owner credential, an admin credential. The recovery key could both reset and re-verify. Concepts kept standing in for each other, and every change meant checking whether it quietly opened some other door.

V3 comes down to one sentence: **the site owns the door; the account owns permissions.**

- The **entry session** only answers "can you come in".
- The **account session** only answers "can you write, can you see private content".

The two tickets are issued by different services with different signing keys, and neither can stand in for the other. The entry side knows nothing about accounts, and the account side doesn't open doors.

## One site, one lock

The main site, the blog, Curio and Daymark now live under one domain, split by path (that's its own post). So entering needs a single session: unlock once on any of them and you're in on all four. Back when each site had its own subdomain, I had to share cookies across subdomains, distribute public keys and bounce between sites. Lots of paths, lots of ways to fail. All of that is gone now.

## How you get in

| Method | Who | What it can do |
|---|---|---|
| Unlock password | me | enter, reauth |
| Passkey | me | enter, reauth |
| Temporary key | issued by me to someone | enter only |
| Share link | sent by me or anyone already inside | enter on open |
| Recovery key | me, when everything else is lost | reset only |

The lock screen is a terminal: type `sudo styrigx`, then pick passkey or password. No pop-ups, no captcha.

**Temporary keys** are for letting friends look around. They last 1–24 hours, or 3 / 7 / 15 / 30 days, can be named and revoked at any time, and at most 20 can be active at once. The plain code is shown once, at creation; the server only keeps a hash. Once a key is revoked, any session that came in with it dies on its next request. The site no longer has any public visitor entrance. If I want someone to see it, I issue a key.

**Share links** are more casual. "Share this page" on any page creates a short link that carries a session, and the person who opens it lands straight inside. Whoever sends the link picks how long that session lasts, from 30 minutes to 7 days.

## Reauth: long-term credentials only, 3 minutes

Sensitive actions (changing the password, removing a passkey, managing temporary keys) need a reauth first. V3's rules:

- Reauth **accepts only the unlock password or a passkey**. Temporary keys, share links and the recovery key cannot produce a reauth ticket.
- A reauth ticket lives for **3 minutes** and is never renewed.

The reasoning is simple. Only I, holding a long-term credential, should be able to do sensitive things. A temporary key is something I lend out, and something lent out shouldn't be able to change the lock. Three minutes is enough to finish one task, and short enough not to leave a half-open door on a device nobody is watching.

The recovery key follows the same logic. It only buys a 3-minute reset ticket, and a reset ticket can only reset credentials. **It can't enter the site and it can't reauth.** One key, one door, which means every sensitive action has exactly one legitimate path when I audit it.

## Why share links need only a session

I argued with myself longest over this one. By the "sensitive actions need reauth" logic, creating a share link hands out a ticket too, so maybe it should need reauth. The final call:

- **Creating** a share link only needs an entry session, including for people who came in with a temporary key or a share link.
- **Managing** links (listing, revoking) needs reauth.

Sharing is frequent and spur-of-the-moment. If it asked for verification every time, nobody would use it. And the link isn't a plain-text key: the session it carries has a fixed lifetime, and I can see and revoke every link from the management view. The risk is contained, so convenience wins.

## Lock now locks this device only

"Lock now" in the shield menu, or typing `lock` in the terminal, **locks only the current device** and **needs no verification**. Locking is self-protection and shouldn't have a hurdle. Locking my phone shouldn't kick my tablet and laptop out too.

Sending every device back to the lock screen is a separate action, and that one needs reauth. Also, when I change an entry credential under reauth (new password, removed passkey), every other device goes back to the lock screen while the current one stays in.

## Session lifetimes

| Ticket | Lifetime | Renewal |
|---|---|---|
| Entry (password / passkey) | 12 hours | none |
| Entry (temporary key) | the shorter of the key's remaining time and 12 hours | none |
| Entry (share link) | 30 minutes – 7 days, chosen when sent | none |
| Reauth / reset | 3 minutes | none |
| Account session | 30 days | sliding |

Entry lasts 12 hours with no renewal. That's about one unlock a day, and with a passkey it's a single touch.

The account session used to last 400 days, which was far too long: a device that had ever signed in stayed signed in forever. It's now **30 days, sliding**: once less than 15 days are left, it gets re-signed automatically. Devices I use every day never drop out, and a device left idle for a month simply expires, without me having to remember to clean it up.

Share links can last up to 7 days, longer than the 12 hours I get with my own password. That's on purpose: a share is for someone else, and they might not open it the same day.

## The account side

The account is a separate service with no public route; requests reach it only through the site core. The avatar in the top bar is the account terminal: `sudo root` signs in, `sudo root reauth` re-verifies, `sudo root reset` resets with the recovery key. The rules mirror the entry side:

- Account password and account passkey can sign in and reauth.
- The recovery key only buys a reset ticket. It can't sign in and it can't reauth.
- After a reset you pick one of three: sign out all devices, sign out the other devices (the default), or sign out nothing.

The symmetry isn't there for looks. Once one side's rules are worked out, the other side just follows them, and the tests line up one to one.

## The cost

- Rotating a signing key or a password pepper sends every device back to the lock screen once and invalidates old temporary keys. That already happened once during this cutover.
- Two tickets means two sign-ins: on a new device, writing anything takes entering the site and then signing in to the account. I think it's worth it. A leak on either side doesn't spill into the other.

If I ever open registration, ordinary users will be called `user`, and temporary keys might retire then. Not now.
