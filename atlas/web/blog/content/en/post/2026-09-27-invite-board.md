---
title: "Muse Invite-Code Board: Project Overview"
description: "A community Muse invite-code board: draw a code, contribute spares, vote on working ones. Architecture, data flow, and anti-abuse design."
date: 2026-09-27
tags: ["Muse", "AI", "Open Source"]
---

Muse invite codes have always been scarce: Meta releases them irregularly, people who get them have spares, people who don't are stuck waiting. This board fixes that mismatch — a self-service invite-code exchange where contributing, drawing, feedback, and cleanup all happen online.

## Core Mechanics

**Random draw**: one click, one random community-contributed code. Draws use a weighted rotation algorithm — least-drawn codes get priority, so every contributed code gets exposure instead of a few codes being drawn on repeat.

**Contribute**: have a spare code? Submit it. Submissions go through Cloudflare Turnstile to block automated flooding.

**Feedback**: got a working code? Mark it "works"; got a dead one? Flag it "invalid." Codes flagged invalid three times are hidden automatically and leave the draw pool.

**Auto-cleanup**: beyond invalid flags, the system periodically clears codes nobody has drawn for a long time, keeping the pool fresh.

## Architecture and Data Flow

- Frontend: single HTML file, Chinese/English bilingual, hosted on Cloudflare Pages
- Backend: Cloudflare Worker API, serverless
- Storage: Supabase for the code table; Cloudflare KV for rate-limit counters, messages, and recent-draw records
- Draw flow: request → Worker verifies Turnstile (when required) → weighted code selection → draw logged → code returned

No user accounts anywhere. No emails stored, no identities tracked. Contributing and drawing are both anonymous.

## Anti-Abuse and Privacy

- Rate limits on submissions and draws; over-limit IPs get a straight 429
- Turnstile blocks bot submissions; failed verifications never reach the database
- Codes carry no personal information; no share buttons, no social attribution on the site
- Footer keeps only a Privacy entry; no behavioral data collected

## Entry

https://muse-invite.styrigx.com/

Come grab a code, or contribute one. Feedback welcome via the contact channels on this blog.
