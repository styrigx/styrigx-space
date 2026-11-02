---
title: "AI Agent Collaboration Whitepaper v1.0: Credentials, Branch Protection, and Merge Workflow"
description: "How AI agents push code, open PRs, and merge — without ever touching main: separated credential planes, branch protection rules, the standard dev loop, and rotation/incident response."
date: 2026-10-11
tags: ["Specification", "GitHub", "AI Agents", "Security"]
superseded: true
---

## 0. Abstract

This specification solves one concrete problem: how to let an AI execution agent independently push code, open pull requests, track CI, and merge — while guaranteeing it can **never write to the main branch directly**, and every credential it holds is **controllable, expirable, and revocable**.

Three design decisions carry the whole thing: push credentials and API credentials are separated (each does its own job, never interchangeable); the main branch is locked by repository-level protection rules and can only be entered via PR + green CI; push credentials are short-lived and can be killed in one click when compromised. The spec binds to *roles* (repository owner / execution agent / observer), not to any particular tool or agent product — swapping agents never means swapping the spec.

## 1. Scope and Roles

**Covered repositories**: styrigx-space, styrigx-blog, styrigx-book. A new repository must complete the protection setup in §6 before it is admitted under this spec.

**Roles**:

| Role | Description |
|------|-------------|
| Repository owner (human) | The only party who may issue, renew, or revoke credentials; maintains branch protection rules; gives final confirmation on merges. |
| Execution agent | A replaceable AI executor (currently Muse). Operates repositories per this spec; knows nothing beyond what the task requires. |
| Observer (read-only) | Watches CI status and deployment results; performs no writes. |

Every rule in this document states whom it constrains. Owner and agent responsibilities are asymmetric: the owner "issues keys and fits the locks"; the agent "uses the doors by the rules."

## 2. Design Principles

1. **Least privilege**: the push credential grants only Contents read/write — no repository administration, no settings changes, no branch deletion. Rationale: the agent only needs to push code; anything more is attack surface.
2. **Push credentials and API credentials are separated**: the credential used for `git push` and the credential used for GitHub API calls are two different keys, never interchangeable. Rationale: platform-held encrypted credentials cannot travel over the git HTTPS protocol; letting an API credential leak into the git transport layer would widen the blast radius.
3. **Main is entered only via PR + green CI**: nobody — including the owner — pushes to main directly. Rationale: CI is the last objective line of defense; bypassing it means abandoning verification.
4. **Credentials expire and are revocable**: push credentials live at most 7 days and must be rotated on expiry; revoke immediately on suspected compromise. Rationale: a long-lived credential is a ticking bomb; a short lifetime seals the loss window shut.
5. **Protection rules apply to administrators too**: the bypass list on branch protection must be empty. Rationale: if the rules make an exception for the owner, the agent will eventually "borrow" that exception — there is no "trusted humans may bypass" in a security design.
6. **Swap agents, not the spec**: this document is the single source of truth for handover; a new agent must read it in full and confirm before starting work. Rationale: verbal agreements die with personnel changes; written specs don't.

## 3. Credential Model

| | Push credential | API credential |
|---|---|---|
| **Form** | Fine-grained personal access token | Per-repository credential held encrypted by the agent platform |
| **Visibility** | Handed to the agent directly by the owner (one plaintext handoff) | The agent never sees the plaintext; it can only call through the platform gateway |
| **Scope** | Contents read/write only | One per repository; each covers only that repo's PRs / CI / merges |
| **Lifetime** | At most 7 days, rotated on expiry | Managed by the platform; long-lived but revocable and rebuildable at any time |
| **Used for** | HTTPS `git push` only | Opening PRs, checking CI status, updating branches, merging PRs |
| **Stored in** | The agent's git credential helper | Platform-encrypted storage |

**Must**: the two credential types are never mixed. The push credential must not be used for API calls; the API credential must not appear in the git transport layer. Rationale: mixing them lets a single leak compromise both planes at once.

**Why not SSH deploy keys**: the agent's runtime environment may block the SSH protocol at the egress proxy (only HTTPS passes), in which case deploy keys are entirely unusable. Deploy keys remain a future option — only if and when the network permits SSH, and still one key per repository. Rationale: the choice must be grounded in "what actually works on this network," not "what is elegant in theory."

**Why the Git Data API is forbidden**: the Git Data API allows creating commits on the remote without going through local git history (building blobs / trees / commits, rewriting refs), bypassing local tests and commit review; the resulting commits cannot be reproduced or verified locally. The Git Data API **must not** be used for any write on any branch. Rationale: reproducibility is the floor of engineering collaboration — commits that bypass local history are unauditable and their rollback cannot be verified.

## 4. Branch Protection

Every repository must configure one ruleset protecting the main branch:

| Setting | Value | Rationale |
|---|---|---|
| Status | Active | A draft rule is no rule. |
| Bypass list | Empty | Applies to administrators too — see §2, principle 5. |
| Target | Default branch (main) | Only the main branch is locked; feature branches stay unrestricted to keep development fluid. |
| Branch deletion | Forbidden | Prevents accidental main deletion. |
| Force push | Forbidden | History must be append-only; rewriting it breaks the audit chain of merged work. |
| Pull request required | Yes | Every change entering main goes through a PR. |
| Required approvals | 0 (do **not** enable "require approval from someone other than the last pusher") | On a single-maintainer repository this locks the owner out of merging forever — a self-lock. CI plus the owner's offline confirmation substitutes for review. |
| Required status checks | See table below | Green CI is the hard gate for merging. |
| Branch must be up to date | Yes | Must be rebased onto the latest main before merging, so stale code never lands. |

**Required checks per repository**:

| Repository | Required checks |
|------------|-----------------|
| styrigx-space | quality, passkey-e2e |
| styrigx-blog | build-and-deploy |
| styrigx-book | build-and-deploy |

**Must**: required checks must name checks that **actually exist** in the repository's CI. Rationale: naming a nonexistent check blocks merging permanently — GitHub will wait forever for a check that never arrives. This exact failure has happened.

## 5. Standard Development Loop

1. **Open a feature branch** off the latest main; name it after its purpose. Never write code directly on main.
2. **Test locally**: build, unit tests, and relevant e2e must pass locally before pushing. Rationale: using CI as a substitute for local testing wastes everyone's time.
3. **`git push` the feature branch**: HTTPS only, with the push credential. Pushing main is forbidden.
4. **Open the PR**: prefix the title with version/type; describe any anomalies encountered during development (CI failures, what was fixed) truthfully — no omissions. Rationale: the PR description is an audit record; hiding anomalies is falsifying the audit.
5. **Wait for CI**: no merge actions before CI reports; on failure, diagnose locally, apply a genuine fix, then push. **Forbidden**: re-running someone else's failed job to "go green," deleting tests, or lowering thresholds to pass CI.
6. **When the branch falls behind main**:
   - No conflicts: sync via the update-branch API.
   - Conflicts: resolve with `git merge main` locally, run the full test suite, ordinary `git push` (force push forbidden).
   - Cannot resolve: stop, report the conflict details to the owner, do not route around it.
7. **Merge after green CI**: merge the PR via the merge API (merge-commit method).
8. **Verify live**: after merging, confirm the production deployment succeeded and run smoke checks (homepage status, key endpoints); report problems immediately.

## 6. Owner Checklist

- [ ] **Issue / renew / revoke the push credential**: issue a fresh one before expiry; revoke immediately on suspected compromise, then notify the agent the old credential is dead.
- [ ] **Maintain per-repository API credentials**: rebuild promptly on expiry or platform changes so the agent's read/merge operations never break.
- [ ] **Maintain branch protection rules**: when CI pipelines rename or add/remove checks, sync "required status checks" the same day (otherwise merging blocks forever — see §4).
- [ ] **New-repository admission**: a new repository must have protection rules in place *before* joining the shared push credential. **Forbidden**: adding an unprotected repository to the shared credential — one key opening many locks only works if every lock is sound.
- [ ] **Merge confirmation**: human confirmation before merging high-risk PRs (auth changes, deployment config).

## 7. Agent Duties and Prohibitions

**Do**:

- Push only feature branches; record anomalies truthfully in PR descriptions; diagnose CI failures locally before fixing; when a token expires, request a new one from the owner and nothing else.

**Do not**:

| Prohibition | Rationale |
|-------------|-----------|
| Push to main | Main is entered only via PR — §2, principle 3. |
| Force push | Rewrites pushed history and breaks the audit chain; the protection rules forbid it anyway. |
| Any write via the Git Data API | Bypasses local history and tests; irreproducible — see §3. |
| Mix the two credential types | Widens the blast radius of a single leak — see §3. |
| Print tokens, or embed them in remote URLs / repo files / logs / PR descriptions | Any persistence or propagation of a token is a leak. |
| Switch channels on your own when a token expires (e.g., move to SSH, switch APIs) | The credential channel is the owner's decision; the agent has no standing to choose. Stop and request a new token. |
| Append commits to a PR after confirmation | The merged code must match what was confirmed; to change it, open a new PR or re-confirm. |
| Conceal CI failures or test gaps | The audit record must be truthful — §5, step 4. |

## 8. Rotation and Incident Response

**Scheduled rotation** (owner issues a new token; agent executes):

1. `git credential reject` to drop the old credential (addressed by the protocol/host/username it was stored under).
2. `git credential approve` to store the new credential.
3. Verify with one harmless push (e.g., `--dry-run`).

**Suspected leak** (owner executes, agent cooperates):

1. Revoke the token on the platform side immediately — do not wait for confirmation. **Do** cut first, investigate after.
2. Issue a fresh token and hand it to the agent per the rotation flow.
3. Review branch push records and PRs within the exposure window for anomalous commits.

**Must**: between old-token revocation and new-token activation, the agent **must not** push via any alternate channel to "keep things moving." Rationale: workarounds during the gap are precisely where incidents breed.

## 9. Agent Handover Checklist

When replacing the execution agent (or its platform), in order:

- [ ] Revoke the old push token (owner).
- [ ] Re-register per-repository API credentials on the new agent platform (owner).
- [ ] Issue a new push token to the new agent (owner).
- [ ] The new agent reads this whitepaper in full and confirms understanding to the owner (in writing).
- [ ] The new agent runs the full loop — push → open PR → CI → close PR — on an empty feature branch (a one-line comment change), proving both credential planes work.
- [ ] After the dry run succeeds, delete the API credentials held on the old agent platform.

**Forbidden**: skipping step 5 and handing production PRs straight to the new agent. Rationale: handover verification must be done with harmless operations — never practice on a real release.

## 10. Appendix

### A. Ruleset configuration item by item

See the branch-protection table in §4. Notes: ruleset enforcement set to Active; bypass actors is an empty array; `required_status_checks` lists the check names from the §4 table; `required_pull_request_reviews` sets `required_approving_review_count` to 0 with no extra restrictions beyond dismissing stale reviews (single-maintainer repository).

### B. git credential configuration example

The push credential is stored once, not per repository (one shared token across repositories):

```
protocol=https
host=github.com
username=x-access-token
password=<TOKEN>
```

Store with `git credential approve` (reads the four lines above plus a blank line from stdin); clear with `git credential reject` (reads the first three lines plus a blank line). `<TOKEN>` is a placeholder — the real token appears exactly once, in the direct handoff between owner and agent, and is never written to any file.

Every repository's remote uses a credential-free HTTPS URL of the form `https://github.com/<owner>/<repo>.git`. **Forbidden**: embedding the token in the remote URL (the `https://<token>@github.com/...` form) — URLs surface in logs, error messages, and process listings.

### C. Changelog

| Version | Date | Notes |
|---------|------|-------|
| v1.0 | 2026-10-11 | Initial release: dual-credential model, branch protection rules, standard dev loop, rotation and handover checklists. |

---

*The execution agent must read this document before starting any repository work. Where this document conflicts with the owner's ad-hoc instructions, the owner's latest written confirmation prevails.*
