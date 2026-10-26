<div align="center">

[中文](README.md) | English

# Styrigx's Space

To understand the world, take it apart; to believe in it, put it back together.

[Visit styrigx.com](https://styrigx.com) · [Blog blog.styrigx.com](https://blog.styrigx.com) · [GitHub @styrigx](https://github.com/styrigx) · [X @styrigx](https://x.com/styrigx)

![Hugo](https://img.shields.io/badge/dynamic/yaml?url=https://raw.githubusercontent.com/styrigx/styrigx-space/main/.github/actions/setup-hugo/action.yml&query=%24..HUGO_VERSION&label=Hugo&style=flat-square&color=2563eb&logo=hugo)
![Tailwind CSS](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/styrigx/styrigx-space/main/package-lock.json&query=%24.packages%5B%27node_modules%2Ftailwindcss%27%5D.version&label=Tailwind%20CSS&style=flat-square&color=2563eb&logo=tailwindcss)
![Styrigx UI](https://img.shields.io/badge/dynamic/yaml?url=https://raw.githubusercontent.com/styrigx/styrigx-space/main/web/data/version.yaml&query=%24.ui&label=Styrigx%20UI&style=flat-square&color=2563eb)
![Deploy](https://img.shields.io/github/actions/workflow/status/styrigx/styrigx-space/deploy.yml?style=flat-square&label=Deploy&color=2563eb)
![License](https://img.shields.io/badge/License-MIT-2563eb?style=flat-square)

</div>

---

## What is this

My personal homepage, built to feel like a Samsung phone. Posts and the sites I use live as apps on the home screen. The interface is Styrigx UI, my own take on One UI 9.0, and it works on phone, tablet and DeX.

## Preview

| ![Home](docs/screenshots/en-home-mobile.jpg) | ![Settings](docs/screenshots/en-settings-mobile.jpg) |
|---|---|
| Home | Settings |

![DeX](docs/screenshots/en-home-dex.jpg)
DeX

## Structure

| App | Path | What it is |
|---|---|---|
| Home | `/en/` | One of the three top-bar tabs: profile card, dual clocks, weather, Daymark's quote of the day and screen time. |
| Search | Navigation drawer footer | In-place search layer (no page change): on-site results, search with your chosen engine; pick the engine in Settings › Security and privacy. Old `/en/search/?q=` links open it on the home page. |
| Chat | `/en/chat/` | One of the three top-bar tabs: web-search Q&A (admin only; Gemini 2.5 Flash with Google Search grounding, streamed from `/api/chat` with sources; the gateway checks the session, then hands it to the `styrigx-chat` Worker). The conversation lives only in this tab and is gone when you close it. |
| Settings | `/en/settings/` | One of the three top-bar tabs: display, language, layout and other system settings, stored locally (synced once you sign in to the account). |
| Account | `/en/account/` | Opened from the avatar in the drawer head (admin only): account sign-in, service status (current state, latency, 90-day uptime and recent incidents for the main site, Blog, Daymark, Curio and Proxy rules via `/api/status`, refreshed every minute), cloud sync, devices, temporary keys, account security. |

## A few Styrigx UI details

- Three layout options, Mobile · Auto · DeX: on Auto, landscape viewports at least 840 wide and 500 tall get DeX, everything else gets Mobile (viewport only, no device sniffing).
- Sizes scale smoothly on wide screens: page margins and top-bar buttons grow with the width; the top bar and every page share one frame (up to 1440 on DeX, 640 for Mobile on wide portrait screens), content columns are centred in it, and Home cards use 2–3 columns that never get narrower than 320 (when weather or Daymark has no data, the remaining cards fill the row).
- Light / dark follows the system by default.
- One top bar on every page: nine-dot drawer button | middle capsule with only the current page name | quick panel circle; the avatar sits in the drawer head. On Home / Chat / Settings the capsule holds those three tabs instead (main site only).
- Two full versions: 中文 / English.

## Run locally

Requirements: Hugo extended 0.168.0, Node.js (CI uses 22, needed to build Tailwind).

```bash
git clone https://github.com/styrigx/styrigx-space.git
cd styrigx-space
npm ci
npm run build:css
hugo server -s web
```

Open http://localhost:1313 in a browser. Build with `hugo --minify -s web`; output goes to `web/public/`.

Pushing to main auto-deploys to Cloudflare Pages (Pages project `styrigx-space`).

## Directories

The site lives in `web/`, Workers in `workers/`, tests in `tests/`. See [STRUCTURE.md](STRUCTURE.md) (Chinese) for the full layout.

## License

Code is MIT; personal content (posts, images, avatar, etc.) is all rights reserved.

© 2020–2026 Sloan Gray · Powered by Styrigx UI
