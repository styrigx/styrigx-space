---
title: "Auth Becomes a Gateway: One Worker for Four Sites"
description: "On October 18, auth moved out of Pages Functions middleware into its own Cloudflare Worker. Subsite Pages no longer hold any keys, and every ticket is checked by the gateway. This version didn't change the credential model; it changed where auth lives."
date: 2026-10-18
series: ["Styrigx Auth Spec: How It Evolved"]
seriesOrder: 3
tags: ["Styrigx UI", "auth", "Security", "Cloudflare"]
---

> Part of the "Styrigx Auth Spec: How It Evolved" series, following Auth Spec 2.0. There is no written final design for this version; it is pieced together from the PRs of the time.

The previous posts were about what the tickets look like: how many key pairs, how many kinds of session, who signs and who verifies. By mid-October the ticket design had mostly settled, and the question became a different one: **where does the auth code live?**

## 1. The problem

Auth lived in the main site's Pages Functions middleware. Subsites like the blog and the bookshelf had to verify tickets too, so each carried its own middleware and its own public key, each configured separately at deploy time. That meant:

- the same logic scattered across several repos, so every change had to be synced, and every missed spot was a hole;
- secrets and static pages sat in the same Pages project, with no clear boundary;
- whether and how a subsite checked tickets depended on each one remembering to, and nothing could say in one place how the site as a whole was guarded.

As I put it then, the task from the start was to make auth fully independent. Moving only `/api/*` across while pages kept checking in Pages was rejected.

## 2. What changed

### Auth became its own Worker

A new Worker, `styrigx-auth-gateway`, sits on a site-wide wildcard route. Every request passes through it first, and it decides whether to let it through. Pages went back to serving static files only.

### Secrets live only in Secrets Store

Private values such as signing keys moved into Cloudflare Secrets Store, read only by the gateway at runtime. Pages keeps only public variables; CI checks fail if a secret shows up in Pages config again.

I created the GitHub environment and deploy credentials for the gateway myself, and it can only deploy from main.

### "Zero-key" subsites

Subsite Pages dropped their own middleware and hold no keys at all. Page session checks and ticket verification are all answered by the gateway; subsites whose APIs became their own Workers ask the gateway through a service binding.

Subsite CI gained a gate: before deploying, confirm the gateway is already attached to that site, and don't deploy if it isn't. Better not to go live than to go live unguarded.

### A staged rollout

Nothing was switched over at once. The order was:

1. deploy the gateway without live traffic, trying it on one harmless endpoint;
2. take over the main site's `/api/*`;
3. take over every page of the main site, leaving Pages with static files only;
4. bring the subsites in one by one: the blog and bookshelf first, Curio and Daymark a few days later.

Each step waited for the previous deploy to be fully green and smoke-tested. CI also checks that every page has a route, while static assets skip the gateway to save a Worker call.

## 3. Why

- **One place decides.** How the whole site is guarded is answered by the gateway alone. Changing a rule no longer means "change the main site, then three subsites".
- **Keys further from pages.** Static deploys and secrets are fully separated; a problem in Pages can't reach a key.
- **fail-closed has a home.** The gateway answers 401 to any unauthenticated `/api/*`, without revealing whether the endpoint exists. Endpoints deleted later still look like 401 from outside, not 404, and that is on purpose.

## 4. What didn't change

This version was a move, nothing more. The root credential, owner credential and lock credential from the previous post, with their doors and tickets, moved into the gateway unchanged. None of the conceptual questions (what the owner credential really is, whether stepup and app credentials should exist) were touched; they waited for the next version.

## Afterwards

The gateway was later renamed, absorbed the share service, and in v6 went from "issue and check" to "check only, never issue". But "one entry point for the whole site, zero keys in subsites" has held since this day.
