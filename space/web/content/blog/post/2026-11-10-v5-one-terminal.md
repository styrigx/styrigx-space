---
title: "v5: One Terminal, One Entry, Three Locks"
description: "November 10 to 11: four separate terminals merged into one; every entry to the site goes through a single command, sudo styrigx; the site went public again with only AI, music and monitoring locked; temporary keys were deleted in favor of revocable share-link sessions."
date: 2026-11-10
series: ["Styrigx Auth Spec: How It Evolved"]
seriesOrder: 9
tags: ["Styrigx UI", "auth", "Security"]
---

> Part of the "Styrigx Auth Spec: How It Evolved" series, following Account & Site Entry V3. Based on the v5 terminal design and its rollout plan.

V3 split entry and account into two sets of tickets. The model was clear, but the interface had scattered: the site had four separate terminals (lock screen, home, shield, account), with four command tables and four entry points; the whole site was locked, so guests saw nothing; and temporary keys and link keys were two mechanisms side by side. v5 pulled them together.

## 1. First, a side branch: five ttys, one engine (night of 11-09)

The night before, a first round of terminal unification landed: five terminals (lock screen, home, shield, AI, account) shared one engine and one command registry; the lock screen carried only an allow-listed set of commands; `man`, `open` and `tty` were added; `cd` changed only the current directory instead of jumping pages.

It was an interface refactor that left the auth model alone, and was replaced the next afternoon by the more thorough plan below.

## 2. One terminal

Apart from the AI window, the lock screen, home, shield and account terminals became **one**: one session, one history, one command table.

- the terminal button in the top bar is visible to everyone; on desktop it opens a large centered window, on phones a full card;
- the spot on the home page where the embedded terminal used to be now holds an about card;
- `help` was removed in favor of `man`: `man` lists the commands you can use, one line each, and `man <command>` shows usage;
- account actions all moved into the terminal as well.

## 3. One entry: `sudo styrigx`

There is only one way to formally enter the site: type `sudo styrigx` in the terminal. There is no lock screen anymore.

Tapping "unlock" on a locked feature opens the terminal with that command prefilled; once it succeeds, the terminal closes, the original entry animation plays, and you're back on the page you were on. That holds for guests and for people arriving with a share link alike.

The prompt shows the identity the server reports: guests are `nobody`, someone who has entered is `styrigx`, and an account sign-in is `root`; someone who came in through a share link is still `nobody`, ending in `#`. The front end never infers identity on its own; it shows what the server says.

## 4. The site goes public again, with three locks

Before V3 the whole site was locked, and any page opened on the lock screen. v5 turned that around: **pages and public data are open to everyone, with three exceptions**:

- **the AI window**: the window still shows, but the model slot becomes a lock icon, and tapping it opens the terminal;
- **music**: guests can see playlists and covers but can't play; after entering you can listen; uploading and managing need account authorization;
- **monitoring**: the status card.

Pages and data of the blog, Curio and Daymark, RSS, screen time and about are open to all.

Search was split too: a keyword search, `find`, was carved out of the AI without a model behind it. It reads the four sites' existing indexes, is rate-limited, and is available to everyone. The AI stays locked.

Access rules live in one table: the gateway's route access table is the only source, and any `/api/*` not listed requires entry, fail-closed.

## 5. Temporary keys out, share-link sessions in

Temporary keys were deleted wholesale: back end, tables, columns and their pepper. To show someone something, I now send a share link:

- opening it gives an entry session marked with the link it came from;
- every check looks that link up again, so revoking the link ends the session immediately;
- a link session can look and listen, but can't create share links, change credentials or reauth;
- expired links are cleaned up daily.

So "who can get in" is down to two kinds: me, and people I've sent a link to, and the latter can be taken back at any time.

## 6. The top bar: shield and avatar, there and back

The top bar settled on: shield, palette, a four-way nav grid, then the terminal and the avatar on the right.

- **The shield** opens no window; it's an identity marker. A guest tapping it goes to the terminal to type `sudo styrigx`; someone already in goes to the terminal to confirm leaving the entry session. There and back, matched.
- **The avatar** can only be tapped after entering, and opens the account window; for guests it's decoration.

## Why it changed again

v5 brought the interface down to one, but underneath there were still two sessions, two recovery keys, two kinds of reauth (`sudo -v` and `sudo root reauth`), and share links as a third mechanism for "giving someone access". v6, which started the next day, collapsed all of that into one issuer and one set of identities.
