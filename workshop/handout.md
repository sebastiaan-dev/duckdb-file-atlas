# Participant worksheet — explain a DuckDB file

Use the provided **checkpointed snapshots**, not the mutable working databases.
Open them in DuckDB File Atlas. Optional CLI queries are below. Do not modify a
snapshot; comparisons should refer to the same immutable files.

Record before interpreting: engine version, requested storage version, block
size, threads, and ingestion/checkpoint history. The fixture manifest and SQL
logs contain the writer's provenance; a read-only reopened session can have
different session settings.

## A. Same values, different order

Files: `01-sorted.duckdb`, `01-shuffled.duckdb`. Both contain 300,000 `(id, value)`
rows, with `value = id % 1000`. Order is `value, id` versus `hash(id), id`.

**Before opening:** what local property changed? Which column might benefit?

| Observation | Sorted | Shuffled |
|---|---|---|
| `value` codec(s), excluding validity | | |
| Row-group count and stored spans | | |
| `value` min/max ranges per row group | | |
| Is your selected block shared? By whom? | | |
| Whole-file bytes | | |
| One unknown / unmeasured quantity | | |

Explain in three sentences:

1. The representation changed because …
2. Pruning might differ because …
3. The file-size comparison does **not** establish …

## B. Same data, different persistence history

Files: `02-bulk.duckdb`, `02-append.duckdb`. Same data and order, one thread.
Bulk is one CTAS and final checkpoint; append is ten 30k-row transactions with
intermediate checkpoints.

- Predict: how many stored row groups would you expect? Why?
- Do actual group boundaries match transaction boundaries?
- Follow a payload segment to disk. Compare same-column locality and block sharing.
- Do the codec names differ? Can layout differ even if codecs do not?
- What experiment would isolate intermediate checkpointing from statement syntax?

## C. Delete, checkpoint, refill

Files: `03-baseline.duckdb`, `03-deleted.duckdb`, `03-refilled.duckdb`.
No indexes. First delete the initial intended row-group range plus scattered rows;
then append 150,000 new rows. Each snapshot is checkpointed and closed.

| Quantity | Prediction after delete | Observed delete | Observed refill |
|---|---|---|---|
| Live rows | | | |
| Stored ID slots | | | |
| Whole-file bytes | | | |
| Whole free blocks | | | |

- Which counts describe SQL visibility, and which describe stored spans?
- Did every partly deleted group lose all its tombstones?
- Is an interior free block equivalent to a shorter file?
- Could a block free in the **final** snapshot have been unavailable earlier?
- What would require instrumentation rather than snapshot inspection?

## Optional D. Long strings

Files: `03-overflow-uncompressed.duckdb`, `03-overflow-zstd.duckdb`.
Same 1,500 × 8,192-byte strings, deliberately highly repetitive.

- Compare actual payload codecs, primary pointers, and `additional_block_ids`.
- Follow auxiliary references in Atlas. What can you measure exactly?
- If one ZSTD segment needs no auxiliary pages, what does that say—and not say—
  about ZSTD's general storage capabilities?

## SQL inspection

The snapshot table is always `t`. Open the file read-only with a compatible CLI:

```sh
duckdb -init /dev/null -readonly -batch -bail snapshot.duckdb
```

```sql
SELECT version();
SELECT count(*) AS live_rows FROM t;
SELECT * FROM pragma_storage_info('t');
PRAGMA database_size;

-- Keep physical value/validity streams distinct.
SELECT column_name, segment_type, compression, persistent,
       count(*) AS segments, sum(count) AS stored_value_slots
FROM pragma_storage_info('t')
GROUP BY ALL
ORDER BY ALL;
```

`workshop/demos/inspect.sql` contains the captured inspection queries. Files with
nested children require extra care: child counts need not equal parent rows.

## Rules for defensible conclusions

- A segment is not a block; a block can have multiple owners.
- A primary pointer is a start, not a length or a complete codec footprint.
- `count` is not bytes. Do not sum across columns/validity to count table rows.
- A constant can represent values without a physical data block.
- File bytes, segment bytes, allocation capacity, and bytes/live row are different metrics.
- Missing recorded byte sizes remain unknown. Do not infer ends from the next pointer.
- Whole free blocks differ from gaps/tails in live blocks and from stored tombstones.
- A snapshot tells current ownership, not the complete allocation history.
- No file-size observation here establishes a query-speed improvement.

## Design discussion

**Selection sampling:** propose an input where a cheap sample chooses badly.
Which checks are about correctness, and which are just about estimate quality?

**General auxiliary storage:** name one API invariant, one access-cost risk, and
one lifecycle test that a reusable overflow mechanism must cover.
