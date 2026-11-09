---
title: "Redesign: Turning the Whole Site into a Terminal"
description: "This round of redesign brings all four sites into one terminal style: the top bar, prompts, a floating AI window, a Mobile | Auto | DeX layout switch and a typed homepage tagline. Built Samsung- and DeX-first. Notes on the main trade-offs."
date: 2026-11-09
tags: ["Styrigx UI", "Design", "Samsung DeX"]
---

In early November I redesigned the whole site. The previous version was a card layout modelled on One UI, like a phone. This one is a terminal: the lock screen, the top-bar menus, the homepage, sub-page headers and the AI window all follow the same "prompt + command + output" pattern.

![Homepage (DeX layout): whoami, the typed tagline, the motto line and the embedded terminal](/blog/img/2026-11-09/home-dex-en.webp)

## Why a terminal

Of everything I use daily, the command line is the least decorated and the most information-dense interface. A personal site doesn't need conversion rates and doesn't have to please anyone. I wanted something that says "this is Gray's place" the moment it opens. The terminal style also has a practical upside: verification, confirmation and choices all fit into a command line, so there's no need for pop-ups.

That led to a few hard rules:

- **No overlays.** No native alert / confirm, and no new bottom sheets; choices expand inline instead.
- **Every terminal state has a way out.** The lock screen, reset, the shield menu and the account menu can all be left with `^C`, `exit` or "‹ back".
- **Respect reduced motion.** With the system's reduced-motion setting on, the typing tagline, the spinning avatar ring and page transitions all stand still.
- **Screen readers skip the decoration.** Prompts and command echoes are hidden from screen readers; the real content gets its own text.

## The top bar

The top bar runs edge to edge: the wordmark (`❯ Styrigx_`) on the left; the palette, shield, `>_` navigation and avatar on the right. It's 64px tall on desktop and **56px** in the mobile layout. Only the vertical padding shrinks; icons and avatar keep their size. On a phone screen, 8px is a line of body text.

The avatar has a dim arc that circles slowly, one turn every 2 seconds, speeding up while something loads or the AI is answering. It's about the only "alive" ornament on the site.

## Prompts

Prompts are the backbone of the interface, and the rules are strict:

- Lock screen: `entry@space:~$`
- Shield (site security): `styrigx@space:~#`
- Account menu: `login@account:~$` when signed out, `root@account:~#` when signed in

Everywhere else (the homepage terminal, the `Ctrl K` terminal drawer, sub-page headers, the AI question line) picks one of two based on account sign-in: `styrigx@space:~$` when signed out, `root@account:~#` when signed in. One glance at the prompt tells you who you are right now.

## The AI window

The floating button in the bottom-right corner opens Gray AI. On desktop it unfolds up and to the left from the button; on a phone it's a floating card. Messages get the terminal treatment too:

```text
styrigx@space:~$ --ask
grayai@space:~$ --reply
```

The question line follows the prompt rule above; the answer line is always `grayai`. On desktop `esc` closes it; on touch screens there's a "‹ back" at the bottom.

There was one back-and-forth here. I turned the phone AI window into a bottom half-sheet you could swipe down to dismiss, used it for a bit after it shipped, didn't like it, and reverted to the floating card. The lesson: **visual changes get their own design review** and don't ride along inside a batch of fixes. That rule is now written into the UI spec.

## Auto controls: language and layout

The `>_` navigation panel has two three-way switches, with Auto always in the middle:

- Language: `EN | Auto | 中文`
- Layout: `Mobile | Auto | DeX`

Language Auto follows the browser language, but **only once, when you arrive at the homepage from outside the site**. After that, whichever language I click into inside the site is where I stay; it won't drag me back on every page.

There are only two layouts: Mobile and DeX. The Auto rule: a viewport narrower than 720 CSS pixels is Mobile; otherwise, if the browser isn't in its "mobile site" mode, it's DeX. Choosing DeX manually on a phone screen lays the page out at 980 wide. Viewport changes (rotation, split screen) don't reload the page; the same rule simply runs again.

## Samsung and DeX first

My main device is a Samsung phone. I browse with Samsung Internet and often plug into DeX as a desktop. So this version puts three cases first: Samsung Internet on the phone, Samsung Internet in "desktop site" mode, and the big DeX screen. Other browsers and Apple devices come after.

"Desktop site" mode is a trap. When Samsung Internet on a phone switches to it, the page gets a virtual viewport far wider than the screen, and panels come out zoomed and misplaced. The Auto rule recognises this case specifically (a layout viewport more than 1.25 times wider than the screen) and gives it the DeX layout instead of a shrunken mobile one. I fixed several bugs of this kind earlier, and in the end they all collapsed into that one rule.

Apple devices need to work too. Luckily they come in few, regular sizes, so the same rules cover them with almost no special handling.

## The homepage

The homepage hero is a fake terminal session:

- `$ whoami`, and below it my name;
- a `$` line that types out one English tagline: **A Personal Digital Space**. It's the same on the English and Chinese pages, untranslated;
- a `#` line with the motto I set in my account profile, never truncated or translated, and hidden entirely when empty.

The tagline lives in the site config; the motto is controlled by the account. When I want a different line, I edit my profile from the avatar menu, no release needed.

Below that is a working embedded terminal: `help` lists commands, `cd blog` scrolls to the blog, `ask` asks Gray AI, `lock` locks right away. `Ctrl K` on any page brings up the same terminal.

## Wrapping up

The redesign took twenty-odd PRs: first the move into one site, then the shell and top bar, then the homepage, sub-pages, lock screen, AI and account, and a final polishing pass (key-hint lines, position counters like `02 / 06`, `-- EOF --` end markers). The interface rules are written into the UI spec in the repo. From now on, visual changes start with the spec and a separate look at the design, before any code.
