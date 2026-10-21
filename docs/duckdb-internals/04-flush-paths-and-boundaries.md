# 04 — Every path that writes into a `.duckdb` file, and the boundaries around them

> **Source baseline.** All citations refer to DuckDB commit **`fb38af476a7`**
> (`/Users/sgerrits/repos/duckdb`, `main`, 2026‑09‑08). Paths are relative to the
> DuckDB repository root, and line numbers belong to that commit. A citation such as
> `single_file_block_manager.cpp:1320-1423 SingleFileBlockManager::WriteHeader`
> means *file : lines, function*.
>
> **Empirical baseline.** The experiments in §11 used the requested CLI
> `/Users/sgerrits/.duckdb/cli/latest/duckdb` (`v2.0.0-alpha49003`, commit
> `b32b1368b8`, ~6 weeks **newer** than `fb38af476a7`). Some experiments also ran on
> `build/release/duckdb` and `build/release/test/unittest`, which were built from exactly
> `fb38af476a7` (`v2.1.0-dev84001`). When the two binaries behave differently, the text says
> so and cites the upstream diff (§12).

---

## Contents

1. [Vocabulary and the on-disk primitives](#1-vocabulary-and-the-on-disk-primitives)
2. [Master table: every writer of the `.duckdb` file](#2-master-table-every-writer-of-the-duckdb-file)
3. [Checkpoint triggers](#3-checkpoint-triggers)
4. [Anatomy of a checkpoint (what each phase writes)](#4-anatomy-of-a-checkpoint)
5. [Optimistic writes (direct-to-file before commit)](#5-optimistic-writes)
6. [Index persistence and catalog writes](#6-index-persistence-and-catalog-writes)
7. [Other writers: COPY DATABASE, compaction, ALTER, UPDATE, DELETE, DROP](#7-other-writers)
8. [BOUNDARIES: free lists, reuse, partial blocks, metadata, WAL](#8-boundaries)
9. [Timelines](#9-timelines)
10. [Multi-threaded interplay](#10-multi-threaded-interplay)
11. [Empirical validation](#11-empirical-validation)
12. [Divergences in the newer CLI and defects found](#12-divergences-and-defects)
13. [Summary of invariants](#13-summary-of-invariants)

---

## 1. Vocabulary and the on-disk primitives

### 1.1 File layout

| Region | Offset | Written by | Source |
|---|---|---|---|
| Main header (magic, version, flags, DB identifier, encryption metadata) | `0` | `CreateNewDatabase`, `RewriteMainHeader` | `single_file_block_manager.cpp:584-586`, `:860-868` |
| Database header **h1** | `4096` (`Storage::FILE_HEADER_SIZE`) | `CreateNewDatabase`, `WriteHeader` | `storage_info.hpp:56`, `single_file_block_manager.cpp:592-602`, `:1405` |
| Database header **h2** | `8192` | `CreateNewDatabase`, `WriteHeader` | `single_file_block_manager.cpp:604-615`, `:1405` |
| Block *n* | `BLOCK_START + n * block_alloc_size`, where `BLOCK_START = 3*4096 = 12288` | everything else | `single_file_block_manager.hpp:70`, `single_file_block_manager.cpp:1158-1160 GetBlockLocation`, `:1217-1220 Write` |

* The default `block_alloc_size` is 262144 (`storage_info.hpp:33`), and the default row group is
  122880 rows (`storage_info.hpp:26`).
* Block ids `>= MAXIMUM_BLOCK` (`storage_info.hpp:30`) are **transient**. They live only in
  the buffer pool, and the buffer pool spills them only to the *temporary* directory.
  `BlockMemory::UnloadAndTakeBlock` writes a temporary buffer only when
  `BlockId() >= MAXIMUM_BLOCK` (`buffer/block_handle.cpp:127-145`). Persistent blocks are
  **never** written back on eviction, so every write to the `.duckdb` file passes through
  one of the explicit paths in §2.
* A database header holds `iteration`, `meta_block` (the catalog root), `free_list` (the
  metadata pointer of the serialized free list), `block_count`, `block_alloc_size`,
  `vector_size`, and `storage_compatibility` (`single_file_block_manager.cpp:270-285
  DatabaseHeader::Write`). The header with the highest `iteration` wins on load
  (`:705-716 LoadExistingDatabase`).

### 1.2 Metadata blocks

Metadata (catalog, row-group pointers, column pointers, delete vectors, index
allocator info, and the free list itself) lives in 256 KiB blocks that the
`MetadataManager` splits into **64 sub-blocks** (`metadata_manager.hpp:58
METADATA_BLOCK_COUNT = 64`). A `MetaBlockPointer` packs `block_id | (sub_index << 56)`
(`metadata_manager.cpp:196-208`). Each `MetadataBlock` tracks a vector of free sub-block
indices. The manager also keeps a `modified_blocks` map of `block_id → bitmask`
(§8.4).

### 1.3 The four block sets of `SingleFileBlockManager` (and a name that does not exist)

The task brief mentions a `newly_freed_list`. **This commit has no member with that
name.** The real state is declared in `single_file_block_manager.hpp:207-222`:

| Member | Type | Meaning (header comment) | Persisted in the free list? |
|---|---|---|---|
| `free_list` | `set<block_id_t>` | "free blocks that can be written to currently" | yes |
| `free_blocks_in_use` | `set` | "freed, but cannot yet be re-used because they are still in-use" (a live `BlockHandle` exists) | **no** at `fb38af476a7` (only counted for sizing, `:1259-1260`); fixed later (§12) |
| `newly_used_blocks` | `set` | "in-use, but haven't been written as part of a checkpoint yet" (optimistic and WAL-replayed allocations) | **yes, as free** (`:1338-1342`) |
| `multi_use_blocks` | `unordered_map<block_id,uint32>` | blocks with more than one reference (partial blocks shared by several segments) | yes, with counts (minus newly-used ones) |
| `modified_blocks` | `unordered_set` | "no longer in-use, but cannot be re-used until the next checkpoint" | **yes, as free** (`:1333-1336`) |
| `max_block` | `block_id_t` | next id to hand out once the free list is empty | as `header.block_count` (`:1373`) |

The task brief also mentions `ReplaceFreeList` and `MarkBlockAsFree`. Neither exists here.
Their roles are filled by the tail of `WriteHeader` (`:1411-1422`) and by
`MarkBlockAsModified` (`:964-999`) respectively.

### 1.4 Block-manager verbs (exact semantics)

| Verb | Lines | Effect |
|---|---|---|
| `GetFreeBlockId()` | `:919-921` → `GetFreeBlockIdInternal(NEWLY_USED_BLOCK)` `:898-917` | takes `*free_list.begin()` (the lowest id), or `max_block++` if the list is empty; inserts into `newly_used_blocks` |
| `GetFreeBlockIdForCheckpoint()` | `:923-925` | same, but **not** added to `newly_used_blocks` (`FreeBlockType::CHECKPOINTED_BLOCK`, `single_file_block_manager.hpp:28`) |
| `PeekFreeBlockId()` | `:927-934` | the lowest free id, or `max_block` |
| `MarkBlockAsCheckpointed(id)` | `:936-940` | `newly_used_blocks.erase(id)`, so the block becomes "durable-used" at the next header |
| `MarkBlockAsUsed(id)` | `:942-962` | load/replay path: grows `max_block` (gap ids go to `free_list`), removes the id from `free_list`, **or increments its refcount** (`IncreaseBlockReferenceCountInternal` `:1001-1011`) |
| `MarkBlockAsModified(id)` | `:964-999` | decrements a multi-use refcount; otherwise a newly-used block is **freed immediately** (`AddFreeBlock`), and any other block is added to `modified_blocks` (freed after the next header) |
| `AddFreeBlock` | `:1300-1319` | goes to `free_list` if no live `BlockHandle` is registered, else to `free_blocks_in_use` |
| `UnregisterBlock(id)` | `:1429-1440` | when the last `BlockHandle` dies, moves the id from `free_blocks_in_use` to `free_list` |
| `IncreaseBlockReferenceCount` | `:1103-1106` | used when a partial block is shared |
| `FreeBlocks()` | `:1117-1120` | **`free_list.size()` only**. This is what `pragma_database_size().free_blocks` reports (`storage_manager.cpp:820-832`). `modified_blocks` are *not* counted as free. |

---

## 2. Master table: every writer of the `.duckdb` file

`grep` over `src/` for `ConvertToPersistent(`, `BlockManager::Write`, and
`ChecksumAndWrite(` finds exactly the call sites below. No other code path writes bytes into the
database file.

| # | Writer | Bytes written | Trigger / lifecycle | Block-id source | Source |
|---|---|---|---|---|---|
| W1 | `SingleFileBlockManager::CreateNewDatabase` | main header, h1, h2 (iteration 0, empty), then `Sync` | first open of a nonexistent file / `ATTACH` of a new path | n/a | `single_file_block_manager.cpp:516-623`, `storage_manager.cpp:467-507` |
| W2 | `PartialBlockForCheckpoint::Flush` → `ColumnSegment::ConvertToPersistent` → `BlockManager::ConvertToPersistent` → `Write` | compressed column segment pages (one or more segments packed per block) | checkpoint **and** optimistic writes | checkpoint: `GetFreeBlockIdForCheckpoint` at allocation time. Optimistic: `GetFreeBlockId` **lazily at flush** | `column_checkpoint_state.cpp:59-94`, `column_segment.cpp:252-275`, `buffer/block_manager.cpp:59-118` |
| W3 | `WriteOverflowStringsToDisk::Flush/AllocateNewBlock` | full overflow-string blocks for uncompressed strings | checkpoint / optimistic | `partial_block_manager.GetFreeBlockId()` (type-dependent) | `checkpoint/write_overflow_strings_to_disk.cpp:63-130` |
| W4 | ZSTD `FlushPage` | extra ZSTD string pages | checkpoint / optimistic | `partial_block_manager.GetFreeBlockId()` | `compression/zstd.cpp:451-475` |
| W5 | `MetadataManager::Flush` | every **dirty** metadata block (catalog, table/row-group/column pointers, delete vectors, index allocator infos, free list) | inside `WriteHeader`, after the free list is serialized | `GetFreeBlockIdForCheckpoint` (`metadata_manager.cpp:493-495`), or **an existing metadata block rewritten in place** (§8.4) | `metadata_manager.cpp:277-313` |
| W6 | `PartialBlockForIndex::Flush` | ART `FixedSizeBuffer` pages | checkpoint (`ART::WritePartialBlocks`) | `GetFreeBlockIdForCheckpoint` | `execution/index/fixed_size_buffer.cpp:17-21`, `:83-147`, `art/art.cpp:1088-1097` |
| W7 | `WriteHeader` header write | h1 or h2 (alternating), with `Sync` before and after | last step of every checkpoint | n/a | `single_file_block_manager.cpp:1384-1410` |
| W8 | `RewriteMainHeader` | main header (offset 0) | inside `WriteHeader` when upgrading v0.10.2→≥v1.2.0 or downgrading from v2.0.0 | n/a | `:860-868`, `:1386-1397` |
| W9 | `SingleFileBlockManager::Truncate` | `ftruncate` of the file tail | after `WriteHeader` in every checkpoint | trailing `free_list` ids | `:1222-1244`, `checkpoint_manager.cpp:333` |
| W10 | `TrimFreeBlocks` → `handle->Trim` | hole punch (only if `trim_free_blocks`, default false) | end of `WriteHeader` | blocks freed by this checkpoint | `:1442-1469`, `config.hpp:109` |
| W11 | `WriteAheadLogDeserializer::ReplayIndexData` | ART buffers copied from a WAL `CREATE INDEX` / `ADD UNIQUE` entry straight into file blocks | WAL replay at startup (read-write attach) | `GetFreeBlockIdForCheckpoint` | `wal_replay.cpp:882-920` (`:911-916`) |

Two things are notable. Writer W2–W4 is the **same code** for checkpoints and for
optimistic writes. Only the `PartialBlockType` differs (`partial_block_manager.hpp:87`
`FULL_CHECKPOINT | APPEND_TO_TABLE | IN_MEMORY_CHECKPOINT`). WAL replay (W11) is the only
non-checkpoint, non-transaction writer.

---

## 3. Checkpoint triggers

`SingleFileStorageManager::CreateCheckpoint` (`storage_manager.cpp:735-791`) has exactly
**three callers** in `src/`, found by grepping for `CreateCheckpoint(`:

| Trigger | Caller | Options passed |
|---|---|---|
| explicit `CHECKPOINT` / `FORCE CHECKPOINT` | `DuckTransactionManager::Checkpoint` `duck_transaction_manager.cpp:209-255` (`:254`) | default `CheckpointOptions` (`FULL_CHECKPOINT`, `CHECKPOINT_IF_REQUIRED`), downgraded to `CONCURRENT_CHECKPOINT` at `:248-252` |
| auto-checkpoint at commit | `DuckTransactionManager::CommitTransaction` `:300-469` (`:458`) | `ALWAYS_CHECKPOINT`, type from `GetCheckpointType`, optional held `wal_lock` |
| shutdown / detach | `AttachedDatabase::Close` `attached_database.cpp:366-411` (`:393`) | default options + `wal_action = DELETE_WAL` (dead field, §12), **no ClientContext** |

### 3.1 Gate inside `CreateCheckpoint` (all triggers)

`storage_manager.cpp:735-791`:

1. `read_only || !load_complete` → return without writing (`:736-738`). This is why no
   checkpoint ever runs **during** WAL replay (§3.5).
2. Unless the type is already `CONCURRENT_CHECKPOINT`, try the **vacuum lock**
   exclusively (`:739-751`). If any transaction holds it shared (every
   transaction that inserts or deletes takes it in `DuckTransaction::SetModifications`
   `duck_transaction.cpp:362-370`), a `FULL_CHECKPOINT` becomes `CONCURRENT_CHECKPOINT`.
   A `VACUUM_ONLY` checkpoint is skipped entirely.
3. A checkpoint runs only if `wal_size > 0 || force_checkpoint || action == ALWAYS_CHECKPOINT`
   (`:757-760`). So **an explicit `CHECKPOINT` with an empty WAL writes nothing**,
   even when there are freed blocks to reclaim (experiment E1-D, §11).
   `PRAGMA force_checkpoint` sets `force_checkpoint = true` (`pragma_functions.cpp:77-79`,
   `config.hpp:113`).
4. Any exception invalidates the database (initial DB: `FatalException`, others: scoped
   `Invalidate`) (`:774-785`).
5. In-memory databases use `InMemoryCheckpointer` (`:727-733`) and never touch a file.

### 3.2 Explicit `CHECKPOINT` and `FORCE CHECKPOINT`

* Parser: `TransformCheckpointStatement` produces `CALL checkpoint()` or `CALL force_checkpoint()`
  (`parser/peg/transformer/transform_checkpoint.cpp:7-21`). Both call
  `TransactionManager::Checkpoint(context, FORCE)` (`function/table/checkpoint.cpp:49-67`).
* `DuckTransactionManager::Checkpoint` (`duck_transaction_manager.cpp:209-255`):
  * If the caller has a transaction open on this DB: `FORCE` throws; plain `CHECKPOINT`
    throws only if that transaction has local changes (`:214-226`).
  * Plain: `checkpoint_lock.TryGetExclusiveLock()` fails if any write transaction holds
    the shared checkpoint lock. Error: "there are other write transactions active"
    (`:229-237`). Which transactions hold it? Those with `UpdateData | AlterTable |
    CreateCatalogEntry | DropCatalogEntry | Sequence | CreateIndex`
    (`duck_transaction.cpp:347-361`). **Insert-only and delete-only transactions do
    not hold it.** They hold only the vacuum lock, so a plain `CHECKPOINT` succeeds
    concurrently with them as a `CONCURRENT_CHECKPOINT`.
  * `FORCE`: takes `start_transaction_lock` (no new write transactions can start) and spins on
    `TryGetExclusiveLock` with `InterruptCheck` until active writers finish (`:239-247`).
    `FORCE` therefore does **not** imply `force_checkpoint`. It still writes nothing if
    the WAL is empty.
  * If `GetLastCommit() >= LowestVisibilityBound()` (some snapshot needs old data), the type
    becomes `CONCURRENT_CHECKPOINT` (`:248-252`).

### 3.3 Automatic checkpoint at commit (`checkpoint_threshold` / `wal_autocheckpoint`)

Settings: `checkpoint_threshold` (alias `wal_autocheckpoint`, `common/settings.json:256-266`)
sets `config.options.checkpoint_wal_size`, whose default is `1 << 24` = 16 MiB (`config.hpp:92`,
`custom_settings.cpp:385-393`). `wal_autocheckpoint_entries` (default 0 = disabled,
`settings.hpp:2457-2467`).

`CommitTransaction` (`duck_transaction_manager.cpp:300-469`), step by step:

1. **`PreFlushOptimisticBlocks`** (`:303`, `duck_transaction.cpp:215-228`) runs *before
   any commit lock*. It flushes every bulk-append `LocalTableStorage` to the file and calls
   **`FileSync`** (`local_storage.cpp:610-626 FlushBulkAppendBlocksAndSync`). See §5.6.
2. `CanCheckpoint` (`:134-160`) returns "no" for: system DB, read-only transaction,
   `!IsLoaded()` ("cannot checkpoint while loading"), `!AutomaticCheckpoint`,
   `debug_skip_checkpoint_on_commit`, or failure to obtain/upgrade the **exclusive checkpoint
   lock** (`TryGetCheckpointLock` `duck_transaction.cpp:373-379`: upgrade if the transaction
   already holds it shared).
   * `DuckTransaction::AutomaticCheckpoint` (`duck_transaction.cpp:179-195`) returns false for the
     checkpoint transaction itself, for transactions without changes, and for read-only attaches.
     Otherwise it calls `SingleFileStorageManager::AutomaticCheckpoint` (`storage_manager.cpp:839-856`):
     **`wal_size + estimated_size > checkpoint_wal_size`** or
     `wal_entries ≥ wal_autocheckpoint_entries`.
   * `estimated_size` is the undo-buffer estimate plus `LocalStorage::EstimatedSize`
     (`duck_transaction.cpp:173-177`). For a bulk append (≥ 1 row group, no deletes) this
     counts only **pointer-sized** metadata per row group (`local_storage.cpp:91-118`).
     Large optimistic inserts therefore rarely trigger auto-checkpoints by themselves (E3: a
     3M-row insert left a 10 KiB WAL).
3. If a checkpoint is possible and `estimated_size ≥ auto_checkpoint_skip_wal_threshold`
   (default 100000, `settings.hpp:413-425`), the commit **skips the WAL write** and
   keeps the WAL lock until the checkpoint ends (`:322-334`, `:428-433`). The checkpoint is then
   the durability point.
4. WAL write (`:337-356`) happens with the transaction lock released and the WAL lock held.
5. With the transaction lock re-acquired, `GetCheckpointType` (`:162-207`) decides:
   * other transactions active **and** this transaction has updates → no checkpoint ("Transaction has performed
     updates and there are other transactions active").
   * other transactions active **and** this transaction dropped catalog entries → no checkpoint.
   * other transactions active otherwise → `CONCURRENT_CHECKPOINT`.
   * in-memory DB without compression → `VACUUM_ONLY` (or none if concurrent).
   * If the WAL write was skipped but the checkpoint is now refused, it writes the WAL after all (`:362-371`).
6. `transaction.Commit` (`duck_transaction.cpp:269-331`) runs. Its `CommitDropState::FinalizeCommit`
   frees dropped blocks (§7.6).
7. After cleanup, with the exclusive checkpoint lock held, it calls `CreateCheckpoint` with
   `ALWAYS_CHECKPOINT` (`:445-466`). An exception after a durable WAL write is reported as an
   *autocheckpoint error* and the commit stays successful (`:459-465`, `:26-34`).

**What blocks an auto-checkpoint.** These are all from source:

| Condition | Where | Effect |
|---|---|---|
| WAL below threshold | `storage_manager.cpp:839-856` | no checkpoint |
| Another transaction holds the shared checkpoint lock (pending DDL/UPDATE/sequence/CREATE INDEX) | `CanCheckpoint` `:153-157` | no checkpoint |
| Other active transactions + this txn had UPDATEs or DROPs | `GetCheckpointType` `:167-195` | no checkpoint |
| Other active transactions (otherwise) | `:196-199` | **concurrent** checkpoint (no delete vacuum) |
| Another transaction holds the vacuum lock (has inserted/deleted, even uncommitted optimistic writes) | `CreateCheckpoint` `storage_manager.cpp:739-751` | FULL → **CONCURRENT** |
| Uncommitted optimistic writes of *other* transactions | they hold the vacuum lock, so the above applies. Their blocks sit in `newly_used_blocks` and are serialized as **free** (§8) | concurrent checkpoint, not blocked |
| DB still loading (WAL replay) | `CanCheckpoint` `:145-148` | no checkpoint |

### 3.4 Shutdown and DETACH (`checkpoint_on_shutdown`, `checkpoint_on_detach`)

* `AttachedDatabase::Close` (`attached_database.cpp:366-411`) is reached from
  `~AttachedDatabase` (`:196-201`, `TRY_CHECKPOINT`), from `DatabaseManager::ResetDatabases`
  (`database_manager.cpp:468-474`, `TRY_CHECKPOINT`), and from `DETACH` via
  `InvokeCloseIfLastReference` (`attached_database.cpp:250-272`).
* `TRY_CHECKPOINT` checkpoints iff `checkpoint_on_shutdown` (default true, `config.hpp:115`;
  `PRAGMA enable/disable_checkpoint_on_shutdown` `pragma_functions.cpp:93-99`). It is skipped
  during stack unwinding (`Exception::UncaughtException()`), for in-memory DBs, and for invalidated DBs
  (`:374-380`).
* `DETACH`: `checkpoint_on_detach` = `ENABLED | DISABLED | DEFAULT`, where DEFAULT defers to
  `checkpoint_on_shutdown` (`settings.hpp:513-528`, `attached_database.cpp:251-259`). The checkpoint is
  skipped if another connection still references the DB (`:261-267`).
* The shutdown checkpoint has **no `ClientContext`**. `ActiveCheckpointWrapper` starts no
  checkpoint transaction (`checkpoint_manager.cpp:44-52`), and the visibility bound is
  `Through(last_commit)` (`storage_manager.cpp:264-268`). It uses `CHECKPOINT_IF_REQUIRED`,
  so it runs only if `wal_size > 0` or `force_checkpoint` is set.

### 3.5 "Checkpoint during WAL replay at startup": there is none

`SingleFileStorageManager::LoadDatabase` (`storage_manager.cpp:412-599`) loads the checkpoint
(`:568-570`), then replays the WAL (`:583-585`), and sets `load_complete = true` only at the end
(`:598`). During replay:

* `CreateCheckpoint` returns immediately (`!load_complete`, `:736`). `CanCheckpoint`
  refuses (`:145-148`). `HasWAL()`/`GetWAL()` return false/null (`:211-249`), so replayed
  commits write no WAL.
* Replay **does write to the file** in two ways. W11 materializes ART buffers
  (`wal_replay.cpp:911-916`). And because `OptimisticDataWriter::CanWriteToDisk` is true for a
  read-write attach (`optimistic_data_writer.cpp:28-32`), a replayed bulk `INSERT_TUPLE`
  stream can be optimistically flushed through `LocalStorage::Flush` → `FlushBlocks`
  (`local_storage.cpp:559-608`).
* `ROW_GROUP_DATA` entries are replayed by reference. The first (deserialize-only) pass calls
  `MarkBlockAsUsed` for every referenced block, so the free list loaded from the header
  cannot hand those blocks out again (`wal_replay.cpp:1305-1320`).
* After replay, the new `WriteAheadLog` is constructed with `wal_size = successful_offset`
  (`wal_replay.cpp:655-656`, `write_ahead_log.cpp:33-39`). **The replayed WAL therefore makes the next
  checkpoint opportunity fire**: the next auto-checkpoint, an explicit `CHECKPOINT`, or the
  shutdown checkpoint (E5: reopen + exit deleted the WAL).

### 3.6 ATTACH and storage-version upgrade

`ATTACH ... (STORAGE_VERSION 'x')` only changes in-memory `options.storage_version`
(`single_file_block_manager.cpp:816-858 Initialize`, `:828-841`). **Nothing is written at
attach.** The header's `storage_compatibility` is written at the next real checkpoint
(`:1376`), together with an optional main-header rewrite (`:1386-1397`). Experiment E11 (§11):
the file's md5 is unchanged after `ATTACH (STORAGE_VERSION 'v1.2.0')` + `CHECKPOINT` (empty WAL),
and changes only after a DDL + `CHECKPOINT`.

### 3.7 `VACUUM`

The SQL `VACUUM` / `ANALYZE` statement does **not** write to the file. `PhysicalVacuum::Finalize`
only updates distinct statistics and calls `DataTable::VacuumIndexes` → `TableIndexList::Vacuum`
in memory (`execution/operator/helper/physical_vacuum.cpp:91-107`, `storage/data_table.cpp:370-372`).
Physical compaction ("vacuum") happens **inside checkpoints** (§7.2).

### 3.8 `CheckpointType` variants and what each writes

`common/enums/checkpoint_type.hpp:15-38`:

| Type | Chosen when | Writes | Differences |
|---|---|---|---|
| `FULL_CHECKPOINT` | default. Requires the exclusive vacuum lock | everything in §4 | may vacuum deletes (merge/drop row groups) and may compress version info |
| `CONCURRENT_CHECKPOINT` | other transactions active / vacuum lock unavailable / a snapshot needs old data | same writers | `can_vacuum_deletes = false` (`row_group_collection.cpp:1461-1465`). Row groups appended after start are excluded (§10) |
| `VACUUM_ONLY` | in-memory DB without compression | nothing to a file | skips the per-row-group checkpoint task (`row_group_collection.cpp:1738`) |

Orthogonal enums: `CheckpointAction {CHECKPOINT_IF_REQUIRED, ALWAYS_CHECKPOINT}` and
`CheckpointWALAction {DELETE_WAL, DONT_DELETE_WAL}` (`checkpoint_type.hpp:15-27`). The latter is never
read (§12).

---

## 4. Anatomy of a checkpoint

`SingleFileCheckpointWriter::CreateCheckpoint` (`checkpoint_manager.cpp:196-373`). Phases
with their writes:

| Phase | Lines | Effect on file / state |
|---|---|---|
| P0 setup | `:216` | `metadata_writer->GetMetaBlockPointer()` **allocates the first metadata sub-block**, which becomes the future `header.meta_block` |
| P1 `WALStartCheckpoint` | `:232`, `storage_manager.cpp:251-305` | Under the WAL lock: starts a read-only *checkpoint transaction* (its snapshot = what is written), `SetActiveCheckpoint(id)` (`checkpoint_manager.cpp:65-74`). If the WAL is non-empty: writes a `CHECKPOINT(meta_block)` marker + **fsync** to `x.db.wal`, closes it, deletes any stale `x.db.wal.checkpoint`, and opens a fresh lazy WAL at `x.db.wal.checkpoint` for concurrent commits (`storage_manager.cpp:285-304`, path from `:346-348`) |
| (debug) | `:236-239` | `debug_checkpoint_sleep_ms` sleeps here |
| P2 catalog scan | `:241-251` | committed schemas → ordered entries (`GetCatalogEntries` `:114-194`) |
| P3 serialize | `:272-278` | For each entry, `WriteEntry` (`:412-467`). Tables go through `WriteTable` (`:691-711`): bind indexes, take the **table exclusive checkpoint lock** (`data_table.cpp:1572-1574`), then `TableDataWriter::WriteTableData` → `DataTable::Checkpoint` (`data_table.cpp:1576-1599`) → `RowGroupCollection::Checkpoint` (§4.1) → `FinalizeTable` (row-group pointers + **index serialization**, `table_data_writer.cpp:96-222`) |
| P4 | `:280-281` | `metadata_writer->Flush()` / `table_metadata_writer->Flush()` only zero-pad the current sub-block (`metadata_writer.cpp:82-88`). No disk I/O yet |
| (debug) | `:283-289` | `DEBUG_ABORT_BEFORE_HEADER[_NON_FATAL]` |
| P5 `WriteHeader` | `:291-296`, `single_file_block_manager.cpp:1320-1423` | free-list serialization, **metadata flush (W5)**, fsync, header (W7), fsync, release `modified_blocks` (§8.2) |
| (debug) | `:298-327` | `debug_verify_blocks` cross-check |
| P6 `Truncate` | `:333` | W9 |
| P7 `WALFinishCheckpoint` | `:339-352`, `storage_manager.cpp:307-336` | delete `x.db.wal` and re-create it lazily. Or, if concurrent commits wrote `.wal.checkpoint`, **move** it over `x.db.wal` |
| P8 | `:361-371` | `MergeCheckpointDeltas` merges index deltas appended during the checkpoint |
| P9 | `:372` | commit the checkpoint transaction, `ResetActiveCheckpoint` |

### 4.1 `RowGroupCollection::Checkpoint` (per table)

`row_group_collection.cpp:1704-2061`:

1. Snapshot `row_groups`, then `InitializeVacuumState` (`:1458-1554`): drop fully deleted row groups
   (`row_group.CommitDrop()` `:1515`, `:1550`).
2. For each segment, schedule a `VacuumTask` (`:1295-1455`, merges row groups and `CommitDrop`s the
   inputs at `:1408`) or a `CheckpointTask`. `GetCheckpointTask` skips row groups appended
   **after the checkpoint started** (`:1694-1702`, using the count captured by
   `DataTableInfo::AppendRequiresNewRowGroup`, `data_table.cpp:1066-1090`).
3. `executor->WorkOnTasks()` runs tasks in parallel (`:1755`). Each task calls `RowGroup::WriteToDisk`
   (`row_group.cpp:1597-...`) → per column `ColumnDataCheckpointer::Checkpoint`
   (`column_data_checkpointer.cpp:411-435`):
   * **no changes** → `CheckpointBlockIdMarker` → `MarkBlockAsCheckpointed` on every existing block
     (`:400-409`, `:421-431`). This is how optimistically written blocks become durable without
     being rewritten (E3: 141/141 and 282/282 segments kept their block + offset).
   * **changes** (updates, transient data, deletes needing rewrite) → `WriteToDisk` (`:310-358`):
     analyze/compress → `FlushSegment` → partial block manager (W2–W4), then **`DropSegments`**
     (`:284-299`) → `MarkBlockAsModified` on every old block.
4. Metadata reuse (`experimental_metadata_reuse`, default **true**, `settings.hpp:1363-1373`):
   an unchanged table reuses its old metadata pointer. `ClearModifiedBlocks` "un-frees" those
   metadata sub-blocks (`row_group_collection.cpp:1757-1792`, `table_data_writer.cpp:136-146`).
5. **`writer.FlushPartialBlocks()` at `:2049`**, which happens at the end of *each table*, then
   `SetRowGroups(new_row_groups)` (`:2054`).
6. `FinalizeTable` writes stats, row-group pointers, and `index_storage_infos` (§6).

---

## 5. Optimistic writes

"Optimistic" means that row groups of an uncommitted transaction are compressed and written
into **free blocks of the database file** before commit. At commit only *pointers* go to
the WAL.

### 5.1 Preconditions

* `OptimisticDataWriter::PrepareWrite` (`optimistic_data_writer.cpp:34-50`) requires
  `enable_optimistic_write` (default true, `settings.hpp:1259-1271`) and `CanWriteToDisk`
  (`:28-32`: not a temp table, not in-memory, not read-only). On first use it creates a
  `PartialBlockManager(APPEND_TO_TABLE)`.
* With `APPEND_TO_TABLE`, `AllocateBlock` sets `block_id = INVALID_BLOCK`
  (`partial_block_manager.cpp:86-96`). The **block id is chosen only when the partial block is
  flushed**: `PartialBlockForCheckpoint::Flush` calls `block_manager.GetFreeBlockId()`
  (`column_checkpoint_state.cpp:71-74`) → `newly_used_blocks`. Shared blocks get
  `IncreaseBlockReferenceCount` (`:87-90`).
* Overflow strings and ZSTD pages call `partial_block_manager.GetFreeBlockId()` eagerly
  (`partial_block_manager.cpp:98-104`). That is also `GetFreeBlockId` (newly used) for this type.

### 5.2 Single-threaded path (`LocalStorage`)

`PhysicalInsert::Sink` non-parallel → `DataTable::LocalAppend` → `LocalStorage::Append`
(`local_storage.cpp:456-477`):

* `RowGroupCollection::Append` returns `flushed_row_group_idx` whenever a row group **fills**
  and a new one is started (`row_group_collection.cpp:674-727`, `:697-715`).
* `LocalTableStorage::WriteNewRowGroup` (`local_storage.cpp:120-126`) does nothing if the transaction
  has deleted local rows (`deleted_rows != 0`). Otherwise it calls `OptimisticDataWriter::WriteNewRowGroup`
  (`optimistic_data_writer.cpp:74-116`):
  * add the row group to `unflushed_row_groups`.
  * **flush threshold**: `unflushed ≥ write_buffer_row_group_count` (default **5**,
    `settings.hpp:2483-2494`), or `unflushed_data_size ≥ write_buffer_row_group_memory_limit`
    (default `maximum_memory / 5 / (threads + 1)`, `:94-101`).
  * `FlushToDisk` (`:184-199`) → `RowGroup::WriteToDisk(info, row_groups)` (`row_group.cpp:1436-1487`),
    which compresses exactly as a checkpoint would, then `SetRowGroup` replaces the in-memory
    row groups with persistent ones. `FinalizeFlush` moves them to `flushed_row_groups` (`:118-122`).
* E10 (§11): 4 completed row groups inside a txn → still 1 block. Completing the 5th
  flushes the batch at once (1 → 11 blocks). COMMIT flushes the rest (→ 12).

The **merge threshold** for commit-time behaviour is `IsBulkAppend` (`local_storage.cpp:146-152`):
`total_rows ≥ row_group_size` and no deletes and not dropped.

### 5.3 Parallel `PhysicalInsert`

The plan is parallel iff insertion order need not be preserved, there is no `RETURNING` and no
`ON CONFLICT UPDATE`, and threads > 1 (`execution/physical_plan/plan_insert.cpp:101-141`). If
order must be preserved and all sources support batch indexes, `PhysicalBatchInsert` is used
instead (`:125-130`, `UseBatchIndex` `:60-71`).

* **Sink** (`physical_insert.cpp:598-653`): on first chunk each thread creates its *own*
  `OptimisticDataWriter` + `OptimisticWriteCollection` (with `PER_COLUMN` partial block managers,
  `optimistic_data_writer.cpp:52-72`, default type `optimistic_data_writer.hpp:40-42`). It registers
  the collection in `LocalTableStorage::optimistic_collections` (`local_storage.cpp:243-247`).
  Full row groups go through `WriteNewRowGroup` (same 5-row-group / memory threshold).
* **Combine** (`:655-698`): `FinalizeAppend`. If the thread has ≥ 1 row group of rows, it calls
  `WriteUnflushedRowGroups` (`optimistic_data_writer.cpp:124-162`). This writes every unflushed row
  group *including the trailing partial one*, merges the per-column partial managers into the writer's
  manager, and sets `REQUIRE_NEW` append mode. Then **`FinalFlush`** (`:217-222`) flushes this
  **thread's** partial blocks. Then, under `gstate.lock`, `LocalStorage::LocalMerge`
  (`local_storage.cpp:483-497`) → `OptimisticWriteCollection::MergeStorage` (`optimistic_data_writer.cpp:165-182`)
  → `RowGroupCollection::MergeStorage` moves the row groups into the transaction-local primary
  collection, and `optimistic_writer.Merge` moves partial-block state (`:201-215`). Threads
  with fewer rows are deferred to `unmerged_collections`.
* **Finalize** (`:765-816`): if the total is less than one row group, it re-appends everything through the normal
  `LocalAppend` path. Otherwise it groups leftovers into row-group-sized `CollectionMerger`s and runs
  `MergeCollectionsEvent` (`:723-763`). Each task re-appends into the first collection, flushing
  through its own writer (`collection_merger.hpp:51-100`). `FinishEvent` calls `LocalMerge` +
  `Merge` + `FinalFlush` on the transaction-level writer (`physical_insert.cpp:743-754`).
* There is no function named `FinalizeOptimisticWriter` in this commit. Its role is
  `FinalFlush` + `OptimisticDataWriter::Merge`.

E3p (§11) shows the per-thread structure on disk. 8 threads produce 8 separate partial blocks for
column `i` (blocks 99,100,106,107,113,115,118,119, each holding 6–7 row groups). Row-group ids
interleave input ranges (rg0 = 245760…, rg1 = 1105920…) because collections are concatenated in
Combine order.

### 5.4 `PhysicalBatchInsert` (order-preserving)

`execution/operator/persistent/physical_batch_insert.cpp`:

* `RowGroupBatchEntry {batch_idx, total_rows, unflushed_memory, collection_index, type}`
  (`:39-54`). `type` is `FLUSHED` or `NOT_FLUSHED` (`collection_merger.hpp:19`).
* Per batch index, a thread fills a fresh collection (`Sink` `:426-483`, `CreateNewCollection` `:115-127`).
  On `NextBatch` (`:378-414`) the collection is handed to `AddCollection` (`:291-326`):
  * `≥ row_group_size` rows → `FLUSHED`, and **written immediately** by
    `WriteUnflushedRowGroups` (`:301-304`).
  * smaller → `NOT_FLUSHED` and kept in memory, tracked by `BatchMemoryManager` (`:309-311`).
* `ScheduleMergeTasks` (`:200-274`) walks *contiguous* `NOT_FLUSHED` entries with
  `batch_idx ≤ min_batch_index` and schedules a `MergeCollectionTask` when the sum is
  **`ReadyToMerge`** (`:179-198`): 90–100 %, 180–200 %, 270–300 % or ≥ 360 % of `row_group_size`.
  The task merges + flushes (`MergeCollections` `:276-289` → `CollectionMerger::Flush`) and marks the
  entry `FLUSHED` (`:133-168`).
* Memory pressure: non-minimum batches block when `OutOfMemory` (`:436-454`). The reservation is
  `4 MiB × columns` per thread (`:345-347`, `MaxThreads` `:95-100`).
* `Combine` (`:488-521`) adds the final collection *without* a writer (no immediate flush) and merges
  the thread writer into the transaction writer.
* `Finalize` (`:526-612`): if anything was written or `insert_count ≥ row_group_size`, it walks
  entries in batch order. It merges runs of `NOT_FLUSHED` collections into one merger, gives each
  `FLUSHED` collection its own merger, then calls `Flush`, `LocalMerge` in order, and `FinalFlush`. Otherwise
  it does a plain `LocalAppend`.
* CTAS: `PhysicalBatchInsert`/`PhysicalInsert` with `info` creates the table in
  `GetGlobalSinkState` (`:331-343`). The plan choice mirrors INSERT (`plan_create_table.cpp:21-32`).

### 5.5 `CREATE TABLE AS`, `COPY FROM`, `INSERT … SELECT`

All three are `LogicalInsert`s:

* `COPY FROM` binds an `InsertStatement` over the file scan (`planner/binder/statement/bind_copy.cpp:542-585`).
* CTAS → `plan_create_table.cpp:21-32`.
* `INSERT … SELECT` → `DuckCatalog::PlanInsert`.

They therefore use §5.2–5.4 unchanged. `COPY FROM DATABASE` is also a set of
INSERT nodes (§7.1).

### 5.6 Commit: attaching pre-written row groups

1. **Before locks**: `PreFlushOptimisticBlocks` → `FlushBulkAppendBlocksAndSync`
   (`local_storage.cpp:610-626`). For every `IsBulkAppend` storage it calls `FlushBlocks` (`:128-136`:
   `WriteUnflushedRowGroups` + `FinalFlush`), then one **`BlockManager::FileSync()`** so
   that WAL-referenced blocks are durable before the WAL entry exists (`duck_transaction.cpp:248-250`).
2. `LocalStorage::Commit` → `Flush(table, storage, commit_state)` (`local_storage.cpp:559-608`, `:628-639`):
   * `IsBulkAppend` (or an empty non-writable table) → `FlushBlocks`, `AppendToIndexes`, and
     **`DataTable::MergeStorage`** (`data_table.cpp:1165-1168`) → `RowGroupCollection::MergeStorage`
     (`row_group_collection.cpp:854-919`). Row groups are **moved** (no copy) into the table. For the
     leading run of persistent row groups it calls `SerializeRowGroupInfo` and records
     `commit_state->AddRowGroupData` (`storage_manager.cpp:683-696`). It skips this if the row groups
     carry in-memory updates.
   * otherwise (deletes after bulk append, small inserts) → **`storage.Rollback()`** (frees any
     optimistic blocks, §5.7) and append row by row into transient table storage (`:595-601`).
3. WAL: `WriteToLog` (`data_table.cpp:1170-1202`). If row-group data exists, it calls
   **`WriteRowGroupData`** (`write_ahead_log.cpp:511-523`), which serializes the
   `PersistentCollectionData` (block pointers, stats) and then calls **`MarkBlockAsCheckpointed`**
   for every block. Remaining rows go as `INSERT_TUPLE`. So the WAL records **pointers only** for
   optimistic data (E3: 3M rows → 10 KiB WAL. E3p: 6M rows → 20 KiB).
4. `FlushCommit` → `wal.Flush()` (WAL fsync) (`storage_manager.cpp:674-681`, `write_ahead_log.cpp:576-588`).
5. At the next checkpoint the unchanged columns go through `MarkBlockAsCheckpointed` again and are
   **not rewritten** (§4.1.3).

### 5.7 ROLLBACK / abort

* `DuckTransaction::Rollback` → `LocalStorage::Rollback` (`local_storage.cpp:641-653`) →
  `LocalTableStorage::Rollback` (`:264-278`):
  1. `optimistic_writer.Rollback()` → `PartialBlockManager::Rollback` → `ClearBlocks`
     (`partial_block_manager.cpp:190-195`, `:212-214`). This discards unflushed partial blocks. They
     have no block id yet (`INVALID_BLOCK`), so nothing on disk is involved.
  2. `CommitDropTable(drop_state)` on every optimistic collection and on the primary collection,
     then `FinalizeCommit` → `MarkBlockAsModified` on each block (`commit_state.cpp:46-60`).
     Because the blocks are in `newly_used_blocks`, they are **freed immediately**
     (`single_file_block_manager.cpp:988-993`). They go into `free_list` if no handle is alive, otherwise
     into `free_blocks_in_use`, and then move to `free_list` when the `LocalTableStorage` dies
     (`UnregisterBlock` `:1429-1440`).
* E1 (§11): after a 5M-row insert, ROLLBACK changes `free_blocks` 0 → 93 at once. The file
  stays 24.6 MB until a checkpoint that actually runs truncates the tail.
* Commit failure after `MergeStorage`: `RevertAppendInternal` drops the row groups without
  freeing blocks (`row_group_collection.cpp:784-820`). They remain in `newly_used_blocks` for the
  session (written as free in later headers). This is fixed upstream (§12).

### 5.8 Crash before commit: are orphan blocks leaked?

* Blocks taken **from the free list**: the on-disk header still lists them as free, so after
  restart they are free again. E6: `free_blocks` 57 → (uncommitted insert used them all) → **57**
  after kill -9.
* Blocks **beyond `block_count`** (file extension): the header's `block_count` excludes them, and
  `max_block = block_count` on load (`:827`). They are logically free (re-allocated as `max_block++`),
  but the **file stays physically large**. At `fb38af476a7`, `Truncate` only shrinks when trailing
  `free_list` ids exist (`:1222-1244`). E4b (exact build): the file stays 24 653 824 B while
  `total_blocks = 2`. The newer CLI truncates to `max_block` whenever the file is larger (§12).
* Committed-but-not-checkpointed optimistic blocks are reclaimed by WAL replay `MarkBlockAsUsed`
  (§3.5). E5: 58 blocks / 3M rows are recovered.

---

## 6. Index persistence and catalog writes

### 6.1 ART → blocks during checkpoint

Chain: `SingleFileTableDataWriter::FinalizeTable` → `TableIndexList::SerializeToDisk`
(`table_data_writer.cpp:199`, `storage/table_index_list.cpp:516-530`) → `IndexEntry::SerializeToDisk`
(`storage/index_entry.cpp:471-477`). Bound indexes go to `BoundIndex::SerializeToDisk`. **Unbound** indexes
(never loaded since the last restart) just return `CopyStorageInfo()`, so they keep their old blocks
untouched.

`ART::SerializeToDisk` (`execution/index/art/art.cpp:1048-1066`) calls `WritePartialBlocks` (`:1088-1097`):

* It creates a **fresh `PartialBlockManager(FULL_CHECKPOINT)` per index per checkpoint**. Index
  buffers therefore never share a block with table data or with other indexes. The manager is
  flushed at `:1096`.
* `FixedSizeAllocator::SerializeBuffers` (`fixed_size_allocator.cpp:301-305`) → for each buffer
  `FixedSizeBuffer::Serialize` (`fixed_size_buffer.cpp:83-147`):
  * on disk and not dirty → **reused as is** (no write) (`:87-98`).
  * dirty and previously on disk → `MarkBlockAsModified(old)` (`:106-109`), so the old block is freed after this header.
  * gets a `PartialBlockAllocation` (eagerly allocated id, `GetFreeBlockIdForCheckpoint`), copies
    into a shared partial block or creates a `PartialBlockForIndex` (`:113-140`), then re-registers the handle.
  * `PartialBlockForIndex::Flush` → `ConvertToPersistent` (W6, `:17-21`).
* `FixedSizeAllocator::GetInfo` (`:277-299`) records `block_pointers`, `segment_counts`, and
  `allocation_sizes`. These go into `index_storage_infos` in the table metadata
  (`table_data_writer.cpp:214-216`).
* Freeing: `~FixedSizeBuffer` marks on-disk blocks modified (`fixed_size_buffer.cpp:68-81`), and so does
  `UnboundIndex::ResetStorage` (`unbound_index.cpp:36-45`).
* Inserts made while a checkpoint runs go into delta indexes, which are merged afterwards
  (`MergeCheckpointDeltas`, `checkpoint_manager.cpp:361-371`, `table_index_list.cpp:543-548`).

`CREATE INDEX` itself writes the *entire* serialized ART into the WAL
(`write_ahead_log.cpp:388-420` `SerializeIndex/WriteCreateIndex`, `art.cpp:1068-1086 SerializeToWAL`).
E9: a 1M-key index produced a 36.2 MiB WAL, and the checkpoint then wrote 148 index blocks. After a
1-row insert + CHECKPOINT, only about 4 dirty buffers were rewritten (4 blocks freed). DROP INDEX +
CHECKPOINT returned to the table-only 34 blocks. On replay, `ReplayIndexData` writes those
buffers straight into file blocks (W11).

### 6.2 Catalog

The catalog lives entirely in metadata blocks:

* `CreateCheckpoint` serializes `catalog_entries` with `BinarySerializer(*metadata_writer)`
  (`checkpoint_manager.cpp:272-278`).
* Table data pointers go through a second writer, `table_metadata_writer` (`:211-213`, `GetTableDataWriter` `:110-112`).
* Each `Write*` (`:469-690`) serializes the `CreateInfo`.
* `header.meta_block` = the first sub-block pointer (`:216`, `:292-293`).
* Nothing reaches disk before `MetadataManager::Flush` inside `WriteHeader` (§8.4).

---

## 7. Other writers

### 7.1 `COPY FROM DATABASE` / ATTACH-copy

`Binder::Bind(CopyDatabaseStatement)` (`planner/binder/statement/bind_copy_database.cpp:105-...`):
`BindCopyDatabaseSchema` (`:24-49`) creates the catalog entries (WAL + metadata at the next checkpoint).
`BindCopyDatabaseData` (`:51-103`) builds one `InsertStatement` per table (`:63-84`). Data therefore uses the
optimistic insert paths (§5). The modification type is `INSERT_DATA` (`:134`).

### 7.2 Storage compaction (checkpoint vacuum, Truncate, Trim)

* Vacuum only happens for **FULL** checkpoints (`row_group_collection.cpp:1461-1465`). It drops empty
  row groups (`:1488-1554`) and merges sparse adjacent row groups with `VacuumTask`
  (`:1295-1455`, `ScheduleVacuumTasks` `:1556-1692`, limit `max_vacuum_tasks` = 100,
  `settings.hpp:1879-1889`). Indexes may block rowid changes (`GetVacuumIndexStrategy` `:81-94`,
  `vacuum_rebuild_indexes` `settings.hpp:2413-2427`). Dropped inputs → `RowGroup::CommitDrop()`
  (`row_group.cpp:648-652`) → `MarkBlockAsModified` → freed after this header.
* The file shrinks only through `Truncate` (W9) of a **contiguous free tail** after the header. Free
  blocks in the middle stay as holes in the file (optionally punched with `trim_free_blocks`, W10).
  E7 step 6: 50 % DELETE + CHECKPOINT went from 48 → 32 total blocks.

### 7.3 ALTER TABLE

* `ADD COLUMN` / `ALTER TYPE` / `DROP COLUMN` build a new `RowGroupCollection` in memory
  (`row_group_collection.cpp:2183-2282` `AddColumn`/`RemoveColumn`/`AlterType`). New column data is **transient** until the next checkpoint
  (E8: `[1]` segments `persistent=false` after `ALTER TYPE`). The WAL holds only the ALTER statement
  (205 B), and replay recomputes it.
* The old column's blocks are released at commit via `CommitEntryDrop` → `DuckTableEntry::CommitAlter`
  → `DataTable::CommitDropColumn` → `CommitDropState::DropBlock` (`commit_state.cpp:178-198`,
  `duck_table_entry.cpp:1452-1477`, `row_group.cpp:642-646`). `FinalizeCommit` calls `MarkBlockAsModified`,
  so the blocks land in **`modified_blocks`** and become free only after the next header (E8: 17 → 33 total,
  15 free).
* Transaction-local storage is transformed too (`local_storage.cpp:32-78`, `:690-721`). Its optimistic
  writer is re-created and `ClearBlocks`es the parent's partial blocks (`optimistic_data_writer.cpp:18-23`).

### 7.4 UPDATE

* Updates live in in-memory `UpdateSegment`s. The WAL records `UPDATE_TUPLE` chunks
  (`write_ahead_log.cpp:535-545`). E7: 1M string updates → 20.9 MiB WAL, with blocks unchanged.
* At checkpoint, `ColumnData::HasAnyChanges` → `WriteToDisk` rewrites the whole column of each touched row
  group (`column_data_checkpointer.cpp:310-358`), merging committed updates during the scan
  (`CheckpointScan`, `column_data.cpp:835-851`). `DropSegments` frees the old blocks after the header.
* A transaction with updates cannot auto-checkpoint while others are active (§3.3). Large updates
  may skip the WAL and checkpoint directly (E7 with the default threshold: the WAL was 0 B right after commit).

### 7.5 DELETE

* Delete markers live in `RowVersionManager`. The WAL records row ids (E7: 500k deletes → 3.8 MiB WAL).
* At checkpoint, `RowGroup::CheckpointDeletes` (`row_group.cpp:1942-...`) →
  `RowVersionManager::Checkpoint` (`row_version_manager.cpp:238-...`) writes delete vectors into
  **metadata** (a new `MetadataWriter`), or reuses the old pointers with `ClearModifiedBlocks` when
  nothing changed (`:242-248`). Data blocks are rewritten or dropped only by vacuum (§7.2).
* Deletes inside a bulk-insert transaction disable optimistic writes (`local_storage.cpp:121-123`) and force
  the fallback path at commit (`:592-601`).

### 7.6 DROP TABLE

`CommitState::CommitEntryDrop` (`commit_state.cpp:233-242`) → `DuckTableEntry::CommitDrop` (`duck_table_entry.cpp:1479-1481`)
→ `RowGroupCollection::CommitDropTable` (`row_group_collection.cpp:2102-2107`) → `VisitBlockIds` → `DropBlock`.
`DuckTransaction::Commit` then calls `drop_state.FinalizeCommit()` (`duck_transaction.cpp:283-297`), and
`MarkBlockAsModified` puts each block into `modified_blocks`.

* The blocks are **not reusable until the next header** (E3 step 3: `free_blocks` stayed 0 after DROP).
* The table's metadata sub-blocks are freed by `MetadataManager::MarkBlocksAsModified` at the next
  header because nothing `ClearModifiedBlocks`es them (§8.4).
* DROP takes the shared checkpoint lock, so it never commits *during* a checkpoint (§3.2).

---

## 8. Boundaries

### 8.1 Allocation rules

* **Only `free_list` is ever allocated from** (`:898-917`). `free_list` contains blocks that are
  free in the *last durable header* **and** in memory. Blocks freed since the last header are
  either in `modified_blocks` (previously durable) or were never durable (`newly_used` → straight back
  to `free_list`, `:988-993`).
* Lowest-id-first (`*free_list.begin()`) and `max_block++` on empty. `MetadataManager::AllocateHandle`
  prefers a new block over a partially free metadata block with a higher id (`metadata_manager.cpp:69-71`).

### 8.2 What `WriteHeader` does to every set

`single_file_block_manager.cpp:1320-1423`, in order:

| Step | Lines | `free_list` | `modified_blocks` | `newly_used_blocks` | `multi_use_blocks` | metadata |
|---|---|---|---|---|---|---|
| a. reserve free-list sub-blocks | `:1321`, `GetFreeListBlocks` `:1246-1278` | may shrink (new metadata blocks via `GetFreeBlockIdForCheckpoint`) | – | – | – | `AllocateHandle` until large enough |
| b. `MarkBlocksAsModified` | `:1326`, `metadata_manager.cpp:386-419` | – | **+ fully freed metadata blocks** | – | – | sub-blocks of the *previous* checkpoint not re-claimed become free. `modified_blocks(meta)` := every occupied sub-block now |
| c. snapshot under lock | `:1328-1342` | copied → `all_free_blocks` | **copied** (`checkpoint_freed_blocks`) and added to `all_free_blocks` | added to `all_free_blocks` | copy minus newly used | iteration++ |
| d. serialize free list | `:1344-1368` | – | – | – | – | `FreeListBlockWriter` into reserved handles. Also `MetadataManager::Write` (block list) |
| e. flush metadata (W5) | `:1369-1370` | – | – | – | – | all dirty metadata blocks written |
| f. `block_count = max_block` | `:1372-1374` | – | – | – | – | **read after (e)**: race, §12 |
| g. `Sync`, (main header), header (W7), `Sync` | `:1384-1410` | – | – | – | – | durable point |
| h. release | `:1411-1420` | **+ `checkpoint_freed_blocks`** (or `free_blocks_in_use` if a handle is alive) | − `checkpoint_freed_blocks` | – | – | – |
| i. trim | `:1422` | – | – | – | – | hole punch if enabled |

Consequences:

1. **A block freed by checkpoint N** (rewritten column, vacuumed row group, dropped table, freed
   metadata block) becomes allocatable **after header N is fsynced**. It is never allocatable during
   checkpoint N itself.
2. **A block freed between checkpoints N and N+1** (DROP, ALTER, commit-time drops) sits in
   `modified_blocks` and becomes allocatable after header N+1. This is the "freed at next
   checkpoint" rule, and it matches the upstream PR title "Do not reuse blocks freed by a checkpoint until its header is
   durable" (commit `1386ff2e701`, in `fb38af476a7`'s history).
3. Blocks freed during checkpoint N by modifications that are *not yet in `modified_blocks` at
   step c* stay there for checkpoint N+1. Step c is the only cut point.
4. `newly_used_blocks` are written as free **and stay in memory as used**. On a crash the uncommitted
   transaction's blocks are free. After commit they are referenced by the WAL, and replay re-marks them used.

### 8.3 `Truncate` and WAL finish ordering

`checkpoint_manager.cpp:296` (header durable) → `:333` `Truncate` (drop trailing `free_list` ids and
`ftruncate`, `:1222-1244`) → `:339-352` `WALFinishCheckpoint` (`storage_manager.cpp:307-336`):

* No concurrent commits (checkpoint WAL never initialized): `TryRemoveFile(x.db.wal)`, reset the entry counter,
  and use a new lazy WAL (`:313-321`).
* Concurrent commits: close, then `MoveFile(x.db.wal.checkpoint → x.db.wal)`, re-open, `Initialize` (`:323-335`).

The **WAL is deleted or replaced strictly after the header and the file truncation**. A crash in between leaves
a WAL whose `CHECKPOINT(meta_block)` marker equals the header's `meta_block`.
`IsCheckpointClean` (`storage_manager.cpp:723-725`) then makes replay skip it (`wal_replay.cpp:524-561`).
A non-matching marker (crash before the header) causes a replay of the main WAL plus a merge with `.wal.checkpoint`
(`MergeIntoRecoveryWAL` `:397-453`, `:562-571`).

### 8.4 `MetadataManager` state machine

* `blocks`: `block_id → MetadataBlock{free_blocks, dirty, handle}`. `modified_blocks`: `block_id → bitmask`.
* At load: `LoadFreeList` → `Read` + `MarkBlocksAsModified` (`single_file_block_manager.cpp:870-892`), so
  `modified_blocks` = everything occupied in the loaded checkpoint.
* During a checkpoint, writers that reuse old metadata call `ClearModifiedBlocks`
  (`metadata_manager.cpp:421-437`; callers `row_group_collection.cpp:1780-1784`, `table_data_writer.cpp:145`,
  `row_group.cpp:1750-1751,1873,1947`, `row_version_manager.cpp:245`).
* At `WriteHeader` step b, non-cleared old sub-blocks become free in their `MetadataBlock`. A fully free
  block is erased and passed to `BlockManager::MarkBlockAsModified` (freed after *this* header). Then
  `modified_blocks` is reset to "all currently occupied". **This is the only reset point**, and it happens once per
  checkpoint.
* `AllocateHandle` on a persistent metadata block with free sub-blocks calls `ConvertToTransient`
  (`:130-150`). `Flush` writes it back **to the same block id** (`:295-309`). This is the only *in-place*
  overwrite of a block that the current durable header still references (bean `repos-3m23`).

### 8.5 `PartialBlockManager` lifetimes

| Owner | Type | Created | Flushed | Reset / discarded |
|---|---|---|---|---|
| `SingleFileCheckpointWriter::partial_block_manager` | `FULL_CHECKPOINT` | per checkpoint (`checkpoint_manager.cpp:91-95`) | **end of every table**: `RowGroupCollection::Checkpoint` → `writer.FlushPartialBlocks()` (`row_group_collection.cpp:2049`, `table_data_writer.cpp:92-94`). Partial blocks are *not* shared across tables | destroyed with the writer |
| ART per index | `FULL_CHECKPOINT` | `ART::WritePartialBlocks` (`art.cpp:1090`) | end of that index (`:1096`) | stack |
| `OptimisticDataWriter::partial_manager` (per thread, per merge task, per `LocalTableStorage`) | `APPEND_TO_TABLE` | `PrepareWrite` (`optimistic_data_writer.cpp:44-48`) | `FinalFlush` (`:217-222`). Called in parallel `Combine` per thread (`physical_insert.cpp:682`), `MergeCollectionsEvent::FinishEvent`, `PhysicalBatchInsert::Finalize` (`:584`), and `LocalTableStorage::FlushBlocks` at commit | `Merge` into a parent (`:201-215`, `partial_block_manager.cpp:162-188`); `Rollback` → `ClearBlocks` |
| `OptimisticWriteCollection::partial_block_managers` (per column) | `APPEND_TO_TABLE` | `CreateCollection(PER_COLUMN)` (`:64-70`) | merged into the writer in `WriteUnflushedRowGroups` (`:155-160`) | cleared there |

Rules inside a manager (`partial_block_manager.cpp`):

* A segment ≤ 80 % of a block (`max_partial_block_size = block_size/5*4`, `:42-54`) can share a block.
* `RegisterPartialBlock` keeps a block while ≥ 20 % is still free. Otherwise it flushes it immediately (`:128-160`).
* `FULL_CHECKPOINT` increments refcounts when sharing (`:69-73`). `APPEND_TO_TABLE` increments at flush
  (`column_checkpoint_state.cpp:87-90`), which creates the `multi_use_blocks` entries.
* Checkpoint `FlushSegmentInternal` serializes access with `partial_block_manager.GetLock()`
  (`column_checkpoint_state.cpp:165`) because checkpoint tasks run in parallel.

### 8.6 Concurrent optimistic writers during a checkpoint

* Allocation is serialized by `single_file_block_lock`. Writers can only receive `free_list` ids or new
  `max_block` ids, never anything the old header references (§8.1). Their blocks are `newly_used`.
* If allocated before step c, they are serialized as free in header N. If allocated after, they were
  in `free_list` at step c (free) or beyond step c's view. In `fb38af476a7`, step f reads `max_block` later,
  so a block extended between c and f is counted in `block_count` but is not in the free list: a leak
  on crash. The upstream fix moved the read under the step-c lock (§12).
* A concurrent **commit** during the checkpoint writes `ROW_GROUP_DATA` to `.wal.checkpoint` and calls
  `MarkBlockAsCheckpointed`. The checkpoint excludes those row groups (§4.1.2), yet header N lists their blocks as
  used-but-unreferenced. After a crash, replay inflates their refcount. **Permanent leak** (§12, bean `repos-bp68`).

---

## 9. Timelines

Notation: `FL` = `free_list`, `MOD` = `modified_blocks`, `NEW` = `newly_used_blocks`,
`MU` = `multi_use_blocks`, `max` = `max_block`. The block ids are those observed in E7 and E3p.

### 9.1 Full checkpoint after an UPDATE (E7: 1M rows, `s` column rewritten)

```
state before: header iteration k; blocks 0..19 used; FL={} MOD={} NEW={} max=20
              UPDATE committed -> in-memory UpdateSegments, WAL 20.9 MiB

CHECKPOINT ─────────────────────────────────────────────────────────────────────
t0  Checkpoint(): TryGetExclusiveLock(checkpoint_lock) ............ dtm.cpp:229
t1  CreateCheckpoint: TryGetVacuumLock -> FULL ................... sm.cpp:739-751
t2  metadata_writer->GetMetaBlockPointer()  (AllocateHandle: may take sub-block
    of meta block or a new id via GetFreeBlockIdForCheckpoint) .... ckpt.cpp:216
t3  WALStartCheckpoint: WAL << CHECKPOINT(meta_block); fsync(x.db.wal);
    new lazy x.db.wal.checkpoint; checkpoint txn started ......... sm.cpp:251-305
t4  table t: exclusive table lock; RowGroupCollection::Checkpoint
      CheckpointTask(rg_i) in parallel:
        column i  : no changes -> MarkBlockAsCheckpointed (noop)    cdc.cpp:421-431
        column s  : WriteToDisk -> FlushSegment -> GetBlockAllocation
                    GetFreeBlockIdForCheckpoint: FL empty -> 20,21,...,41
                    DropSegments -> MarkBlockAsModified(old 1..17)   cdc.cpp:284-299
                    state:  FL={} MOD={1..17} NEW={} max=42
      writer.FlushPartialBlocks()  (end of table) ................. rgc.cpp:2049
t5  FinalizeTable: row-group pointers + index infos -> metadata writers
t6  WriteHeader:
      a reserve free-list handle
      b MetadataManager::MarkBlocksAsModified (old sub-blocks freed; fully free
        meta blocks -> MOD)
      c snapshot: all_free = FL ∪ MOD ∪ NEW = {1..17,...}
      d serialize free list   e MetadataManager::Flush (dirty meta blocks)
      f block_count = max = 42
      g fsync; write h[1-active] (iteration k+1); fsync     <== DURABLE POINT
      h FL += {1..17}  MOD = {}                              (now reusable)
t7  Truncate: tail of FL contiguous with max? (no: 41 used) -> no-op
t8  WALFinishCheckpoint: remove x.db.wal (checkpoint WAL untouched)
t9  MergeCheckpointDeltas; commit checkpoint txn; ResetActiveCheckpoint
observed: total 42, used 25, free 17, wal 0 B
next UPDATE + CHECKPOINT: s rewritten into blocks 1..47 (re-uses FL first)
```

### 9.2 Parallel bulk INSERT transaction with commit (E3p: 8 threads, 6M rows, 49 RGs)

```
state: FL={} MOD={} NEW={} max=1 (block 0 = metadata)    WAL 0 B

T1..T8 Sink (PhysicalInsert parallel)
  each Ti: own OptimisticDataWriter + collection (PER_COLUMN PBMs)   pi.cpp:630-641
  every full row group -> WriteNewRowGroup; when 5 unflushed:          odw.cpp:74-116
     FlushToDisk -> compress -> PartialBlockForCheckpoint::Flush
       block id chosen lazily: GetFreeBlockId -> max++  => NEW += {id}
     (ids interleave across threads: 1,2,3,... in flush order)
Ti Combine
  WriteUnflushedRowGroups (incl. trailing partial RG); merge per-column PBMs
  FinalFlush: flush Ti's partial blocks (column i: one block per thread,
              e.g. 99,100,106,107,113,115,118,119; each 6-7 bitpacked segs)
  LocalMerge -> MergeStorage into txn-local collection; writer.Merge
Finalize: leftover (<1 RG) collections -> MergeCollectionsEvent -> FinalFlush
state after statement: FL={} NEW={1..119} max=120   (autocommit continues)

COMMIT
c1 PreFlushOptimisticBlocks: FlushBlocks (no-op now) + fsync(x.db) ... lst.cpp:610
c2 CanCheckpoint: est. size = pointer-sized -> no auto checkpoint
c3 WAL lock; LocalStorage::Flush: IsBulkAppend -> DataTable::MergeStorage
     (row groups moved, AddRowGroupData) ........................... rgc.cpp:854-919
c4 UndoBuffer::WriteToWAL -> WriteRowGroupData (pointers, 20.2 KiB)
     -> MarkBlockAsCheckpointed(1..119): NEW = {} ................. wal.cpp:511-523
c5 FlushCommit: WAL fsync                               <== DURABLE (via WAL)
     crash now: header lists 1..119 free (or beyond block_count);
     replay pass 1 MarkBlockAsUsed -> recovered (E5)
state: FL={} NEW={} max=120; used 120

later CHECKPOINT: all columns unchanged -> MarkBlockAsCheckpointed only;
  282/282 segments keep block_id+offset; header block_count=120; WAL removed
```

### 9.3 Rollback variant (E1)

```
BEGIN; INSERT 5M rows   -> NEW={1..93} max=94; file 24.6 MB; free_blocks 0
ROLLBACK                -> LocalTableStorage::Rollback -> MarkBlockAsModified
                           newly-used => AddFreeBlock => FL={1..93}; free_blocks 93
CHECKPOINT (WAL empty)  -> no-op (sm.cpp:760): file still 24.6 MB
CREATE TABLE tiny; CHECKPOINT -> header; Truncate trailing FL -> 1 block, 274432 B
```

---

## 10. Multi-threaded interplay

### 10.1 Lock matrix

| Lock | Holder (shared) | Exclusive holder | Source |
|---|---|---|---|
| checkpoint lock (`DuckTransactionManager::checkpoint_lock`) | txns with update/alter/create/drop/sequence/create-index | explicit CHECKPOINT; auto-checkpoint (upgrade) | `duck_transaction.cpp:347-361,373-379`, `dtm.cpp:229-247,153-157` |
| vacuum lock | txns with insert/delete (`SetModifications`) | FULL checkpoint (`TryGetVacuumLock`) | `duck_transaction.cpp:362-370`, `sm.cpp:739-751` |
| per-table `DataTableInfo::checkpoint_lock` | appends (`AppendLock`), scans (`SharedLockTable`) | `WriteTable` while that table is checkpointed | `data_table.cpp:1046-1064,1323,1572-1574`, `ckpt.cpp:705` |
| WAL lock | commit WAL write; `WALStartCheckpoint` (briefly); whole checkpoint if the WAL write was skipped | – | `sm.cpp:251-258,338-340`, `dtm.cpp:337-356,428-433` |
| `single_file_block_lock` | all block-set mutations | – | `single_file_block_manager.hpp:230` |

### 10.2 Concurrent checkpoint while others insert

* A **FULL** checkpoint holds the vacuum lock exclusively. New inserting statements **block in
  `SetModifications`** until the checkpoint ends. Measured with `debug_checkpoint_sleep_ms=3000`, the insert
  committed 3.18 s after checkpoint start, after the checkpoint finished (§11 E12a).
* If an inserter already holds the vacuum lock, the checkpoint becomes **CONCURRENT**:
  * The inserter keeps writing optimistic blocks (`NEW`, written as free in the header).
  * Its commit goes to `.wal.checkpoint` (`WALStartCheckpoint` swapped the WAL).
  * Its append waits on the table lock if that table is being checkpointed. If the table has not been
    checkpointed yet, the append starts a new row group (`AppendRequiresNewRowGroup`), and that row group is
    excluded from this checkpoint.
  * `WALFinishCheckpoint` moves `.wal.checkpoint` over the main WAL, so the commit is replayed after a crash.
  * Measured: insert committed at +159 ms, checkpoint done at +3014 ms (E12b).
* Index appends during a checkpoint go to deltas, which are merged at the end.
* Readers holding old segments keep their `BlockHandle`s alive. Blocks freed at step h go to
  `free_blocks_in_use` and are only reused after `UnregisterBlock`, which prevents read-after-reuse.

---

## 11. Empirical validation

Unless noted, all runs used `latest` = `v2.0.0-alpha49003 (b32b1368b8)` with `-no-agent`, in `/tmp/atlas04`.
`exact` = `build/release/duckdb` / `unittest` at `fb38af476a7`. Outputs are trimmed to the relevant columns.

### E1 — large INSERT in a transaction, then ROLLBACK

```
CREATE TABLE t(i BIGINT, s VARCHAR); CHECKPOINT;
A: after create+checkpoint      total 1   used 1   free 0   file 274432
BEGIN; INSERT INTO t SELECT i,'str'||i FROM range(5000000);
B: in txn after insert          total 94  used 94  free 0   file 24653824
ROLLBACK;
C: after rollback               total 94  used 1   free 93  file 24653824
CHECKPOINT;                     -- WAL empty -> no checkpoint
D: CHECKPOINT w/ empty WAL      total 94  used 1   free 93  file 24653824
CREATE TABLE tiny(x INT);       wal 170 bytes
CHECKPOINT;
F: CHECKPOINT w/ non-empty WAL  total 1   used 1   free 0   file 274432
```

Optimistic blocks are written before commit, and rollback frees them **immediately** (newly-used → `free_list`).
Truncation needs a checkpoint that actually runs.

### E3 / E3p — parallel insert, block ids before vs. after checkpoint; DROP TABLE

```
SET threads=8; SET preserve_insertion_order=false;
INSERT INTO t SELECT * FROM mem.src;          -- 6M rows from a parallel scan
B: after INSERT commit  total 120 used 120 free 0  wal 20.2 KiB
row_groups 49 | on_disk_segments 184 | distinct_blocks 119 | blocks 1..119
column [0] partial blocks (one per thread):
  block 99 segs 6 rg 0-5 | 100: 6-11 | 106: 12-17 | 107: 18-23
  113: 24-29 | 115: 30-35 | 118: 36-41 | 119 (7): 42-48
rg0 i in [245760,368639], rg1 [1105920,1228799], rg2 [2211840,...]   (interleaved)
CHECKPOINT;
segments 282 | unchanged_location 282
C: after CHECKPOINT     total 120 used 120 free 0 wal 0
```

E3 (same with `range()` as the source, so effectively one producer): 25 row groups, 58 blocks, 141 segments
unchanged after CHECKPOINT. Block 55 held 26 segments (`[0]:BitPacking` of all row groups). Then:

```
DROP TABLE t;
3: after DROP (committed, pre-checkpoint) total 58 used 58 free 0  wal 92 bytes  file 15216640
CHECKPOINT;
4: after CHECKPOINT                       total 1  used 1  free 0                file 274432
```

DROP only moves blocks into `modified_blocks` (not counted as free). The next header frees them and `Truncate` cuts the tail.

### E4 / E4b — crash (kill -9) before commit, file at the end

```
B: in txn, about to kill -9   total 94 used 94 free 0   file 24653824
-- restart --
C: after restart              total 1  used 1  free 0   (count(*) = 0)
INSERT (1,'x'); CHECKPOINT
latest:  D total 2 used 2  file 536576       <- truncated to block_count
exact :  D total 2 used 2  file 24653824     <- orphan tail stays (fb38 Truncate)
```

### E5 — crash after commit (WAL holds only ROW_GROUP_DATA)

```
INSERT 3M rows (autocommit) -> total 58, wal 10.1 KiB; kill -9
files: e5.db 15216640, e5.db.wal 10351
restart: total 58 used 58 free 0 wal 10.1 KiB rows 3000000   (MarkBlockAsUsed)
on exit: e5.db.wal removed (shutdown checkpoint, wal_size>0)
```

### E6 — crash before commit while the free list has holes

```
A: hole in middle            total 58  used 1   free 57
B: uncommitted bulk insert   total 321 used 321 free 0      file 84160512
-- kill -9, restart --
C: after restart             total 58  used 1   free 57
```

### E7 — UPDATE / DELETE (`checkpoint_threshold='1GB'`)

```
1: baseline            total 20 used 20 free 0  s_blocks 0..18  wal 0
UPDATE t SET s=s||'!'
2: after UPDATE commit total 20 used 20 free 0  s_blocks 0..18  wal 20.9 MiB  (30 segs has_updates)
CHECKPOINT
3: after CHECKPOINT    total 42 used 25 free 17 s_blocks 20..41 wal 0
2nd UPDATE + CHECKPOINT: total 48 used 26 free 22 s_blocks 1..47   (old ids reused)
DELETE 50 %: wal 3.8 MiB; CHECKPOINT: total 32 used 16 free 16 rows 500000
```

With the default 16 MiB threshold, the same UPDATE auto-checkpointed at commit (the WAL was 0 B right after commit, with s_blocks 20..41).

### E8 — ALTER TYPE / ADD COLUMN

```
1: baseline              total 17 used 17 free 0  wal 0
ALTER v TYPE BIGINT      total 17 used 17 free 0  wal 205 B   [1] persistent=false
ADD COLUMN w             wal 348 B
CHECKPOINT               total 33 used 18 free 15             all columns persistent
```

### E9 — ART index

```
1: table only                    total 34  used 34
CREATE INDEX idx ON t(k)         wal 36.2 MiB
CHECKPOINT                       total 182 used 182
INSERT 1 row; CHECKPOINT         total 187 used 183 free 4
DROP INDEX; CHECKPOINT           total 34  used 34
```

### E10 — `write_buffer_row_group_count` (threads=1)

```
BEGIN; INSERT 4*122880+1000 rows     total 1   (4 completed RGs buffered)
INSERT 122880 more                    total 11  (5th completed -> batch flush)
COMMIT                                total 12  wal 2.1 KiB
```

### E11 — ATTACH with storage upgrade

```
md5 after create (v1.0.0)                         e057242d...
ATTACH (STORAGE_VERSION 'v1.2.0'); CHECKPOINT     e057242d...  (no write)
CREATE TABLE t2 ...; CHECKPOINT                    f91f178d...
```

### E12 — concurrent checkpoint + commit + crash (exact `unittest`, sqllogictest)

The test files were `/tmp/atlas04/test/leak_{seq,conc}.test`. The structure was a `concurrentloop` of two threads.
Thread 0 runs `CHECKPOINT db` with `debug_checkpoint_sleep_ms=3000`. Thread 1 runs
`BEGIN; INSERT 1 row; INSERT 2M rows; COMMIT`. Both run with `disable_checkpoint_on_shutdown`, followed by DETACH/ATTACH
(WAL replay), CHECKPOINT, DROP TABLE, CHECKPOINT.

```
E12a (no BEGIN; FULL checkpoint): ckpt start +0, ckpt done +3004 ms, insert committed +3181 ms
E12b                                   seq (sleep 0)          conc (sleep 3000)
0a ckpt start / 0b commit / 0c done    +0 / +161 / +2         +0 / +159 / +3014
1  after loop      total/used/free     39 / 39 / 0            39 / 39 / 0
2  after re-attach (rows)              2000002                2000002
3  after CHECKPOINT                    39 / 39 / 0            39 / 39 / 0
4  after DROP + CHECKPOINT             3 / 2 / 1              38 / 38 / 0     <-- leak
5  re-attach + DDL + CHECKPOINT        3 / 2 / 1              38 / 38 / 0     file 9973760
with debug_verify_blocks=true at step 4:
  Block verification failed - blocks "1, 2, ..., 37" were not found as being
  used OR marked as free ... Multi-use blocks: 11, 26, 36, 35
```

---

## 12. Divergences and defects

| Topic | `fb38af476a7` | `b32b1368b8` (latest CLI) | Evidence |
|---|---|---|---|
| Orphan file tail after crash | `Truncate` returns early when no trailing free ids, so the file stays large | truncates if `GetFileSize() > new_size` | `git diff fb38af476a b32b1368b8 -- src/storage/single_file_block_manager.cpp`. E4 vs E4b |
| `free_blocks_in_use` in the serialized free list | omitted (on-disk leak if the process ends before they move to `free_list` and another checkpoint runs) | inserted into `all_free_blocks` | same diff (`WriteHeader`) |
| `header.block_count` read | after `metadata_manager.Flush`, outside the snapshot lock (`:1369-1374`) | under the same lock as the snapshot | same diff |
| `RevertCommit` of optimistic blocks | not freed (`storage_manager.cpp:663-672`) | `MarkBlockAsModified` for each block | `git diff ... -- src/storage/storage_manager.cpp` |
| Stale metadata handle after `ConvertToTransient` | — | `SetDestroyBufferUpon(EVICTION)`, `Pin` retry | `metadata_manager.cpp` diff; commits `8eeb4e4f8db`, `e4531611d92` |

Defects recorded in Beans (tags `duckdb`, `file-atlas-flush-paths`):

* **`repos-bp68` (high).** Optimistic blocks committed during a CONCURRENT checkpoint leak permanently after a crash.
  `WriteRowGroupData` → `MarkBlockAsCheckpointed` makes header N treat the blocks as used. The checkpoint
  excludes those row groups. Replay's `MarkBlockAsUsed` then calls `IncreaseBlockReferenceCountInternal` (count 2),
  and the later drop goes 2→1 and never frees the block. Reproduced in E12. By code reading, it is still present in `b32b1368b8`.
* **`repos-3m23` (low).** `MetadataManager` rewrites metadata blocks in place, so they can be torn while the current header still
  references them. Also, `CheckpointOptions::wal_action` is a dead field (set at `attached_database.cpp:392`, never read).

---

## 13. Summary of invariants

1. **Exactly 11 writers** (W1–W11) put bytes into the `.duckdb` file. Eviction never writes persistent blocks,
   and transient blocks go to the temp directory only.
2. **Three checkpoint entry points**: explicit `Checkpoint`, commit, and `AttachedDatabase::Close`. None runs during load/WAL replay.
   With an empty WAL, none of them writes unless `force_checkpoint` is set or the action is `ALWAYS_CHECKPOINT`.
3. **Copy-on-write for data**: blocks are allocated only from `free_list` or `max_block`, never from a block the durable
   header references. The single exception is in-place rewrites of metadata blocks (§8.4).
4. **Free-after-durable**: anything previously durable and then freed goes to `modified_blocks` and becomes allocatable
   only after the next header's second fsync (`WriteHeader` step h).
5. **Never-durable blocks free instantly**: `newly_used` blocks freed by rollback or by a rewrite go straight to `free_list`.
6. **Optimistic blocks are written as free** in every header until a commit marks them checkpointed. A crash before commit
   therefore never leaks free-list blocks, though the file tail may stay large at `fb38`.
7. **The WAL carries pointers, not data, for bulk appends**. The referenced blocks are fsynced *before* the WAL entry
   (`FlushBulkAppendBlocksAndSync`), and replay re-marks them used.
8. **Ordering per checkpoint**: WAL marker fsync → data/index blocks → free list → metadata flush → fsync → header → fsync →
   release `modified_blocks` → truncate file → delete/replace WAL → merge index deltas.
9. **Checkpoint partial blocks never span tables** (flushed per table). ART partial blocks never span indexes.
   Optimistic partial blocks are per thread, merged into the transaction writer, and flushed at Combine/Finalize/commit.
10. **`MetadataManager::modified_blocks` resets once per checkpoint** (step b), relative to the previous checkpoint's footprint.
11. **FULL vs CONCURRENT**: any holder of the vacuum lock forces CONCURRENT, which writes the same structures but skips delete
    vacuum and row groups appended after the checkpoint started.
12. **`pragma_database_size().free_blocks` = `free_list.size()`**. Blocks awaiting the next checkpoint are reported as used.
