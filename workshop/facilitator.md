# Facilitator script

## Learning contract

Audience: DuckDB developers who know columnar execution but may not have followed
the complete persistent-storage path. Assume SQL, vectors, and transactions are
familiar; do not assume familiarity with codec on-disk structs.

By the end, attendees should be able to:

1. Navigate table → row group → column stream → segment → allocation.
2. Distinguish database-file writes, transaction durability, and checkpoint publication.
3. Explain the selection scope and the output/read contract of representative codecs.
4. Reconcile SQL storage metadata with a checkpoint's physical map without inventing sizes.
5. Formulate a testable design question about selection sampling or auxiliary storage.

The **full spoken track is in `slides.md` after each `Notes:` marker** and appears
in Reveal's speaker view (`S`). This document adds timing, stage directions, the
answer-key locations, and optional cuts rather than maintaining a second copy of
every speech paragraph.

## Before the room opens

- [ ] Install dependencies, build the deck, run browser smoke tests.
- [ ] Generate a NEW fixture directory with `--overflow`; inspect `manifest.json`
      for `complete: true`. Keep the recorded version and settings with the files.
- [ ] Open every snapshot in Atlas. Check row-group links, recorded segment extents,
      overflow references, free-list view, and physical/live row counts. Unknown
      ranges are not errors to hide; know which ones the demonstration will show.
- [ ] Read `demos/README.md` against your own logs. Choices and file sizes can change;
      do not present the documented rehearsal as the output of a different binary.
- [ ] Start the deck and Atlas in separate tabs. Open the speaker popup and test
      projector placement. Keep the speaker notes on the private display.
- [ ] Distribute the nine snapshots (seven for the short route), handout, and query logs.
- [ ] Keep prepared Atlas tabs for sorted/shuffled, bulk/append, and churn snapshots.
      Tabs are independent views, not concurrent writers.
- [ ] Leave a CLI with `inspect.sql` ready in read-only mode; avoid personal startup files.
- [ ] Keep `demos/README.md` available as the textual fallback/answer key.
- [ ] Do not rely on live extension downloads, rebuilding DuckDB, or internet access.

## 90-minute run of show

Slide references are stable hash IDs; prepend `/#/` in the deck. Times include
questions and browser switching. Six numbered chapter dividers provide brief visual
pauses before the major sections; advance through them without adding lecture time.
Times and existing content-slide IDs are unchanged. Stop on time instead of reading
every note verbatim.

| Clock | Slides | Action / pacing |
|---|---|---|
| 00:00–05:00 | `title` → `columnar` | Opening prediction; no answer yet. State version boundaries. Columnar refresher ≤1 min. |
| 05:00–17:00 | `coordinates` → `accounting` | Logical/physical model. One pointer walk in Atlas, ≤90 sec. |
| 17:00–32:00 | `three-events` → `history-lab` | Trace writes/publication. Last 3 min: guided bulk/append comparison. |
| 32:00–55:00 | `selection` → `developer-contract` | Selection first, then codec/layout/read contracts. About 2 min per codec slide; don't enumerate structs. |
| 55:00–72:00 | `sql-tools` → `overflow-lab` | 6 min tools/navigation, 8 min paired order exercise, 3 min overflow comparison. |
| 72:00–82:00 | `churn-model` → `churn-debrief` | 2 min model, 6 min predictions/inspection, 2 min debrief. |
| 82:00–90:00 | `sampling-future` → `takeaways` | 3 min sampling, 3 min auxiliary design, 2 min close/Q&A. |

### 00:00 — Open with a falsifiable question

Say: **“I have two files containing the same rows. Before opening either, tell me
which properties of their storage must be equal.”**

Show `puzzle`; accept answers about codec, file size, row-group count, and value
ranges. Write two competing predictions down. Do not reward a lucky codec guess;
ask what property of the input motivates it.

Follow with the workshop contract: **“We will explain bytes and references. We
will not infer query speed from file size.”**

Transition: **“Before following a write, let's agree on what its output objects are.”**

### 05:00 — Establish the model, then navigate once

Use `coordinates` to draw the logical/physical distinction. Ask:

- Can two columns share a block? Yes.
- Must their segments cover identical row ranges? No.
- Must every segment have a block? No: constants.
- Can a primary segment refer to other blocks? Yes: codec-owned auxiliary storage.

At `streams`, ask attendees what a validity row means before explaining it. Introduce
nested children only enough to avoid treating all counts as parent-table rows.

**Atlas choreography:** open `01-sorted.duckdb`, show the header strip separately
from block tiles, click a row group, select a `value` segment, follow its physical
pointer. Do not reveal the cross-file compression comparison yet. Return to the
deck and `shared-block` immediately.

At `accounting`, get explicit agreement on four measurements: payload, codec-owned
allocations, total allocated block capacity, and whole-file size. Unknown data is
not an invitation to estimate from adjacency.

Transition: **“That is the snapshot. Now which operations could have put it there?”**

### 17:00 — Trace the lifecycle, not just SQL statements

Use `three-events` as the anchor for the whole section. Ask the room to place
“commit”, “block write”, and “checkpoint” on a timeline; explain why there is not
one universal ordering that collapses all three.

For `write-paths`, contrast the normal small append path with eligible bulk writes.
Keep WAL details only as deep as needed to show durability and visibility. Avoid
“COPY always does X” or “commit always does Y”. The source map is for follow-up.

At `checkpoint`, ask: **“I changed force_compression and called CHECKPOINT. Why is
the old codec still there?”** Expected answer: unchanged payload can be reused.

At `publication`, point back to the previous checkpoint root. A block cannot be
reused simply because the new logical state no longer wants its old contents.
This is the causal bridge to the free list and later churn exercise.

**History demo (3 min):**

1. Open `02-bulk` and `02-append` side-by-side.
2. Predict whether ten transactions imply ten row groups.
3. Color by row group; inspect the stored spans and the payload's block links.
4. Check whole free blocks, not pale gaps inside live blocks.
5. Reveal the observed spans from the current logs. In rehearsal, both had three
   groups; the boundaries and physical allocation differed.

Say: **“We controlled threads and rows. We changed checkpoint history. This is not
an INSERT-versus-CTAS speed test.”**

Transition: **“Now follow the column rewrite into the decision that chooses its bytes.”**

### 32:00 — Repeat one template for each codec

Start with the selection pipeline and name its decision scope. For every family,
keep the same five questions visible in your own notes:

1. Which local data property helps?
2. What does analysis learn or estimate?
3. What structures are persisted in the primary segment?
4. Is there auxiliary state or a distinct validity representation?
5. What happens on sequential scan and on point access?

Concrete prompts:

- **Constant/RLE:** “Do repeated values still need one value slot per row?”
- **BitPacking:** “Which outlier would make the local width larger?”
- **Dictionary/FSST:** “Are we reusing complete values or byte sequences?”
- **DICT_FSST:** “Does this codec name imply all its structures exist in every mode?”
- **ALP:** “Where is the information that makes the transformation lossless?”
- **Overflow/ZSTD:** “Does a small primary segment mean a small total footprint?”
- **Read path:** “How much decoding does one requested row cause?”

Use the two actual-layout diagrams (RLE and BitPacking) deliberately; they show
separate streams and reverse metadata. Do not spend time reading every field
width. ALP details are appendix material.

At `developer-contract`, ask for one test outside the compression loop. Good
answers: partial scan, nulls, segment crossing, reopen, version gate, corruption,
auxiliary block reclamation. Emphasize internal API, not a stable plugin ABI.

Transition: **“We now have enough vocabulary to investigate without guessing.”**

### 55:00 — Put the tools in attendees' hands

Show `sql-tools` using the read-only command in `demos/README.md`. Distinguish value
rows from validity rows. Display `SELECT *` once so participants see the available
schema rather than assuming every engine has identical columns.

At `limits`, explicitly say: **“There is no exact segment-length column in this
pragma on this build. We are not going to manufacture one by subtraction.”**

**Atlas navigation rehearsal (≤2 min):**

1. Select snapshot; expand summary.
2. Physical map → row-group colors.
3. Logical map → one `value` segment.
4. Follow block link → byte strip → other owners.
5. Point out constants, recorded sizes, and unknown coverage.

**Order lab (8 min):** pairs use the participant handout. Allow five minutes of
inspection, then solicit one three-sentence explanation and one uncertainty.
Rehearsal answer: sorted `value` used RLE, shuffled `value` BitPacking; sorted ranges
were much narrower. The ID column's order also changed. File-byte savings cannot
be attributed solely to one column's exact payload. Verify against today's logs.

**Overflow comparison (3 min):** open the optional pair. Rehearsal: uncompressed
payload referenced 47 additional blocks, ZSTD needed none. Immediately add:
**“ZSTD supports auxiliary pages; this particular input fit without them.”**
The input is intentionally repetitive, not representative production text.

Transition: **“A freshly loaded file is the easy case. Let's make its history visible.”**

### 72:00 — Churn without false reclamation claims

Explain deletion visibility versus stored value spans. A checkpoint may compact
some groups, remove full groups, and leave other partially deleted spans intact.
Neither “always removes holes” nor “never compacts” is correct.

**Churn lab (6 min):**

1. Baseline: ask for expected live and stored rows.
2. Before showing deleted: collect predictions for file bytes, free blocks, and
   stored spans. Then inspect the Free list and row-group counts.
3. Before showing refill: ask whether every free block must be consumed before
   growth. Reveal current observations.
4. Connect publication timing to the free blocks visible only at the end.

Rehearsal answer key is in `demos/README.md`; do not recite all numbers. The memorable
surprise is that deletion left file size unchanged and refill grew the file while
free blocks remained. This is a valid observation, not evidence of a bug by itself.

Say: **“This map is a state snapshot. If we want exact allocation chronology, we
need instrumentation or a trace—not a more confident interpretation of the colors.”**

Transition: **“Which part of this pipeline would we redesign first?”**

### 82:00 — Turn future directions into design questions

**Sampling (3 min):** spend 90 seconds on an adversarial-input challenge. A random
sample may destroy run information or miss long strings. Ask which checks must
remain exhaustive, and what fallback prevents publishing an invalid encoding.
Distinguish the proposal from codec-local samples already in the baseline.

**General auxiliary storage (3 min):** ask who owns allocation, visitation,
serialization, prefetch, and retirement. A page-allocation helper alone is not a
complete design. Ask attendees to choose one metric and one invariant for a proposal.

**Close (2 min):** return to the opening predictions. Ask one participant to explain
the files through the five closing questions. Leave `takeaways` visible for Q&A;
do not advance into the appendix automatically.

## 60-minute route

Use the same files and slide IDs, but skip slides explicitly rather than rushing.
A Reveal overview (`Esc`) or the following hash link makes jumps easy.

| Clock | Route / cuts |
|---|---|
| 00–04 | `title`, `puzzle`, `columnar`; skip the 90-minute route table |
| 04–13 | `coordinates`, `file-map`, `metadata`, `shared-block`, `accounting`; explain validity verbally |
| 13–23 | `three-events` → `history-lab`; one-line publication explanation, 2-minute history demo |
| 23–39 | `selection`, `scores`, `families`, `constant-rle`, `bitpacking`, `dict-fsst`, `read-path`; describe FSST/ALP/overflow verbally |
| 39–50 | `sql-tools`, `limits`, `atlas`, `order-lab`; allow 6 minutes for the exercise |
| 50–55 | `churn-model`, `churn-lab`; facilitator demo, not independent exercise |
| 55–60 | `sampling-future`, brief verbal auxiliary proposal, `takeaways` |

Keep the opening prediction, accounting caveats, selection scope, and one genuine
hands-on exercise. Those are higher priority than an exhaustive codec inventory.

## Failure and interruption plan

- **CLI unavailable / incompatible:** use the pre-generated snapshots plus logs;
  do not silently change storage target during the workshop.
- **Atlas cannot decode a range:** show its unknown state. Continue with SQL and
  known extents. A fallback sidecar is not evidence of exact segment byte sizes.
- **Browser/demo failure:** use the observed-output tables and SQL logs. The slide
  schematics are explanatory, not screenshots of measured allocations.
- **Speaker popup blocked:** permit popups for localhost, or open `slides.md` notes
  / this script on a second device. Do not spend exercise time debugging displays.
- **Unexpected codec choice:** inspect the current binary, target, settings, and
  candidate behavior. Treat the output as the experiment, not an incorrect answer.
- **Too much discussion:** cut ALP details, overflow lab, and appendix before cutting
  the order exercise or replacing unknowns with guesses.

## Questions worth saving for a follow-up

Full recovery protocol, ART allocator internals, nested/VARIANT encodings,
checkpoint-vacuum heuristics, concurrent checkpointing, encryption, and performance
measurement each deserve their own session. Keep them on a visible parking list.
