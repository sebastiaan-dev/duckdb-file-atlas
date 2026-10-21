# DuckDB `.duckdb` file internals

Source reference: DuckDB `fb38af476a7` (local checkout `~/repos/duckdb`, main/dev). The experiments were run with
CLI `v2.0.0-alpha49003` (`b32b1368b8`). That build is on a sibling branch, so each document lists where it differs
from the source. The on-disk format is the same in both builds. A few free-list and leak behaviours differ.

| # | Document | Covers |
|---|----------|--------|
| 1 | [01-headers-blocks-free-list.md](01-headers-blocks-free-list.md) | MainHeader and the two DatabaseHeaders byte by byte, checksums, how the active header is chosen and how h1/h2 alternate, fsync ordering and what a crash does at each step, blocks and block headers, metadata blocks and their 64 sub-blocks, `MetaBlockPointer`, and the `SingleFileBlockManager` free-list state machine. Also covers truncation, encryption and the WAL, with annotated hexdumps. |
| 2 | [02-segments-compression-partial-blocks.md](02-segments-compression-partial-blocks.md) | `ColumnSegment` (transient vs persistent), `DataPointer`, the analyze/compress pipeline, the in-block layout of each compression codec, overflow and additional blocks, and the `PartialBlockManager` (80%/20% rules, best fit, 8-byte alignment, zeroing, flush and merge). Also covers multi-use blocks and segment reuse. |
| 3 | [03-tables-rowgroups-columns-checkpoint.md](03-tables-rowgroups-columns-checkpoint.md) | The pointer graph from header → catalog → table → row group → column → segment bytes, catalog write order, `RowGroupPointer` fields, how nested types split into segment streams, vacuum and merge, rewrite vs reuse, multi-threaded checkpoint, and layout determinism at `threads=1` vs `threads=N`. |
| 4 | [04-flush-paths-and-boundaries.md](04-flush-paths-and-boundaries.md) | All 11 code paths that write into the file, checkpoint triggers and types, optimistic writes (parallel and batch insert), WAL pointer records, rollback and crash handling, and index persistence. Also covers lifecycle boundaries (when free lists, partial blocks and metadata state reset), with timelines and concurrent-checkpoint interplay. |

## The model in one page

```
file:  [MainHeader 4K][DBHeader h1 4K][DBHeader h2 4K][block 0][block 1] ... [block N-1]
                                                       ^ 12288 + id * block_alloc_size (default 256 KiB)
block: [checksum u64 (40 B header if encrypted)][payload ...]
         payload = one of: data block (segments packed, 8-byte aligned)
                           metadata block (64 sub-blocks, each [next ptr u64][data])

active DBHeader (larger iteration; h2 wins a tie)
  ├─ meta_block ─► catalog stream: schemas → types → sequences → tables → views → … → indexes
  │                  table entry ─► table_pointer ─► table stats, row-group pointers, index storage info
  │                     RowGroupPointer{row_start, tuple_count, data_pointers[col], deletes…}
  │                        column metadata ─► DataPointer{row_start, count, block_id+offset,
  │                                           compression, stats, segment_state, byte_size}
  │                           └─► segment bytes inside a data block (+ overflow / additional blocks)
  └─ free_list ─► free block ids, multi-use refcounts, free-sub-block masks of metadata blocks
```

## Rules that matter most

- **Copy on write.** Between checkpoints and during a checkpoint, new data goes only into ids that the durable header
  marks free, or into ids at or beyond `max_block`. Metadata blocks are the exception: sub-blocks can be rewritten in
  place (beans `repos-9ftg` and `repos-3m23`).
- **Durability order.** The writer fsyncs the WAL checkpoint marker, then writes data and index blocks. It then writes
  the free list and metadata, fsyncs, writes the header into the inactive slot and fsyncs again. Only after that does
  it release `modified_blocks` into `free_list`, truncate trailing free blocks, and delete or replace the WAL.
- **When freed blocks become reusable.**
  - A block that was durable goes into `modified_blocks` and is reusable only after the next header fsync.
  - A block that was never durable (a rolled-back optimistic write) returns to `free_list` immediately.
  - A block that a live handle still holds waits in `free_blocks_in_use`.
  - A shared (multi-use) block is freed only when its last reference is dropped.
- **Partial-block boundaries.**
  - During a checkpoint, partial blocks are flushed at the end of each table, so tables never share data blocks.
    Blocks written by earlier checkpoints are never refilled.
  - ART index partial blocks never span indexes.
  - Optimistic writers keep partial blocks per thread and per column. These are merged into the transaction's writer
    and flushed at combine, finalize or commit.
- **Metadata manager state** (`modified_blocks`) resets once per checkpoint.
- **Threads.** A checkpoint runs one task per row group, and all tasks share one `PartialBlockManager` behind a lock.
  Compression runs in parallel. Segment placement and the write of each full block happen under the lock. Row-group
  metadata is written sequentially, in order, after all tasks finish. As a result, `threads=1` gives the same layout
  on every run. `threads=N` gives the same logical layout but different block ids and offsets on each run.
- **Bulk inserts** write row groups directly into the file before commit. The WAL then records only block pointers.
  Those blocks are serialized as *free* in every header until the commit marks them used, so a crash before commit
  does not leak them.

## Possible bugs found while writing these (recorded in beans, `~/repos`)

`repos-shfp` (a corrupt inactive header prevents the file from opening), `repos-1nmp` (a storage-version upgrade
writes uninitialized bytes into the MainHeader), `repos-9ftg` / `repos-3m23` (in-place metadata rewrite risks a torn
write), `repos-bp68` (high: blocks leak when a bulk insert commits during a concurrent checkpoint and the process then
crashes), `repos-cd9o` (`ValidityAppend` ignores the block offset), and `repos-hek2` (shifted error-message
arguments).
