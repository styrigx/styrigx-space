---
title: "Migrating the Blog from Hugo to Navfolio: A Retrospective"
description: "Same URLs so comments carry over, bilingual setup, dashboard homepage, SGX mark design — a retrospective on moving the blog from Hugo+PaperMod to Astro+Navfolio."
date: 2026-10-07
tags: ["blog", "Astro", "engineering"]
---

In October 2026 I moved the blog from Hugo + PaperMod to Astro + Navfolio. One day, start to finish: plan in the morning, content in the afternoon, homepage and icons in the evening, live by night. This is the retrospective: background, constraints, key decisions, and what broke.

## Background and Goals

PaperMod is light, fast, minimal — but it's purely a blog theme: post list plus post pages. Navfolio positions itself as a personal dashboard: avatar, motto, nav cards, writing stats, heatmap on one screen, with the blog as one module. That's closer to what I want: a blog as a foothold on the internet, not just a place for posts.

The goal was crisp: new theme, same content, no lost comments, no broken URLs.

## Constraint: Keep the URLs, Keep the Comments

The single most important constraint. Old posts lived at `/post/<slug>/`, and Giscus binds comments by `pathname` — as long as the new site serves identical article URLs, old comments carry over automatically. No database migration.

So step one was confirming the new theme could route articles as `/post/<slug>/` with trailing slashes, then verifying every URL, Chinese and English.

## Bilingual Setup

Chinese by default at root `/`, English under `/en/`:

- First visit auto-redirects by browser language; crawlers excluded (or search indexing breaks)
- Manual language choice remembered via localStorage
- Switching languages on a post jumps to its translation; falls back to homepage only when no translation exists
- Pagefind search with one index per language, no cross-contamination

## Homepage and Visual Decisions

The homepage assembles official components into a dashboard: ProfileCard, IntroCard, NavigationCard, ConnectCard, BlogHeatmap — with copy in both languages.

**Fonts**: LXGW WenKai for Chinese, Maple Mono monospace for English and UI. The build subsets WenKai to used characters only. WenKai ships a single Regular weight, so bold Chinese is browser-synthesized — acceptable at these sizes.

**Avatar**: my own photo, centered square crop.

**Favicon**: an interlocked SGX monogram — initials of Sloan Gray, also the core of Styrigx. Thickened strokes with separated letterforms for small-size legibility, in sage green to match the theme. Note: the theme prefers `favicon.svg`; a wrong version there gets picked up by browser tabs — I deleted the SVG so browsers fall back to PNG.

**Footer year**: `© 2020–2026`, end year computed at build time. 2020 marks when I first got on the outside internet.

## Deployment (Current)

1. Source in `styrigx/styrigx-blog`, main branch
2. Feature branch → PR → CI (build-and-deploy) green → merge
3. Cloudflare Pages auto-deploys on merge; live at https://blog.styrigx.com

Posts and config changes all go through PRs. No direct pushes to main.

## Lessons

1. **Delete `NAVFOLIO_CONTENT_SOURCE=docs`**: the theme's workflow sets it by default, making builds use demo content over yours. Remove it for Actions-based deploys.
2. **Don't touch Giscus params**: change repo_id or category_id and old comments stop matching. Migrate URL structure; leave comment config alone.
3. **TOML sub-table ordering**: `[params.xxx]` sub-tables must follow sibling plain keys, or later keys get swallowed into the sub-table.
4. **Build time vs runtime**: the footer year is computed at build time. A year with zero deploys shows a stale year — knowing this ends the confusion.

## Closing

The migration itself took a day; the real cost was nailing the constraints up front: URL rules, comment binding, bilingual routing — each had to be fixed before touching anything. Themes can change; content and readers' comments cannot be lost.
