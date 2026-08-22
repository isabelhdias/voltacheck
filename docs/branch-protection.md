# Protecting `main`

`main` is what GitHub Pages serves. A bad push is live immediately, and
Isabel cannot run anything locally to catch it first — CI is the only check
there is. So nothing pushes to `main` directly: every change goes on a
branch, opens a pull request, and Isabel merges it.

This is a repository **setting**, not code. It has to be switched on by hand
in GitHub's web UI, once. Agents cannot do it: the GitHub integration these
sessions run through has no branch-protection tool, and direct API calls to
the settings endpoints are refused.

> **Status:** written up when Isabel asked for it on 22/08/2026. If the
> rules below aren't showing under Settings → Rules → Rulesets, they were
> never applied — follow the recipe.

## What this actually buys

Isabel is the only collaborator on the repo, and she's an admin. Nobody
else can push or merge today, and a protection rule doesn't change that —
**merge rights come from repository permissions, not from protection
rules.** If a second person is ever added, the way to keep merges Isabel's
is to give them Read or Triage, not Write.

What the rule stops is the two things that *can* happen now:

- an **agent** pushing to `main` — this project is worked entirely through
  agents, and they had a straight line to the live site;
- an **accidental** push or force-push from Isabel's own account.

After it, both of those land as a pull request instead, where CI runs and
Pages builds a preview before anything reaches the live site.

## The recipe

Settings → Rules → Rulesets → **New ruleset** → *New branch ruleset*.

| | |
|---|---|
| Name | `protect main` |
| Enforcement status | **Active** |
| Bypass list | **leave empty** |
| Target branches | Add target → **Include default branch** |

Then tick, under Rules:

- **Restrict deletions**
- **Block force pushes**
- **Require a pull request before merging**
  - Required approvals: **0**
  - Leave the rest of that block unticked
- **Require status checks to pass**
  - Add checks → search `Test` → pick it (that's the job in `ci.yml`)
  - Tick *Require branches to be up to date before merging*

**Create**.

Two of those choices are load-bearing:

- **Bypass list empty** is the whole point. Anything in it — "Repository
  admin", an app — is a hole an agent's token can fit through, and "no one
  can push to `main`" stops being true.
- **0 required approvals** because GitHub won't let you approve your own
  pull request. Agent commits are pushed under Isabel's account, so a PR
  that needs one approval would be a PR she can't approve and can't merge,
  with no bypass to rescue it. Zero still forces every change through a PR
  she has to merge deliberately — it just doesn't demand a second person
  who doesn't exist.

The older screen, Settings → Branches → *Add branch protection rule*, does
the same job; "Do not allow bypassing the above settings" is that screen's
version of an empty bypass list. Use one or the other, not both.

Locked out? Isabel is an admin: Settings → Rules → the ruleset →
Enforcement status → **Disabled** turns it off from a phone in three taps.

## What this does not break

Checked against every workflow in `.github/workflows/` before it was
turned on:

- **`ci.yml`** already runs on `pull_request` against `main`, so PRs get
  the full unit + integration + e2e suite. Without that trigger a required
  status check would never report and every PR would hang unmergeable —
  it's there, so they don't.
- **`pages.yml`** already builds a preview of every open PR at
  `/preview/pr-N/`, so a change is *visible* before it's merged. Publishing
  the live site is a Pages deployment, not a push to `main`, so protection
  doesn't touch it.
- **`migrate.yml`** is manual-dispatch only.
- **`review-queue.yml` / `review-apply.yml`** only read the database and
  write issues.

Nothing in the repo pushes commits, so nothing needed changing to make this
work.

## What it changes day to day

Agents branch, push the branch, and open a PR. Isabel gets a link with
green CI and a preview URL beside it, looks at the preview on her phone,
and taps Merge. Same review she was doing on the live site, one step
earlier — and a red PR is now a PR that can't land rather than a live site
that's already broken.
