# Migration guide — monorepo cutover

This package restructures `group-insurance-pulse` into the single codebase for
both shows. Your current `main` branch and scheduled workflows stay untouched
until you decide to cut over.

## Step 1 — create the feature branch

On your machine (or in GitHub Codespaces):

```bash
git clone https://github.com/sunisankara/group-insurance-pulse.git
cd group-insurance-pulse
git checkout -b monorepo-migration
```

## Step 2 — lay the new code over the branch

Unzip `pulse-engine.zip` into the repo root, then remove the old engine:

```bash
unzip ~/Downloads/pulse-engine.zip -d /tmp/pe
cp -r /tmp/pe/engine /tmp/pe/shows /tmp/pe/scripts /tmp/pe/.github /tmp/pe/.gitignore \
      /tmp/pe/package.json /tmp/pe/tsconfig.json /tmp/pe/README.md \
      /tmp/pe/smoke-test.ts .
rm -rf headless.ts services utils types.ts vite.config.ts podcast.yml metadata.json \
       .github/workflows/dailypodcast.yml .github/workflows/podcast.yml \
       .github/workflows/test-cron.yml
```

Do NOT touch `rss/` — the existing `feed.xml`, `episodes.json`, and MP3s stay
exactly where they are. The new engine reads the same `rss/episodes.json` for
dedup continuity, and the feed URL does not change.

## Step 3 — push and dry-run

```bash
git add -A
git commit -m "Monorepo: single pulse engine for both shows"
git push -u origin monorepo-migration
```

Then in GitHub: Actions → "Daily Pulse — Group Insurance" → Run workflow →
`dry_run: true`. Read the generated script in the run log. Repeat for healthcare.
Nothing is synthesized, committed, or published in dry-run mode.

## Step 4 — live test (optional, one show)

Run the workflow with `dry_run: false` for group-insurance once. It will
generate, commit the MP3 + feed update to the *branch*, and you can listen
before merging. Your scheduled `main` workflow keeps publishing the old
episodes in the meantime.

## Step 5 — cut over

Merge the branch to `main` (PR or direct). The old workflows are gone from the
branch, so only the two new ones run. Healthcare's feed appears at
`rss/healthcare/feed.xml` — do the one-time Spotify dashboard feed-URL update
for the healthcare show.

## Revert

- **Before merge**: delete the branch. `main` is byte-identical to today.
- **After merge**: `git revert` the merge commit, or redeploy from the
  `healthcare-pulse-podcast` repo which remains untouched as a cold spare
  until you archive it.

## What I could not do from here

I have no write access to your GitHub, so steps 1–5 are yours (about 15
minutes). I also could not run a live end-to-end generation — that needs your
`API_KEY` secret, which already exists in the repo. The dry-run in Actions is
the right first live test.
