---
title: "Gemini Free Tier Pitfalls: Quotas, Thinking, Search and Fallbacks"
description: "The traps I hit wiring the site's AI to Gemini's free tier: 2.5 Flash gone for new users, 3.x thinking eating the whole output budget, a 20-requests-a-day quota, and no search grounding. Where it ended up: Gemma 4 by default, Flash-Lite as the main Gemini model, automatic fallback on 429."
date: 2026-11-09
tags: ["Gemini", "Workers AI", "Cloudflare"]
---

Gray AI, the assistant in the bottom-right corner of the site, first retrieves relevant passages from the site's own content, then hands them to a model that streams the answer. There are two kinds of models: self-hosted ones on Cloudflare Workers AI, and Google's Gemini API. For Gemini I only have a free-tier key. On November 9 it walked me through just about every trap it has.

## Trap 1: 2.5 Flash suddenly returns 404

That day the AI window started failing, and the logs showed a 404 from upstream: `gemini-2.5-flash` was no longer available to new users. It had worked fine until then, with no warning.

Just switching the model id to 3.x wasn't enough. That led straight into trap 2.

## Trap 2: thinking eats the output budget, and the answer is empty

Gemini 3.x thinks by default, and **thinking tokens count against `maxOutputTokens`**. My output budget was 1024. By the time the model finished thinking, the budget was gone and the answer had no text at all, or the first token took forever to arrive.

The fixes:

- Set the thinking level explicitly: `minimal` for Flash-Lite (its default, and the cheapest); `low` for 3.8 Flash, which doesn't support `minimal`.
- Give external models at least 4096 output tokens, capped at 8192.
- Report empty answers as an error and log them, instead of silently showing an empty bubble.

## Trap 3: the free-tier quota is much smaller than I assumed

The AI Studio quota page spells it out; I just hadn't read it carefully:

| Model | Per minute | Per day |
|---|---|---|
| 3.x Flash (incl. 3.8 Flash), 2.5 Flash | 5 | 20 |
| 3.5 / 3.1 Flash-Lite | 15 | 500 |
| Pro | 0 | 0 |

Twenty a day is gone after a few rounds of my own testing, and Pro on the free tier is simply zero. So the main external model became **Gemini 3.5 Flash Lite**, with 3.8 Flash kept as the second option.

## Trap 4: no Google Search grounding on the free tier

I was sending Gemini requests with the `google_search` tool so answers could cite web sources. The pricing page says Grounding with Google Search is "Not available" on the free tier.

Worse, the rejection **isn't necessarily a 400**. In the end I widened the check: with the tool attached, any 4xx except 429 (rate limit), 404 (model not found), unsupported region or an invalid key counts as "tool rejected". Then:

- retry once without the tool;
- don't send the tool again for the next 10 minutes (tracked per key, since no free-tier model has grounding).

Search is still switched on in the config. If I ever move to a paid key, this fallback simply won't trigger and the tool works again, with no code change.

## Trap 5: what to do after a 429

The final fallback chain:

1. 3.8 Flash was picked and hits a 429 → don't wait and retry; **switch to 3.5 Flash-Lite and retry once**.
2. Flash-Lite also hits a 429 → return `daily_limit` to the front end, which tells the user today's quota is used up.
3. Exception: when the error body explicitly says it's the **per-minute** limit, return `rate_limited` and retry with backoff.

On top of that, before the first token arrives, a 503 (upstream overloaded) or a per-minute 429 is retried at most twice, after 0.8 s and 2 s. Each attempt waits at most 20 seconds for the first token, and the whole request is capped at 60 seconds.

## Trap 6: region restrictions

Gemini answers "User location is not supported" for some regions. A Worker runs by default at the edge location closest to the visitor, and that location's region isn't necessarily supported, so I pinned the AI Worker to run in a US region.

## Where it ended up: Gemini isn't the default

After all that, the most important decision turned out to be: **the default model isn't Gemini.**

- The default is **Gemma 4** on Workers AI, with thinking off and a 1024-token output budget. The other self-hosted option is GPT-OSS 20B.
- Gemini 3.5 Flash Lite and 3.8 Flash can only be picked when **signed in to the account**. Visitors who have entered the site but aren't signed in always get the default model.
- The model list lives in KV, so switching models means changing one value, no release needed. If KV can't be read it falls back to the config, then to a built-in list in the code.
- Retired Gemini ids (2.5 Flash and friends) are mapped to the current two when resolved, so an old choice saved in a browser keeps working.

That way visitors can ask whatever they like without touching the Gemini free quota, and the external models are there only when I choose them myself.

## Lessons

- **Design for the free tier as the free tier.** Quotas, features (search), even the model itself can change at any time. The code should degrade gracefully instead of assuming they'll always be there.
- **Re-check the defaults of each new model generation.** Thinking on by default and counted against the output budget doesn't throw an error; it just gives you an empty answer.
- **Model ids and quotas change.** When they do, check the official models page first, then update the code and the decision record. That rule is now in the repo's ADR.
