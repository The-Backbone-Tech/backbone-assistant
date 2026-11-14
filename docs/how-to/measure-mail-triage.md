# How to measure the mail triage job

**For:** someone checking whether the mail triage job does the job, and how it compares with the same job done without Backbone. **Time:** about a minute with the scripted model; half an hour or more with a local model.

**Before you start:** Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`; see [install and open the app](install-and-open-the-app.md), steps 1 and 2). The data folder's embedded PostgreSQL listens on `127.0.0.1`. No network, key or account is needed for the steps that run in CI.

The fixture is the sample mailbox's: 47 incoming requests to a small studio, in English and Spanish, each labelled with its requester, category, urgency, expected label or move, whether it needs a reply, and what a usable reply must and must not say (`packages/modules/connector-mail/fixture/`). The job, the model and the baseline never see the labels; only the scorer reads them.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

1. Run the job on the first eight requests with the scripted model, export the raw mailbox a baseline would get, and score the job blind. The scripted model decides by fixed keyword rules, so this proves the plumbing (engine, gateway, receipts, brief), not judgement.

   ```bash test
   out=$(mktemp -d)
   node scripts/no-leftovers.mjs node packages/platform/examples/measure-triage.ts job --out "$out/job" --limit 8
   node packages/platform/examples/measure-triage.ts export --out "$out/raw" --limit 8
   test "$(ls "$out/raw/mailbox" | wc -l | tr -d ' ')" = 8
   node packages/platform/examples/measure-triage.ts score --limit 8 --out "$out/scores" "$out/job"
   test -s "$out/scores/judge-packet.json" && test -s "$out/scores/sealed-key.json"
   rm -rf "$out"
   ```

   You see one line per arm, under an anonymous id, for example:

   ```text
   arm-A: requester 100%, category 87.5%, urgency 75%, all three 62.5%, … ms/request median 70 (wall 300)
   judge packet: 6 drafts; scores, packet and sealed key in …
   ```

2. Measure with a real model on this computer. Any OpenAI-compatible server on the loopback works; with Ollama, start it and pull a model you choose, then run both arms on the same model, so the comparison measures the job and not the model:

   ```bash
   ollama serve &
   node packages/platform/examples/measure-triage.ts job --out evidence/triage-measure/job --endpoint http://127.0.0.1:11434/v1 --model gemma4:e4b
   node packages/platform/examples/measure-triage.ts baseline --out evidence/triage-measure/baseline --endpoint http://127.0.0.1:11434/v1 --model gemma4:e4b
   ```

   The baseline is the same model in a plain loop: one raw message at a time and the same task text, with no connector, no receipts and no brief.

   The baseline saves a checkpoint after each request and stops after 90 minutes. Use
   `--deadline-ms` for a shorter deadline (milliseconds, at most 5400000). Expiry aborts
   the in-flight request, preserves completed outputs and exits nonzero. An incomplete
   checkpoint is failure evidence, not a completed comparison; retain it in its own
   folder before any new run.

3. Optionally, give a fresh coding agent the raw mailbox (`export`), in a new session with no memory of this repository, and ask it to follow `TASK.md`. Its `out/*.json` files form a third arm; put an `arm.json` with its name and model beside them.

4. Score every arm together. Each gets an anonymous id; the classification is scored by the script; the drafts go into a shuffled packet with the arms hidden:

   ```bash
   node packages/platform/examples/measure-triage.ts score --out evidence/triage-measure/scores evidence/triage-measure/job evidence/triage-measure/baseline
   ```

5. Give `judge-packet.json` to a judge who wrote neither the fixture nor either arm (a fresh agent in a new session, later a person). They write `judgements.json` by the packet's rubric. Then reveal which arm wrote what:

   ```bash
   node packages/platform/examples/measure-triage.ts reveal --out evidence/triage-measure/scores --judgements evidence/triage-measure/judgements.json
   ```

## What you now have

For each arm: requester, category and urgency accuracy (and all three together), label and move accuracy, the reply decision, suspicious messages caught, machine time per request, and for the job, interruptions (questions that block work, and notices) and review touches (proposals and needs-you items). After the judge: the share of drafts usable as is or with light edits, and any critical error. The pass criteria these are held to are the distribution's ([acceptance/J-triage/job.md](../../acceptance/J-triage/job.md)).

## What next

- The job, its formation and its brief: [packages/platform/README.md](../../packages/platform/README.md), "Mail triage".
- The connector and its fixture: [packages/modules/connector-mail/README.md](../../packages/modules/connector-mail/README.md).
