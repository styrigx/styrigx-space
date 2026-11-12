---
title: "Command Handbook: Using the Site Terminal"
description: "What every command in the site terminal does, who can run it and whether it asks you to verify again. Written for v6 P4 as it stands and updated whenever a command changes."
date: 2026-11-12
series: ["Styrigx Auth Spec: How It Evolved"]
seriesOrder: 11
tags: ["Styrigx UI", "auth"]
---

> Part of the "Styrigx Auth Spec: How It Evolved" series and the companion handbook to [Identity v6](/blog/post/2026-11-12-identity-v6/). It is a living document: when a command changes, this page changes with it. It describes v6 P4 today; device marks and the rest of 2g get added once they ship.

## 0. Three things first

- **Open the terminal**: press `Ctrl K` (`⌘ K` on a Mac), or click `>_` in the top bar.
- **The prompt tells you who you are**: `nobody@space:~$` is a visitor, `styrigx@space:~$` is a regular user (styrigx here as an example), `root@space:~#` is root (note the `#`).
- **When in doubt, ask man**: `man` lists every command, `man <command>` shows its full page.

## 1. Anyone can use

| Command | What it does |
|---|---|
| `man`, `man <command>` | Read the manual |
| `ls [path]`, `cd <dir>`, `pwd` | List, change and print the directory. `cd` only changes the directory; use `open` to actually go there |
| `open [path]` | Open a site, `daymark/today` or the account card (`open ~/account`) |
| `cat daymark/today` | Print today's daymark line |
| `find <keyword>` | Search the four sites' public pages |
| `theme`, `theme <palette>` | Open the palette panel, or switch straight to one |
| `history`, `clear` (`cls`) | This session's commands; clear the screen |
| `whoami` | Print who you are. After `su root` it shows the path, e.g. `root via styrigx` |
| `exit` | Leave one layer: root → user → visitor. Not signed in, it closes the terminal |
| `lock` | Sign everything out and go straight back to visitor; no verification |

## 2. Signing in and switching: su

- `su <user>`: sign in as that user with its password or a passkey. A new user sets a new password on first sign-in.
- `su root`: **wheel** members only, with root's credentials. Root lasts at most 1 hour and goes back after 15 minutes idle in the foreground.
- Root never signs in directly from visitor: `su <user>` first, then `su root`.
- While signed in as a user, `exit` first before you `su` to another user.

Identities stack up layer by layer: `exit` leaves one layer each time, `lock` leaves them all.

## 3. Managing yourself once signed in

| Command | What it does | Requires |
|---|---|---|
| `passwd` | Change your password | Your current password first. Your current session stays; every other session ends |
| `passkey`, `passkey add`, `passkey rm <n>` | List, add or remove passkeys | Signed in |
| `device`, `device rm <n>`, `device rm --all` | List signed-in devices, or sign one or all out | Signed in |
| `profile`, `profile set name｜nick｜sign｜email <value>`, `profile avatar` | Show or change your profile and photo | Signed in |
| `groups` | Your groups | Signed in |
| `who` | Your sessions: identity path and start time | Signed in |
| `ask <question>` | Ask Gray AI | ai group only |

**Key point: `passwd` and `passkey` act on whoever is on top of the stack.** To change root's password or passkeys, root must be on top: `su root` first, then change them. Until you do, you are changing your own user's.

## 4. Managing users (root, or sudoers with sudo)

| Command | What it does |
|---|---|
| `useradd <name> [-e YYYY-MM-DD] [-G group,group]` | Create a user and print a one-time password (shown once, valid 24 h, must be changed at first sign-in). `-e` makes the account stop working at 00:00 Beijing time on that date |
| `userdel <name>` | Delete a user with its sessions, keys and groups. root and styrigx can't be deleted |
| `usermod -aG <group> <name>`, `usermod -rG <group> <name>` | Add to or remove from groups. That user's sessions end and it signs in again |
| `passwd <name>` | Issue someone a new one-time password; all their sessions end. Not for root |
| `groups <name>`, `who` | Someone else's groups; every session on the site |

A user with an expiry can't join wheel, sudoers or the write groups. Removing the last member of wheel or sudoers asks you first.

**What sudo is**: sudoers don't switch to root. They put `sudo` in front to borrow root for **one** command, e.g. `sudo useradd alice`. Each time it asks for your own credentials, keeps no ticket and pushes no layer. sudo only runs the commands in the table above and **can't touch root's credentials**: `sudo passwd root` and `sudo passkey` are always refused.

## 5. Proxy subscription: sub (root only)

`sub` shows the overview, `sub show [name]` prints the urls, `sub add` / `upload` / `mv` / `rm` / `enable` / `disable` manage sources, `sub key` changes the public key, `sub token reset` makes a new token. There is a lot of detail, so read `man sub`.

## 6. Rescue: rescue

For when you've forgotten root's password and lost every passkey:

1. Type `rescue` in the terminal and enter the recovery key.
2. You get a 15-minute root rescue session. **Only** these work: `passwd`, `passkey`, `whoami`, `groups`, `exit`, `lock`. Changing the password here doesn't ask for the old one.
3. Use `passwd` / `passkey` to restore root's credentials right away. `exit` takes you straight back to visitor.

**A used recovery key can't be used again.** As soon as the rescue is over, set a new one.

## 7. Keys change in the dashboard, not the terminal

The recovery key and the other secrets are not changed in the terminal, and there is no command for it. To change one, Gray edits its value in Secrets Store in the Cloudflare dashboard. No code change and no redeploy; it takes effect within 60 seconds (the recovery key at once).

The old "recovery key" commands (`sudo root reset` and the like) are gone. `rescue` is now the only way in.

## 8. Where the v5 commands went

| Old | Now |
|---|---|
| `sudo styrigx`, `sudo root` | `su <user>`, `su root` |
| `sudo -v`, `sudo root reauth` | Gone. sudo verifies every time |
| `sudo root reset` | `rescue` |
| `lock passwd`, `lock passkey`, `lock --all` | Gone. Use `passwd` / `passkey` for credentials, `lock` to sign everything out |
| `share` | Gone; share links are retired |
