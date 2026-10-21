# CLI storage workshop: values, persistence history, and churn

Three small, synthetic exercises for **DuckDB File Atlas**. Python standard
library + a DuckDB CLI only; no npm, extensions, downloads, or benchmarks.
Each snapshot contains one table, `t`. The two comparison pairs use identical
logical data; the churn snapshots intentionally change the live data.

## Generate before presenting

From the repository root:

```sh
python3 workshop/demos/generate.py \
  --duckdb /Users/sgerrits/repos/duckdb/build/reldebug/duckdb \
  --out /tmp/atlas-workshop-01

# Optional separate overflow pair; use a NEW directory:
python3 workshop/demos/generate.py \
  --out /tmp/atlas-workshop-with-overflow --overflow
```

`--out` is required. **Existing directories (even empty ones) and symlinks are
refused**, not cleaned or reused. The default CLI is
`~/repos/duckdb/build/reldebug/duckdb`, then `~/repos/duckdb/build/release/duckdb`,
then `duckdb` on PATH. `--duckdb /absolute/path` overrides this choice.

The generator requests `STORAGE_VERSION 'v2.0.0'` explicitly at attach time
(Atlas format 69). Use a CLI supporting that request; it does not silently
fall back to an older format. Every writer uses one thread, preserved insertion
order, a 512 MB memory limit, a 1 GB automatic-checkpoint threshold, and explicit
checkpoints. The high threshold avoids accidental intermediate auto-checkpoints
in these small workloads. Output settings use DuckDB's normalized units.
`storage_compatibility_version` can still report the global default `latest`:
that setting is not the per-attachment `STORAGE_VERSION` request.

Output directory:

- `snapshots/*.duckdb`: seven standalone files, or nine with `--overflow`.
  **Open these in Atlas**, not the mutable files under `working/`.
- `logs/*.sql`: exact SQL sent to the CLI, including attach path, settings,
  workload, assertions, checkpoints, and inspection queries.
- `logs/*.stdout.log`: echoed SQL and CSV query output; `*.stderr.log` and
  `*.command.json` retain diagnostics and the actual argument list.
- `logs/version.stdout.log`: CLI version stdout, captured separately from stderr.
- `manifest.json`: completion flag, binary path/SHA-256/version, source-reference
  pin, adjacent source state if available, snapshot sizes/hashes/counts/checks.

All invocations ignore `~/.duckdbrc`, including the version probe. SQL paths are
quoted; CLI arguments never go through a shell. Each phase checkpoints and
**exits** before copying. The generator rejects nonempty `.wal`,
`.wal.checkpoint`, or `.wal.recovery` siblings before and after copying, then
reopens each copy read-only and checks its live row count. Zero-length WALs are
harmless. A failure leaves `complete: false`, logs, and working files for
diagnosis; choose a new output directory for a retry. Do not use incomplete
runs for a presentation. The output is deliberately retained until you remove
it; the optional run in the observed example used under 200 MiB including
working files and snapshots.

## Provenance: source pin is not a build certificate

Workshop reference source:
[`fb38af476a7d07408df3e1f943dd2eb3cd426ff0`](https://github.com/duckdb/duckdb/tree/fb38af476a7d07408df3e1f943dd2eb3cd426ff0).
The local binary used for the observations below was
`/Users/sgerrits/repos/duckdb/build/reldebug/duckdb`. Its version stdout was:

```text
v2.1.0-dev84001 (Development Version) fb38af476a
```

The adjacent checkout was clean at the full reference pin. That agrees with
the binary's reported abbreviated revision, but does **not** establish its
complete build inputs, flags, or reproducibility. The manifest records those
facts separately, and fingerprints the executable actually run. A different
CLI can choose different codecs, row-group boundaries, block IDs, or sizes.
`hash()` ordering is deterministic for this engine, not a cross-version contract.
The tests assert logical data, not byte-for-byte file identity.

## 01 — Same values, sorted versus hash-shuffled

Files: `01-sorted.sql`, `01-shuffled.sql`; open the correspondingly named snapshots.
Each has 300,000 `(id, value)` pairs, where `value = id % 1000`. One orders by
`value, id`; the other by `hash(id), id` (including a collision tie-breaker).

**Ask first:** will changing only order change storage? Which column's value
ranges become narrower? Do not ask the audience to predict a particular codec.

**Show:** switch Atlas to Compression, select `value` segments, and compare the
row-group/value-range views. Read the codec summary in the SQL log, keeping
`INTEGER` rows separate from `VALIDITY`. Then inspect the raw `stats` ranges.
In the observed sorted file, the three value ranges were 0–409, 409–819, and
819–999. The ID column has a different order now; this is not a claim that all
columns benefit from sorting by `value`.

**Reveal:** this run chose RLE for sorted `value` and BitPacking for shuffled
`value`; both ID columns used BitPacking. Both files had three row groups.
Sorting changed the representation, not the multiset of values. File size
includes headers, metadata, block packing, and free blocks—not just `value`.

## 02 — Same data, different persistence history

Files: `02-bulk.sql`, `02-append.sql`. Both store 300,000 identical rows ordered
by ID, with `value = id % 1000` and a 32-character `md5(id)` payload.

**Ask first:** do identical rows imply identical files? Does one transaction
necessarily become one stored row group?

**Show:** bulk uses one CTAS and a final checkpoint. Append uses just ten
30,000-row transactions, each followed by a checkpoint. Both use one thread.
Compare row-group stored spans, `persistent`, primary block IDs/offsets, and
free blocks in SQL and Atlas. There is no multi-threaded confound here.

**Reveal:** bulk spans were `[122880, 122880, 54240]`; append spans were
`[120000, 120000, 60000]`, **not ten row groups**. Both used BitPacking for the
numeric columns and DICT_FSST for the payload. The bulk file had 23 total / 0
free blocks; append had 27 total / 3 free blocks. First payload primary block
IDs were 1 and 10 respectively. These IDs identify locations within separate
files; equal IDs across unrelated files would not mean shared storage.

This deliberately compares **commit + checkpoint histories**, not CTAS versus
INSERT syntax alone, nor insertion/query performance. DuckDB can coalesce or
rewrite partial groups. An instructive follow-up is to remove intermediate
checkpoints in a copy of `02-append.sql` and compare again in a fresh database.
Do not promise that smaller transactions always yield worse compression.

## 03 — Delete, checkpoint, refill (the main third exercise)

Files: `03-baseline.sql`, `03-deleted.sql`, `03-refilled.sql`, run in that order
on the same working database. Separate immutable snapshots preserve each phase.

**Ask first:** does deleting rows shrink the file? Are freed blocks the same
thing as unused bytes inside an allocated block? Will refill necessarily reuse
all old free blocks before the file grows?

1. Open baseline: 300,000 rows, 64-character payloads, no indexes.
2. Open deleted: remove `id < 122880 OR id % 4 = 0`, then checkpoint. The range
   removes a whole initial row group on this build; the modulo predicate also
   makes scattered deletions. The literal boundary is workload design, not a
   universal row-group-size guarantee.
3. Open refilled: append 150,000 new IDs, then checkpoint. These are new values,
   not restoration of the deleted rows.

**Show:** compare Atlas's physical/live/deleted counts and Free list view,
then return to the physical map and row-group block links. SQL `count(*)`
measures live rows; segment `count` measures stored spans. After deletion this
run had **132,840 live rows but 177,120 stored ID slots**. The fully removed
first group disappeared; remaining spans retained tombstones. After refill it
had **282,840 live rows and 313,560 stored ID slots**: checkpoint changed some
spans, so tombstones are not immutable history either.

**Reveal:** deletion left file size unchanged while free blocks rose from 0 to
16. Refill grew the file and reported 27 free blocks. This is a counterexample
to a simplistic “delete shrinks, refill consumes all free space” story, not a
bug diagnosis or a guarantee about other workloads. Checkpoint allocation,
compaction, and reuse are engine decisions. A snapshot records current owners
and free lists, not a historical ownership log; compare snapshots rather than
inventing prior owners from one file.

### Optional separate overflow comparison

`--overflow` adds `03-overflow-uncompressed.sql` and `03-overflow-zstd.sql` in
separate databases. Both contain 1,500 strings of 8,192 bytes, each made by
repeating an ID-derived MD5 string. This intentionally highly compressible
synthetic input is **not representative production text**.

**Ask:** can the same long values occupy a string-overflow allocation in one
representation and a compressed segment in another? Select the payload's
logical segment and its overflow-marked blocks in Atlas; compare the complete
`additional_block_ids` array in the raw SQL log.

This run recorded payload `Uncompressed`, primary block 1 at offset 12000,
with additional block IDs 2–48 (47 IDs). The ZSTD payload used block 1 at
offset 32 with an empty additional-ID array. The forced ZSTD setting did not
make every column ZSTD: the ID column used BitPacking and validity used
Constant. Treat `force_compression` as a diagnostic knob, and inspect actual
results. An additional-block list records references, **not individual string
lengths, chain order, or allocated-byte utilization**. Its interpretation also
depends on the codec; don't label every auxiliary reference from every codec
as uncompressed string overflow.

## Actual observed outputs (one local run, not expected constants)

All raw segment rows reported `persistent=true`. Default block size was
262,144 bytes. File bytes below include the three 4-KiB headers; block counts
are `pragma_database_size()` output, not primary segment-reference counts.

| Snapshot | Live rows | File bytes | Total / used / free blocks |
| --- | ---: | ---: | --- |
| 01-sorted | 300,000 | 1,060,864 | 4 / 4 / 0 |
| 01-shuffled | 300,000 | 1,585,152 | 6 / 6 / 0 |
| 02-bulk | 300,000 | 6,041,600 | 23 / 23 / 0 |
| 02-append | 300,000 | 7,090,176 | 27 / 24 / 3 |
| 03-baseline | 300,000 | 10,760,192 | 41 / 41 / 0 |
| 03-deleted | 132,840 | 10,760,192 | 41 / 25 / 16 |
| 03-refilled | 282,840 | 18,624,512 | 71 / 44 / 27 |
| 03-overflow-uncompressed | 1,500 | 12,857,344 | 49 / 49 / 0 |
| 03-overflow-zstd | 1,500 | 536,576 | 2 / 2 / 0 |

Example codec-summary output for `01-sorted` (from `inspect.sql`):

```csv
column_name,segment_type,compression,persistent,segments,stored_value_slots,primary_blocks
id,BIGINT,BitPacking,true,5,300000,3
id,VALIDITY,Constant,true,3,300000,0
value,INTEGER,RLE,true,3,300000,1
value,VALIDITY,Constant,true,3,300000,0
```

`inspect.sql` also emits every raw storage-info row, including `stats`,
`persistent`, `block_id`, `block_offset`, and `additional_block_ids` on this
binary. It uses `SELECT *` for the raw query so a CLI without the optional
additional-ID column can still show the metadata it does expose.

To inspect a snapshot again (no writes):

```sh
DB=/tmp/atlas-workshop-01/snapshots/01-sorted.duckdb
/Users/sgerrits/repos/duckdb/build/reldebug/duckdb \
  -init /dev/null -readonly -batch -bail -csv "$DB" < workshop/demos/inspect.sql
```

Reopened-session settings differ from writer settings; the generation logs
are the record of the actual writer configuration. The workload SQL files
can also be run by hand on fresh databases; use the logged attach/settings
wrapper to retain the explicit format and configuration. For churn, retain
one database between the three phases and close it before each snapshot copy.

## Interpretation pitfalls / speaker checklist

- Predict first, inspect second. Codec choices and physical layout are observed,
  not asserted outcomes. No stopwatch, speedup, or query-performance conclusion.
- **Validity is a separate segment.** Summing all `count` values across columns
  and validity rows double-counts logical rows. Constants often have
  `block_id=-1`; they need no physical data block despite representing values.
- `count` is **not bytes**. `block_offset` is a starting position, not a length.
  `pragma_storage_info` has **no segment byte-length column** on this binary.
  Do not subtract adjacent offsets, multiply referenced blocks by block size,
  or use file-size differences to claim exact column payload sizes.
- Blocks can be shared; per-column distinct primary-block counts cannot be
  summed into database usage. Primary IDs alone also miss auxiliary allocations
  and metadata. Negative sentinel IDs are not disk blocks.
- `start` is row-group-relative on this binary (often zero); don't infer global
  row positions from it without checking version semantics.
- Atlas may show recorded native checkpoint byte sizes for this format. Missing
  sizes remain unknown; overflow capacity is not measured payload utilization.
  Whole free blocks differ from unused tails/gaps in allocated blocks.
- `has_updates=false` does not prove there are no deleted rows. Segment stats
  can still include deleted values; compare live SQL results with stored spans.
- Checkpoint and close before handing a file to Atlas: the browser cannot
  inspect sibling WAL files. Keep snapshots unchanged; SQL exploration should
  be read-only.

## Run the checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 workshop/demos/test_e2e.py \
  --duckdb /Users/sgerrits/repos/duckdb/build/reldebug/duckdb
```

The real-CLI test generates all nine snapshots in a temporary directory,
reopens them read-only, checks persistence and complete multiset equality for
each pair and the exact churn data, verifies hashes/logs/provenance fields,
and exercises quoted paths, startup-file isolation, overwrite refusal
(existing output, empty directory, symlink), failed-CLI incomplete state, and
all three nonempty-WAL guards. It does not require a DuckDB Python package.
The local run passed. CLI file generation and SQL inspection are tested here;
these tests do **not** launch the Atlas browser or certify its rendering.
