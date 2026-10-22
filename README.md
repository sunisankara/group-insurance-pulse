# Pulse Engine

Single codebase for **Group Insurance Daily Pulse** and **Healthcare Daily Pulse**.
One shared engine, per-show configuration — no more duplicated code drifting apart.

## Layout

```
engine/            # shared pipeline: news recall → ranking → script → TTS → audit → RSS
shows/
  group-insurance/ # show.yaml, hosts.md (character bibles), lenses.md, news.md
  healthcare/      # show.yaml, hosts.md, lenses.md, news.md
scripts/           # prune-audio.mjs — keeps the repo from growing forever
.github/workflows/ # pulse-group-insurance.yml, pulse-healthcare.yml (thin wrappers)
rss/               # group-insurance feed (URL unchanged) + episodes.json
rss/healthcare/    # healthcare feed
```

## What changed vs the old code

- **Voice consistency**: one TTS call per story segment instead of per 1000-char
  chunk — this was the root cause of voices drifting mid-episode.
- **Distinct voices per show**: group keeps Aria=Kore / Dorian=Puck; healthcare
  moves to Alex=Charon / Sam=Aoede.
- **Character bibles** (`hosts.md`): backstory, speech patterns, how the duo argues.
- **Lens rotation** (`lenses.md`): the ranker assigns each story an analytical lens
  (CFO, Regulator, Broker, …) so episodes stop being the same two perspectives.
- **Two-stage news**: broad recall (10–12 candidates) → explicit rubric ranking → top 5.
  Also fixes the date filter breaking on the 1st of each month.
- **Text-based audit**: no more uploading the finished MP3 to Gemini twice per
  episode; duration estimate, speaker labels, cross-segment repeat detection, all
  on the script text. On failure the *script* is regenerated (the old loop
  re-recorded identical audio, which could never fix anything).
- **Repo hygiene**: `.gitignore` for temp PCM files, MP3 pruning (keeps 30 newest
  per feed — Spotify already caches the rest), single workflow per show, dry-run
  mode actually wired up (`IS_DRY_RUN=true`), non-zero exit on failure.

## Oct 2026 fix package (quality gate + humanization)

Shipped after the Oct 21 stub episode (1.9 min) and a run of episodes ending
mid-sentence. Root causes found: Gemini 2.5 Flash "thinking" tokens silently
ate the script output budget (truncation at random lengths, no finishReason
check), and the audit was advisory — `run.ts` published failing scripts
anyway ("continuing with issues").

- **Thinking off, truncation is an error**: all text calls use
  `thinkingConfig.thinkingBudget: 0`; a non-STOP finishReason fails the attempt.
- **The audit is a hard gate** (`audit.ts`): duration band, speaker labels,
  completeness (terminal punctuation + a real sign-off — name-check closes
  count), no markdown structure lines, an AI-tell phrase banlist, and
  cross-episode checks (signature host devices and recycled phrasing vs the
  last 3 episodes). Nothing publishes unless the script passes.
- **Fallback chain** (`run.ts`): fresh script ×3 → **digest episode**
  (`digest.ts`, a look-back built only from the show's own recent episodes,
  excluded from the story-dedup corpus) ×2 → **skip the day** (exit 1).
- **Humanization**: conversation rules demand hard turn-length variance,
  interruptions, contractions, one falsifiable take per host; episode shapes
  and cold opens rotate by day; the previous episode's stories + closing
  exchanges feed in as continuity for (at most) one natural callback.
- **Character bibles rewritten**: hosts' grounding devices rotate and the
  first-person anecdote ("I was in a room...", "med-surg floor") is rationed —
  the old bible literally prescribed Dorian's room anecdote as his opener,
  quoted verbatim, which is why it aired daily. Example opener lines are no
  longer quoted in the bibles (models copy quoted examples verbatim).
- **Audio realism**: ~0.45s silence between segments, loudnorm mastering.
- **Feed hygiene**: real enclosure `length` (bytes) and `itunes:duration`
  from the mastered MP3, backfilled for older episodes whose files are local.

## Run locally

```bash
npm ci
npx tsx engine/run.ts --show group-insurance --dry-run   # script only, no audio
API_KEY=... npx tsx engine/run.ts --show healthcare      # full run
npm run typecheck && npx tsx smoke-test.ts               # tests
```

## Test in GitHub Actions without publishing

Actions → "Daily Pulse — Group Insurance" → Run workflow → `dry_run: true`.
The script prints to the run log; nothing is synthesized or committed.
