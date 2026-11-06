---
title: "AI Agent Collaboration Whitepaper v2.0: Credential Separation, Branch Protection, and Merge Workflow"
description: "v2.0 revision: per-repository vs. shared push credentials, workflow-editing rules, self-service permission errors, an expanded prohibition list, and the real-device acceptance loop. Supersedes v1.0, which is retained as a historical version."
date: 2026-10-11
tags: ["Specification", "GitHub", "AI Agents", "Security"]
---

## 0. Abstract

This specification solves one concrete problem: how to let an AI execution agent independently push code, open pull requests, track CI, and merge — while guaranteeing it can **never write to the main branch directly**, and every credential it holds is **controllable, expirable, and revocable**.

v2.0 refines v1.0's two-plane credential model into an explicit division of labor: **per-repository credentials** (one per repository, full operational scope, held encrypted by the agent platform) versus a **shared push credential** (Contents read/write only, shared across repositories, used solely for pushing ordinary files over HTTPS). This revision draws hard lines around each credential's scope, permitted uses, and prohibitions.

Three design decisions carry the whole thing: use the credential that belongs to the repository you are writing to (each key opens exactly one lock, never interchangeable); the main branch is locked by repository-level protection rules and can only be entered via PR + green CI; short-lived credentials expire fast and die in one click when compromised. The spec binds to *roles* (repository owner / execution agent / observer), not to any particular tool or agent product — swapping agents never means swapping the spec.

**This document supersedes v1.0; v1.0 is retained as a historical version.** The original v1.0 text is at [AI Agent Collaboration Whitepaper v1.0](/en/post/2026-10-11-agent-collaboration-whitepaper/).

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

1. **Least privilege**: the shared push credential grants only Contents read/write — no repository administration, no settings changes, no branch deletion, no workflow edits. Rationale: pushing ordinary files needs nothing more; anything extra is attack surface.
2. **One repository, one credential**: each per-repository credential works only against its own repository. Using another repository's credential — or a generic portal credential — as a substitute is forbidden. Rationale: one key per lock keeps the blast radius contained and makes audits traceable ("which key touched which repo"); a universal key ties every repository's fate together.
3. **Main is entered only via PR + green CI**: nobody — including the owner — pushes to main directly. Rationale: CI is the last objective line of defense; bypassing it means abandoning verification.
4. **Credentials expire and are revocable**: the shared push credential lives at most 7 days and must be rotated on expiry; revoke immediately on suspected compromise. Rationale: a long-lived credential is a ticking bomb; a short lifetime seals the loss window shut.
5. **Protection rules apply to administrators too**: the bypass list on branch protection must be empty. Rationale: if the rules make an exception for the owner, the agent will eventually "borrow" that exception — there is no "trusted humans may bypass" in a security design.
6. **Swap agents, not the spec**: this document is the single source of truth for handover; a new agent must read it in full and confirm before starting work. Rationale: verbal agreements die with personnel changes; written specs don't.

## 3. Credential Model

| | Per-repository credential | Shared push credential |
|---|---|---|
| **Form** | Fine-grained personal access token | Fine-grained personal access token |
| **Visibility** | Held encrypted by the agent platform; the agent never sees the plaintext and calls only through the platform gateway | Handed to the agent directly by the owner (one plaintext handoff) |
| **Scope** | Contents, Pull requests, Actions, Workflows — read/write | Contents read/write only |
| **Effective against** | Exactly one repository; one key per repository | Shared across repositories (currently three) |
| **Lifetime** | Managed by the platform; long-lived but revocable and rebuildable at any time | At most 7 days, rotated on expiry |
| **Used for** | Opening PRs, checking CI status, updating branches, merging PRs, re-running Actions, editing `.github/workflows/` | HTTPS `git push` of ordinary files only |
| **Stored in** | Platform-encrypted storage | The agent's git credential helper |

**Must**: when writing to a repository, use that repository's credential. Using another repository's credential — or a generic portal credential — is forbidden. Rationale: one-to-one binding between credential and repository makes every write attributable; mixing them lets one leak compromise several repositories at once.

**Must**: the two credential types are never mixed. The shared push credential must not be used for API calls, workflow edits, Action re-runs, or ruleset changes; per-repository credentials must not appear in the git transport layer (never embedded in remote URLs). Rationale: mixing them lets a single leak compromise both planes; workflow files decide what CI runs, so the power to edit them belongs on the same key as the power to merge.

**Why not SSH deploy keys**: the agent's runtime environment may block the SSH protocol at the egress proxy (only HTTPS passes), in which case deploy keys are entirely unusable. Deploy keys remain a future option — only if and when the network permits SSH, and still one key per repository. Rationale: the choice must be grounded in "what actually works on this network," not "what is elegant in theory."

**Rules for editing `.github/workflows/`**:

1. **Should** edit locally and verify before submitting. Rationale: a broken workflow paralyzes the entire CI pipeline; local verification is the last line of defense.
2. Submissions **must** use the corresponding repository's per-repository credential (`git push` or the Contents API both acceptable). Rationale: the authority to edit workflows and the authority to merge PRs belong on the same key; the shared push credential lacks it.
3. **Contents API vs. Git Data API**:
   - The Contents API is a single-file commit endpoint: one file per call, producing an ordinary commit on the normal git history. **Permitted** for single-file workflow edits when `git push` is rejected for insufficient scope.
   - The Git Data API allows creating commits on the remote without local git history (building blobs / trees / commits, rewriting refs), bypassing local tests and commit review; the resulting commits cannot be reproduced or verified locally. **Forbidden** for any write on any branch.
   - Rationale: Contents API results are equivalent to a local `git commit + push` — auditable and reproducible; the Git Data API bypasses local history and is not. The former is allowed to solve a permission problem, not to bypass process.

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
3. **`git push` the feature branch**: HTTPS with the shared push credential for ordinary files; the per-repository credential is required when touching `.github/workflows/`. Pushing main is forbidden.
4. **Open the PR**: prefix the title with version/type; describe any anomalies encountered during development (CI failures, what was fixed) truthfully — no omissions. Rationale: the PR description is an audit record; hiding anomalies is falsifying the audit.
5. **Stage files individually — bulk staging is forbidden**: `git add -A` / `git add .` are **forbidden**; stage with explicit filenames and always review `git status` before committing. Rationale: bulk staging smuggles placeholder files, local build artifacts, or unintended edits into the commit — this has actually shipped an unfinished placeholder to main.
6. **Wait for CI**: no merge actions before CI reports; on failure, diagnose locally, apply a genuine fix, then push. **Forbidden**: re-running someone else's failed job to "go green," deleting tests, lowering thresholds, or editing tests to accommodate the implementation (a failing test means the implementation is wrong — fix the implementation).
7. **New tests must be wired into CI**: passing locally does not count. Rationale: a local pass proves "it worked this once"; CI wiring proves "it works every time." A test that never runs in CI is no test at all.
8. **When the branch falls behind main**:
   - No conflicts: sync via the update-branch API.
   - Conflicts: resolve with `git merge main` locally, run the full test suite, ordinary `git push` (force push forbidden).
   - Cannot resolve: stop, report the conflict details to the owner, do not route around it.
9. **Merge after green CI**: merge the PR via the merge API (merge-commit method).
10. **Verify live**: after merging, confirm the production deployment succeeded and run smoke checks (homepage status, key endpoints); report problems immediately.
11. **Every delivery must report**: repository name, PR number, CI run number, outcome (success/failure), HEAD commit. Rationale: the owner traces any change by these four elements; one missing breaks the chain.

## 6. Owner Checklist

- [ ] **Issue / renew / revoke the shared push credential**: issue a fresh one before expiry; revoke immediately on suspected compromise, then notify the agent the old credential is dead.
- [ ] **Maintain per-repository credentials**: rebuild promptly on expiry or platform changes so the agent's PR / merge / workflow operations never break.
- [ ] **Maintain branch protection rules**: when CI pipelines rename or add/remove checks, sync "required status checks" the same day (otherwise merging blocks forever — see §4).
- [ ] **New-repository admission**: a new repository must have protection rules in place *and* its own per-repository credential before joining the shared push credential. **Forbidden**: adding an unprotected repository to the shared credential — one key opening many locks only works if every lock is sound.
- [ ] **Merge confirmation**: human confirmation before merging high-risk PRs (auth changes, deployment config).
- [ ] **Real-device acceptance**: changes requiring a physical device or the production environment (mobile interactions, lock-screen flows) are acceptance-tested by the owner on production before the merge is confirmed.

## 7. Agent Duties and Prohibitions

**Do**:

- Push only feature branches; record anomalies truthfully in PR descriptions; diagnose CI failures locally before fixing; when a token expires, request a new one from the owner and nothing else; report repository, PR, run number, and outcome on every delivery.

**Self-service for permission errors**:

On 403 or "without workflow scope" errors, the agent **must** work through this sequence itself — **forbidden** to interrupt the owner directly:

1. Verify which repository's credential is in use, and whether the wrong repository's credential — or the shared push credential — was picked up by mistake.
2. Switch to the correct repository's per-repository credential and retry once.
3. If two attempts under these rules still fail, report to the owner: the full error text, which credential was used (described as "repository X's per-repository credential / the shared push credential" — never the real name), and which step failed.

Rationale: permission errors are usually a wrong key, and the agent can fix that alone; interrupting the owner for self-serviceable problems burns the owner's attention on noise.

**Changes requiring real-device acceptance**:

1. Open a draft PR first; notify the owner once CI is green.
2. The owner acceptance-tests on production (e.g., interaction smoothness on a Samsung browser, lock-screen flows).
3. Convert to a formal PR and merge only after acceptance passes; on failure, open a revert PR — rollback takes minutes.

Rationale: sub-site session credentials only work under the official domain; preview domains cannot obtain the main site's unlock credential, so protected pages redirect straight to the lock screen and nothing can actually be verified. Changes of this kind also fall back to full-page navigation automatically on failure, so the risk is contained and rollback is cheap.

**Do not**:

| Prohibition | Rationale |
|-------------|-----------|
| Push to main | Main is entered only via PR — §2, principle 3. |
| Force push | Rewrites pushed history and breaks the audit chain; the protection rules forbid it anyway. |
| Any write via the Git Data API | Bypasses local history and tests; irreproducible — see §3. |
| Mix the two credential types | Widens the blast radius of a single leak — see §3. |
| Use the shared push credential for workflows / Action re-runs / rulesets | It lacks those scopes — see §3. |
| Print tokens, or embed them in remote URLs / repo files / logs / PR descriptions | Any persistence or propagation of a token is a leak. |
| Switch channels on your own when a token expires (e.g., move to SSH, switch APIs) | The credential channel is the owner's decision; the agent has no standing to choose. Stop and request a new token. |
| Append commits to a PR after confirmation | The merged code must match what was confirmed; to change it, open a new PR or re-confirm. |
| Conceal CI failures or test gaps | The audit record must be truthful — §5, step 4. |
| `git add -A` / `git add .` | Smuggles placeholders and local artifacts into the commit — §5, step 5. |
| Update existing visual baselines | A baseline is the answer key for "what correct looks like"; updating it means changing the answer. Only add baselines for new pages. On visual failures, investigate common causes first (font environment, data-source drift) instead of suspecting the baseline. |
| Edit tests to accommodate the implementation | Tests are the executable form of requirements; a failing test means the implementation is wrong — fix the implementation. |
| Ship new tests without CI wiring | A test that never runs in CI is no test at all — §5, step 7. |

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

- [ ] Revoke the old shared push token (owner).
- [ ] Re-register per-repository credentials on the new agent platform (owner).
- [ ] Issue a new shared push token to the new agent (owner).
- [ ] The new agent reads this whitepaper in full and confirms understanding to the owner (in writing).
- [ ] The new agent runs the full loop — push → open PR → CI → close PR — on an empty feature branch (a one-line comment change), proving both credential planes work.
- [ ] After the dry run succeeds, delete the per-repository credentials held on the old agent platform.

**Forbidden**: skipping step 5 and handing production PRs straight to the new agent. Rationale: handover verification must be done with harmless operations — never practice on a real release.

## 10. Appendix

### A. Ruleset configuration item by item

See the branch-protection table in §4. Notes: ruleset enforcement set to Active; bypass actors is an empty array; `required_status_checks` lists the check names from the §4 table; `required_pull_request_reviews` sets `required_approving_review_count` to 0 with no extra restrictions beyond dismissing stale reviews (single-maintainer repository).

### B. git credential configuration example

The shared push credential is stored once, not per repository (one shared token across repositories):

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
| v2.0 | 2026-10-11 | Credential model refined: per-repository credentials (Contents/PR/Actions/Workflows read-write, effective only against their own repository) vs. shared push credential (Contents read-write only, ordinary file pushes only); new workflow-editing rules (Contents API permitted, Git Data API still forbidden); new self-service flow for permission errors; new prohibitions: `git add -A`, updating visual baselines, editing tests to fit implementations, shipping tests without CI wiring; new real-device acceptance loop (draft PR → production acceptance → revert rollback); every delivery must report repository/PR/run/outcome. |
| v1.0 | 2026-10-11 | Initial release: dual-credential model, branch protection rules, standard dev loop, rotation and handover checklists. |

---

*This document supersedes v1.0; v1.0 is retained as a historical version.*

*The execution agent must read this document before starting any repository work. Where this document conflicts with the owner's ad-hoc instructions, the owner's latest written confirmation prevails.*
