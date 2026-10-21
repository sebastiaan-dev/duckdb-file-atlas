# 03 — Tables, Row Groups and Columns in a `.duckdb` File, and How CHECKPOINT Writes Them

> **Scope.** This document covers how a table's data is laid out inside a single-file DuckDB database
> and exactly what a `CHECKPOINT` does to write it, both single-threaded and multi-threaded.
>
> **Source of truth.** DuckDB at commit `fb38af476a7` ("perf(variant): Optimize shredded vector value
> retrieval (#25458)"), checked out at `/Users/sgerrits/repos/duckdb`. All paths below are relative to that
> repository root. Citations use `path:line` or `path:start-end`, followed by the function name.
>
> **Empirical binary.** `/Users/sgerrits/.duckdb/cli/latest/duckdb`, which reports
> `v2.0.0-alpha49003 (Cyanoptera) b32b1368b8`. This is a nearby development build, **not** the exact
> source commit (see [§9 Limitations](#9-limitations-and-caveats)). The files it writes use storage
> version 69 (`StorageVersion::V2_0_0`, `src/include/duckdb/storage/storage_info.hpp:147`), and I confirmed
> that from the raw header bytes ([§6.6](#66-raw-bytes-decoding-the-pointer-graph-of-a1duckdb)).

---

## Table of contents

1. [The logical tree: from the file header to a segment's bytes](#1-the-logical-tree-from-the-file-header-to-a-segments-bytes)
2. [RowGroupCollection, RowGroup, RowGroupPointer and persistent column data](#2-rowgroupcollection-rowgroup-rowgrouppointer-and-persistent-column-data)
3. [The checkpoint flow for one table](#3-the-checkpoint-flow-for-one-table)
4. [Multi-threaded checkpoint](#4-multi-threaded-checkpoint)
5. [Counting row groups and segments, and how wide tables interleave](#5-counting-row-groups-and-segments-and-how-wide-tables-interleave)
6. [Empirical validation](#6-empirical-validation)
7. [Summary of invariants](#7-summary-of-invariants)
8. [Quick reference: serialized field IDs](#8-quick-reference-serialized-field-ids)
9. [Limitations and caveats](#9-limitations-and-caveats)

---

## 1. The logical tree: from the file header to a segment's bytes

### 1.1 Physical file regions

```
file offset 0          4096           8192          12288 (= BLOCK_START)
            ┌──────────┬──────────────┬─────────────┬───────────────┬───────────────┬─────
            │MainHeader│DatabaseHeader│DatabaseHeader│ block 0       │ block 1       │ ...
            │ (magic,  │   "h1"       │   "h2"       │ 262144 bytes  │ 262144 bytes  │
            │ version) │              │              │ [8B checksum  │               │
            │          │              │              │  + 262136 B]  │               │
            └──────────┴──────────────┴─────────────┴───────────────┴───────────────┴─────
```

* The file starts with three header slots of `Storage::FILE_HEADER_SIZE = 4096` bytes each
  (`src/include/duckdb/storage/storage_info.hpp:56`). Blocks start at
  `BLOCK_START = FILE_HEADER_SIZE * 3` (`src/include/duckdb/storage/single_file_block_manager.hpp:70`).
* Block `b` sits at `BLOCK_START + b * block_alloc_size`
  (`src/storage/single_file_block_manager.cpp:1158-1160`, `SingleFileBlockManager::GetBlockLocation`).
  The default allocation size is `DEFAULT_BLOCK_ALLOC_SIZE = 262144`
  (`src/include/duckdb/storage/storage_info.hpp:33`). The usable block size is
  `DEFAULT_BLOCK_SIZE = 262144 - 8` (`storage_info.hpp:64-68`), because each block begins with an 8-byte
  header/checksum.
* The two `DatabaseHeader` slots alternate on every checkpoint. `WriteHeader` writes the *inactive* slot,
  then flips `active_header` (`src/storage/single_file_block_manager.cpp:1403-1408`).

### 1.2 `DatabaseHeader`: the root

`DatabaseHeader` is declared in `src/include/duckdb/storage/storage_info.hpp:377-398` and serialized by
`DatabaseHeader::Write` (`src/storage/single_file_block_manager.cpp:270-285`) in this order:

| Field | Type | Meaning |
|---|---|---|
| `iteration` | u64 | Checkpoint counter; incremented in `WriteHeader` (`single_file_block_manager.cpp:1330`) |
| `meta_block` | idx_t | **`MetaBlockPointer::block_pointer` of the catalog stream's first metadata sub-block** |
| `free_list` | idx_t | Metadata pointer to the serialized free list (or `INVALID_INDEX`) |
| `block_count` | u64 | `max_block` when the header was written (`single_file_block_manager.cpp:1373`) |
| `block_alloc_size` | idx_t | 262144 by default |
| `vector_size` | idx_t | `STANDARD_VECTOR_SIZE` (2048) |
| storage version | idx_t | Written as the raw `StorageVersion` value for ≥ v2.0.0 (`single_file_block_manager.cpp:278-284`) |

`SingleFileCheckpointWriter::CreateCheckpoint` fills in `meta_block`, `block_alloc_size` and
`vector_size` just before calling `block_manager.WriteHeader` (`src/storage/checkpoint_manager.cpp:291-296`).

### 1.3 Metadata blocks and `MetaBlockPointer`

All metadata (catalog, table statistics, row-group pointers, column metadata, delete info, free list,
index info) goes into **metadata blocks**. These are ordinary 256 KiB file blocks split into
`METADATA_BLOCK_COUNT = 64` sub-blocks (`src/include/duckdb/storage/metadata/metadata_manager.hpp:58`).

* Sub-block size is `AlignValueFloor(block_size / 64)`. With 262136 usable bytes that gives **4088 bytes**
  (`src/storage/metadata/metadata_manager.cpp:344-346`, `MetadataManager::GetMetadataBlockSize`).
* A `MetaBlockPointer` holds `block_pointer` (u64) and `offset` (u32) (`src/include/duckdb/storage/block.hpp:49-57`).
  The sub-block index is packed into the top 8 bits: `block_pointer = block_id | (index << 56)`
  (`metadata_manager.cpp:196-208`, `GetDiskPointer`, `MetaBlockPointer::GetBlockId`,
  `MetaBlockPointer::GetBlockIndex`).
* Sub-blocks form singly linked chains. The first 8 bytes of every sub-block store the *next* sub-block's
  `block_pointer`, or `-1` at the end of a chain (`src/storage/metadata/metadata_writer.cpp:43-61`,
  `MetadataWriter::NextBlock`). A stream's usable payload therefore starts at offset 8 of each sub-block.
* A new metadata block's free sub-blocks are pushed as 63..0 and popped from the back, so index 0 is used
  first (`metadata_manager.cpp:160-161`, `AllocateNewBlock`, and `:89-91`, `AllocateHandle`).
* Metadata *block ids* come from the **same allocator as data blocks**: `MetadataManager::GetNextBlockId`
  calls `block_manager.GetFreeBlockIdForCheckpoint()` (`metadata_manager.cpp:493-495`). Metadata blocks and
  data blocks therefore interleave in block-id space.
* Metadata blocks stay in memory and are written to disk only in
  `SingleFileBlockManager::WriteHeader`, via `metadata_manager.Flush(context)`
  (`single_file_block_manager.cpp:1370`). That happens after all data blocks have been written, and before
  the `fsync` + header write (`:1384`, `:1405-1410`).

### 1.4 The catalog metadata stream

`SingleFileCheckpointWriter::CreateCheckpoint` (`src/storage/checkpoint_manager.cpp:196-373`):

1. Creates **two** `MetadataWriter`s on the same `MetadataManager`:
   `metadata_writer` for the catalog stream and `table_metadata_writer` for table data
   (`checkpoint_manager.cpp:212-213`).
2. Gets `meta_block = metadata_writer->GetMetaBlockPointer()` (`:216`). This is the first metadata
   allocation of the checkpoint, so on a fresh file it usually becomes block 0, sub-block 0
   ([§6.6](#66-raw-bytes-decoding-the-pointer-graph-of-a1duckdb)).
3. Writes the planned root to the WAL (`WALStartCheckpoint`, `:232`).
4. Collects the committed catalog entries with `GetCatalogEntries` (`:114-194`). For **each schema** it
   collects, in order:
   1. the schema itself (`:117`)
   2. non-internal `TYPE_ENTRY` (`:119-124`)
   3. `SEQUENCE_ENTRY` (`:126-131`)
   4. tables, reordered for foreign keys by `ReorderTableEntries` (`:133-151`; the definition is in
      `src/planner/binder/statement/bind_export.cpp:98`)
   5. views (`:152-154`)
   6. triggers, scanned per DuckTable (`:156-167`)
   7. scalar macros (`:170-177`)
   8. table macros (`:179-186`)
   9. indexes (`:188-191`)
5. Re-sorts the whole list topologically with `DependencyManager::ReorderEntries`
   (`checkpoint_manager.cpp:250`; `src/catalog/dependency_manager.cpp:678-717`). `ReorderEntry`
   recursively emits every dependency before the dependent entry (`dependency_manager.cpp:684-703`).
6. Serializes `WriteList(100, "catalog_entries", …)`. Each element is an object written by
   `CheckpointWriter::WriteEntry`: field `99 catalog_type`, then the type-specific payload under field 100
   (`checkpoint_manager.cpp:274-278`, `:412-460`).
7. Calls `metadata_writer->Flush()` and `table_metadata_writer->Flush()` (`:280-281`). These only finish
   the in-memory sub-blocks; the real disk write happens in `WriteHeader`.
8. Writes the header (`:291-296`), truncates the file (`:333`) and finishes the WAL (`:338-352`).

> The task brief listed the order "schemas, tables, views, sequences, macros, types, indexes". The code
> order **within a schema** is actually *schema → types → sequences → tables → views → triggers → macros →
> table macros → indexes*. The dependency reorder then changes this wherever there are explicit
> dependencies.

### 1.5 The table entry inside the catalog stream

For a `TABLE_ENTRY`, `SingleFileCheckpointWriter::WriteTable` (`checkpoint_manager.cpp:691-710`):

1. writes `100 "table"`, the `TableCatalogEntry`/CreateInfo (`:693`).
2. binds indexes if there is a client context (`:698-701`).
3. takes the table's exclusive checkpoint lock, `DataTable::GetCheckpointLock`
   (`checkpoint_manager.cpp:705`; `src/storage/data_table.cpp:1572-1574`).
4. creates a `SingleFileTableDataWriter` (`checkpoint_manager.cpp:110-112`) and calls `WriteTableData`.
   That calls `DataTable::Checkpoint` (`src/storage/checkpoint/table_data_writer.cpp:36-39`).

`DataTable::Checkpoint` (`src/storage/data_table.cpp:1576-1599`) runs `RowGroupCollection::Checkpoint`.
This writes all segment data and column metadata ([§3](#3-the-checkpoint-flow-for-one-table)). It then
calls `writer.FinalizeTable(global_stats, *info, *row_groups, serializer)` (`:1597`). The comment there
lists the remaining output: "sample, column stats, row-group pointers, table pointer, index data"
(`:1591-1596`).

`SingleFileTableDataWriter::FinalizeTable` (`src/storage/checkpoint/table_data_writer.cpp:96-222`) writes to
**two different streams**:

**(a) The table-data stream (`table_metadata_writer`)**, which is new metadata unless the table is unchanged:

```
pointer = table_data_writer.GetMetaBlockPointer()            // :107  ← this becomes "table_pointer"
[BinarySerializer unit]  TableStatistics::Serialize           // :112-115
    100 column_stats  (one per physical column)                //   table_statistics.cpp:236-247
    101 table_sample  (optional reservoir sample)
uint64  row_group_count                                       // :118  (raw 8-byte LE)
repeat row_group_count times:
  [BinarySerializer unit] RowGroup::Serialize(pointer)        // :128-133  (row_group.cpp:1958-1978)
```

**(b) The catalog stream (`serializer`)**, appended to the table entry object:

| Field | Name | Value (`table_data_writer.cpp`) |
|---|---|---|
| 101 | `table_pointer` | `MetaBlockPointer` to (a) (`:188`) |
| 102 | `total_rows` | Σ `tuple_count` over row-group pointers (`:121-122`, `:189`) |
| 103 | `index_pointers` | Always an empty vector, kept for forward compatibility (`:211-213`) |
| 104 | `index_storage_infos` | `TableIndexList::SerializeToDisk` result (`:199`, `:214-216`) |
| 105 | `next_row_id` | max(`row_start + tuple_count`), only for storage ≥ v2.0.0 (`:123-126`, `:217-219`) |

Readers consume these fields in `CheckpointReader::ReadTableData` (`checkpoint_manager.cpp:728-772`).
That function then opens a second `MetadataReader` at `table_pointer`, reads the statistics and the
row-group count, and stores the stream position of the first row-group pointer as `data->block_pointer`
(`src/storage/checkpoint/table_data_reader.cpp:16-30`).

> **`total_rows` counts physically present rows, including deleted rows that have not been vacuumed.**
> `tuple_count` is `RowGroup::count` (`row_group.cpp:1729`), not the committed count. In experiment V1
> ([§6.5](#65-second-checkpoint-updates-deletes-vacuum-and-metadata-reuse)) the decoded `total_rows` is
> **231360**, `count(*)` is 200000, and `next_row_id` is 500000.

If the whole table is unchanged and metadata reuse is on (`experimental_metadata_reuse`, default `true`,
`src/include/duckdb/main/settings.hpp:1363-1370`), `RowGroupCollection::Checkpoint` calls
`WriteUnchangedTable` (`row_group_collection.cpp:1759-1792`). `FinalizeTable` then writes the **old**
`table_pointer` again, re-marks the old metadata blocks as in use with `ClearModifiedBlocks`, and writes
nothing to the table-data stream (`table_data_writer.cpp:136-145`).

### 1.6 Column metadata: `PersistentColumnData` and `DataPointer`

Each `RowGroupPointer::data_pointers[c]` is a `MetaBlockPointer` into the **same** table-data stream
(`table_metadata_writer`). The pointed-to bytes are one `BinarySerializer` unit containing one
`PersistentColumnData` tree (`row_group.cpp:1811-1829`, inside `RowGroup::Checkpoint`).
`PersistentColumnData::Serialize` (`src/storage/table/column_data.cpp:937-978`) writes:

```
99  extra_data      (optional: VARIANT shredded type or GEOMETRY storage type)
100 data_pointers   vector<DataPointer>   (this ColumnData's own segments; can be empty)
101 validity        PersistentColumnData  (all types except BIT/validity itself)
102 child_column    PersistentColumnData  (LIST/ARRAY)          | sub_columns list (STRUCT)
                    | unshredded (VARIANT) ; 103 shredded (VARIANT, optional)
```

Each `DataPointer` (`src/include/duckdb/storage/data_pointer.hpp:51-73`) is written by
`DataPointer::Serialize` (`src/storage/serialization/serialize_storage.cpp:27-39`):

| Field | Name | Notes |
|---|---|---|
| 100 | `row_start` | **Only written for storage < v1.5.0**; read as a deleted property (`:28-30`, `:42`) |
| 101 | `tuple_count` | Rows in the segment |
| 102 | `block_pointer` | `BlockPointer{block_id (100), offset (101)}` (`:15-18`). This is the **data block id + byte offset**. `block_id = -1` means "no block" (constant segment) |
| 103 | `compression_type` | e.g. BitPacking, ALP, DICT_FSST, Constant |
| 104 | `statistics` | Per-segment `BaseStatistics` (zone map) |
| 105 | `segment_state` | Compression-specific state, e.g. overflow string block ids |
| 106 | `byte_size` | Bytes the segment occupies in its block; only for storage ≥ v2.0.0 (`:36-38`) |

### 1.7 The full pointer graph

```
 file
 ├─ DatabaseHeader (h1/h2, @4096 or @8192)
 │    meta_block ───────────────────────────────────────────────┐
 │    free_list ──────────────► [metadata sub-block] free list,   │
 │                               multi-use block refcounts,       │
 │                               metadata-block bitmaps           │
 │                                                                ▼
 │  ┌───────────────────── CATALOG STREAM (metadata_writer) ───────────────────────┐
 │  │ 100 catalog_entries: [                                                         │
 │  │   {99 type=SCHEMA, 100 schema}                                                 │
 │  │   {99 type=TYPE/SEQUENCE/...}                                                  │
 │  │   {99 type=TABLE, 100 table(CreateTableInfo: columns, constraints…),           │
 │  │        101 table_pointer ──────────────────────────────────────────┐          │
 │  │        102 total_rows, 103 index_pointers=[], 104 index_storage_infos[…],     │
 │  │        105 next_row_id }                                            │          │
 │  │   {99 type=VIEW …} {99 type=INDEX, 100 index} …  ]                  │          │
 │  └─────────────────────────────────────────────────────────────────── │ ─────────┘
 │                                                                       ▼
 │  ┌────────────────── TABLE-DATA STREAM (table_metadata_writer) ───────────────────┐
 │  │ … column metadata units written earlier (see below) …                          │
 │  │ table_pointer ► [unit] TableStatistics {100 column_stats[], 101 table_sample}  │
 │  │                 u64 row_group_count = R                                        │
 │  │                 [unit] RowGroupPointer 0 {100 row_start, 101 tuple_count,      │
 │  │                        102 data_pointers[C] ──┐, 103 delete_pointers[] ──┐,    │
 │  │                        104 has_metadata_blocks, 105 extra_metadata_blocks,│    │
 │  │                        106 has_per_column_metadata_blocks,                │    │
 │  │                        107 per_column_metadata_blocks }                   │    │
 │  │                 [unit] RowGroupPointer 1 … R-1                            │    │
 │  │                                             │                             │    │
 │  │  column c of RG r ◄─────────────────────────┘                             │    │
 │  │  [unit] PersistentColumnData {99 extra?, 100 data_pointers[DataPointer…]  │    │
 │  │          101 validity{100 data_pointers[…]}, 102 child/sub_columns{…}}    │    │
 │  └─────────────────────────────────────────── │ ───────────────────────────│────┘
 │                                               │ DataPointer.block_pointer   │
 │                                               ▼ {block_id, offset}          ▼
 │  data block (BLOCK_START + id*262144 + 8 + offset)            [own metadata chain]
 │     └─ segment bytes: byte_size bytes, compression-specific    RowVersionManager:
 │        (segment_state may point to more blocks, e.g.           u64 n, {u64 vector_idx,
 │         overflow strings)                                       ChunkInfo}… (deletes)
```

Some of the arrows go "backwards" in the stream: the column-metadata units are written **before** the
statistics and row-group list that point to them
([§3.8](#38-ordering-of-writes-what-is-written-when)). That is why, in experiment A1, the `table_pointer`
lands at sub-block 2, offset 1685, while `data_pointers` point into sub-block 1
([§6.6](#66-raw-bytes-decoding-the-pointer-graph-of-a1duckdb)).

---

## 2. RowGroupCollection, RowGroup, RowGroupPointer and persistent column data

### 2.1 Sizes and constants

| Constant | Value | Source |
|---|---|---|
| `DEFAULT_ROW_GROUP_SIZE` | 122880 rows (= 60 × 2048) | `src/include/duckdb/storage/storage_info.hpp:26` |
| `STANDARD_VECTOR_SIZE` | 2048 | `src/include/duckdb/common/vector_size.hpp:16-20` |
| Compile-time checks: row group is a multiple of, and ≥, the vector size | | `storage_info.hpp:402-407` |
| `MAX_ROW_GROUP_SIZE` | 2^30 | `storage_info.hpp:58` |
| Per-database `row_group_size` (ATTACH option) | must be a multiple of 2048; > 122880 only with storage ≥ v1.2.0 | `src/storage/storage_manager.cpp:116-117`, `:452-462`, `:591-595` |

### 2.2 `RowGroupCollection` and the row-group segment tree

* `RowGroupCollection` owns a `RowGroupSegmentTree` (`owned_row_groups`) and the counters `total_rows` and
  `next_row_id` (`src/storage/table/row_group_collection.cpp:138-154`). Each node of the tree is a
  `SegmentNode<RowGroup>` that knows its `row_start` and index.
* **Appends fill the last row group up to `row_group_size`, then start a new one.**
  `RowGroupCollection::Append` (`row_group_collection.cpp:674-727`) computes
  `append_count = min(remaining, row_group_size - offset_in_row_group)` (`:686-687`) and calls
  `AppendRowGroup(l, next_start)` (`:711`) when the chunk overflows.
* After every checkpoint, `DataTable::Checkpoint` sets the append mode to `SUGGEST_NEW`
  (`data_table.cpp:1581`). For tables without indexes, or with indexes that vacuum can remap or rebuild,
  the next append starts a **new** row group instead of reopening the persisted last one
  (`row_group_collection.cpp:640-656`). Small appends between checkpoints therefore create small row
  groups, and vacuum may merge them later ([§3.3](#33-vacuum-dropping-and-merging-row-groups)).
* Tables containing VARIANT or GEOMETRY always use `REQUIRE_NEW` (`row_group_collection.cpp:145-153`).

### 2.3 `RowGroupPointer`: the on-disk row-group descriptor

`src/include/duckdb/storage/data_pointer.hpp:75-93`:

| C++ field | Serialized as | Meaning |
|---|---|---|
| `row_start` | 100 | First row id of the group. With storage ≥ v2.0 there can be gaps between groups |
| `tuple_count` | 101 | Physical row count, including rows deleted but not vacuumed |
| `data_pointers` | 102 | One `MetaBlockPointer` per **top-level** column, pointing to its `PersistentColumnData` unit |
| `deletes_pointers` | 103 | Metadata chain(s) of the serialized `RowVersionManager` (empty if no deletes) |
| `has_metadata_blocks` | 104 | v1.4+: "the complete set of metadata blocks of this RG is known" |
| `extra_metadata_blocks` | 105 | v1.4+: metadata blocks used by column metadata **beyond** each column's start block |
| `has_per_column_metadata_blocks` | 106 | v2.0 (or `force_column_metadata_reuse` on v1.4/1.5) |
| `per_column_metadata_blocks` | 107 | The same extra blocks, attributed per column (packed `PerColumnMetadataBlock`, `src/include/duckdb/storage/table/per_column_metadata_blocks.hpp:19-26`) |

Serialization is in `RowGroup::Serialize` (`src/storage/table/row_group.cpp:1958-1978`). When
`supports_per_column_writes` is true (always for storage ≥ v2.0.0, see
`RowGroupCollection::SupportsPerColumnWrites`, `row_group_collection.cpp:2169-2178`), it writes **both** the
legacy fields 104/105 (so v1.4/v1.5 readers can still reuse metadata) and the per-column fields 106/107.
`RowGroup::Deserialize` (`row_group.cpp:1980-1998`) prefers per-column data when present.

These "extra metadata blocks" exist so that a later checkpoint can **reuse** a row group's or a column's
metadata without deserializing it. It still has to tell the `MetadataManager` which metadata sub-blocks
stay alive (`ClearModifiedBlocks`, [§3.7](#37-reuse-of-unchanged-data-and-metadata)).

### 2.4 How a column decomposes into `ColumnData` trees and segment streams

`ColumnData::CreateColumn` (`src/storage/table/column_data.cpp:1378-1400`) chooses the class:

| Logical type | ColumnData class | Own segments? | Children (serialization order) |
|---|---|---|---|
| fixed-width / VARCHAR / … | `StandardColumnData` | yes (values) | `[0]` validity |
| validity | `ValidityColumnData` | yes (bitmask) | – |
| `STRUCT(f1,…,fn)` | `StructColumnData` | **no** | `[0]` validity, `[1..n]` one ColumnData per field |
| `LIST(T)` | `ListColumnData` | yes (**offsets**, internal type UBIGINT, see `column_data_checkpointer.cpp:61-63`) | `[0]` validity, `[1]` child column of T |
| `ARRAY(T, k)` | `ArrayColumnData` | **no** | `[0]` validity, `[1]` child column of T |
| `VARIANT` | `VariantColumnData` | **no** | `[0]` validity, `[1]` unshredded, `[2]` shredded (optional) |
| `GEOMETRY` | `GeoColumnData` | depends on storage type | via `extra_data` |

This matches `PersistentColumnData::Serialize` (`column_data.cpp:956-977`) and the `ToPersistentData`
overrides:

* `StandardColumnCheckpointState::ToPersistentData` (`src/storage/table/standard_column_data.cpp:267-271`)
* `StructColumnCheckpointState::ToPersistentData` (`src/storage/table/struct_column_data.cpp:462-468`)
* `ListColumnCheckpointState::ToPersistentData` (`src/storage/table/list_column_data.cpp:421-427`)
* `ArrayColumnCheckpointState::ToPersistentData` (`src/storage/table/array_column_data.cpp:342-347`)
* `VariantColumnCheckpointState::ToPersistentData` (`src/storage/table/variant_column_data.cpp:580-594`)

`pragma_storage_info` reports one row per segment and identifies each leaf by its **column path**
(`ColumnData::GetColumnSegmentInfo`, `column_data.cpp:1276-1345`). For the experiment table
`t(id BIGINT, i INT, d DOUBLE, s VARCHAR, st STRUCT(a INT, b VARCHAR), l INT[])`:

```
column           ColumnData tree                          storage_info paths
id  BIGINT       Standard ── validity                    [0]      [0, 0]
i   INTEGER      Standard ── validity                    [1]      [1, 0]
d   DOUBLE       Standard ── validity                    [2]      [2, 0]
s   VARCHAR      Standard ── validity                    [3]      [3, 0]
st  STRUCT       Struct (no segments)                    —
                 ├─ validity                             [4, 0]
                 ├─ a: Standard ── validity              [4, 1]   [4, 1, 0]
                 └─ b: Standard ── validity              [4, 2]   [4, 2, 0]
l   INTEGER[]    List (offsets)                          [5]
                 ├─ validity                             [5, 0]
                 └─ child: Standard ── validity          [5, 1]   [5, 1, 0]
                                                          → 17 segment streams per row group
```

Every leaf is an **independent segment stream**. It has its own sequence of `ColumnSegment`s and
`DataPointer`s, its own compression choice per segment, and its own placement in blocks. The child of a
LIST has its own row count (`count = 110592` vs 122880 in [§6.3](#63-baseline-layout-threads1-a1)),
because it counts list *elements*, not rows.

### 2.5 Statistics at three levels

1. **Segment**: `DataPointer.statistics` (field 104), produced in `ColumnCheckpointState::FlushSegmentInternal`
   (`src/storage/table/column_checkpoint_state.cpp:151-152`, `:205`).
2. **Column-in-row-group**: `ColumnCheckpointState::global_stats`. It is merged from the segment stats
   (`column_checkpoint_state.cpp:152`) and, for standard columns, from the validity stats
   (`standard_column_data.cpp:310-311`). It is returned by `RowGroup::CheckpointColumn`
   (`row_group.cpp:1419-1434`) and stored in `RowGroupWriteData::statistics`. It is **not** serialized
   separately; on load it is rebuilt by merging segment stats in `ColumnData::InitializeColumn`
   (`column_data.cpp:885-905`, `target_stats.Merge(data_pointer.statistics)` at `:897`).
3. **Table**: `TableStatistics` (column stats plus an optional reservoir sample), serialized as the
   first unit at `table_pointer` (`table_data_writer.cpp:111-115`; `table_statistics.cpp:236-247`). In
   `RowGroup::Checkpoint` these are merged from each row group's write statistics
   (`row_group.cpp:1768-1784`). For reused, unloaded columns the previous table stats are merged with
   `EXPAND_BOUNDS` (`row_group_collection.cpp:2031-2042`).

### 2.6 Lazy loading on read

Reading is lazy at three levels:

* **Row-group pointers.** `RowGroupSegmentTree::Initialize` only stores `row_group_count` and a
  `MetadataReader` positioned at the first `RowGroupPointer` (`row_group_collection.cpp:105-112`).
  `LoadSegment` deserializes one `RowGroupPointer` per call, on demand (`:114-127`).
* **Columns.** `RowGroup::RowGroup(collection, RowGroupPointer)` stores `column_pointers` and sets
  `is_loaded[c] = false` for all columns (`row_group.cpp:47-68`). `RowGroup::LoadColumn` deserializes the
  `PersistentColumnData` from `column_pointers[c]` only on first access, under `row_group_lock`, with
  double-checked locking (`row_group.cpp:182-222`; `ColumnData::Deserialize`, `column_data.cpp:1237-1263`).
* **Deletes.** `RowGroup::GetVersionInfo` deserializes `deletes_pointers[0]` on first use
  (`row_group.cpp:1110-1126`; `RowVersionManager::Deserialize`, `row_version_manager.cpp:285-313`).
* Segment *data* is a third lazy layer: `ColumnSegment::CreatePersistentSegment` registers a block handle
  and the buffer manager reads the block only when it is pinned (`column_data.cpp:900`).

Lazy loading feeds into checkpointing. An unloaded column cannot have changes, so `RowGroup::HasChanges`
skips it (`row_group.cpp:1896-1905`), and its metadata can be reused verbatim
([§3.7](#37-reuse-of-unchanged-data-and-metadata)).

---

## 3. The checkpoint flow for one table

### 3.1 Call graph

```
SingleFileCheckpointWriter::WriteTable                      checkpoint_manager.cpp:691
 └ SingleFileTableDataWriter::WriteTableData                table_data_writer.cpp:36
    └ DataTable::Checkpoint                                 data_table.cpp:1576
       ├ writer.SetRowGroupCount(CheckpointRowGroupCount)   data_table.cpp:1577, :1084-1090
       ├ RowGroupCollection::Checkpoint                     row_group_collection.cpp:1704
       │  ├ CollectionCheckpointState(…)                    :1081-1130   (creates TaskExecutor)
       │  ├ InitializeVacuumState                           :1458-1554   (drop empty RGs)
       │  ├ for each segment_idx:                           :1718-1747
       │  │   ScheduleVacuumTasks → VacuumTask              :1556-1689 / :1295-1456
       │  │   or CompressVersionInfo + CheckpointTask       :1737-1744
       │  ├ executor->WorkOnTasks()                         :1755   ◄── parallel phase
       │  │     CheckpointTask::ExecuteTask                 :1148-1153
       │  │       RowGroup::WriteToDisk(RowGroupWriter&)    row_group.cpp:1597-1711
       │  │         RowGroup::CheckpointColumn              row_group.cpp:1419-1434
       │  │           <XColumnData>::Checkpoint             (standard/struct/list/array/variant)
       │  │             ColumnDataCheckpointer::Checkpoint  column_data_checkpointer.cpp:411-435
       │  │               analyze → compress → FlushSegment column_checkpoint_state.cpp:133-224
       │  │                 PartialBlockManager (locked)    partial_block_manager.cpp:59-160
       │  ├ [all unchanged?] WriteUnchangedTable → return   :1759-1792
       │  ├ sequential loop over segments                   :1807-1880  ◄── sequential phase
       │  │     RowGroup::Checkpoint → column metadata      row_group.cpp:1722-1885
       │  │       CheckpointDeletes → RowVersionManager     row_group.cpp:1942-1956
       │  │     writer.AddRowGroup(pointer)                 table_data_writer.cpp:41-43
       │  ├ writer.FlushPartialBlocks()                     :2049
       │  └ SetRowGroups(new tree)                          :2054
       ├ RebuildIndexes (if vacuum changed rowids)          data_table.cpp:1582-1590
       └ SingleFileTableDataWriter::FinalizeTable           table_data_writer.cpp:96-222
```

### 3.2 `CollectionCheckpointState`

`row_group_collection.cpp:1081-1130`. It holds:

* `executor`: a `TaskExecutor`, from `TableDataWriter::CreateTaskExecutor` (`table_data_writer.cpp:53-58`).
* `writers[i]` and `write_data[i]`: one slot per **source** segment index. Tasks write only to their own
  slot (`:1151-1152`), so these vectors need no lock.
* `dropped_segments` and `overridden_segments`, which let vacuum drop source row groups and put merged
  row groups in their place (`GetSegment`, `DropSegment`, `SetSegment`, `:1104-1125`).

### 3.3 Vacuum: dropping and merging row groups

Vacuum runs only for **non-concurrent** checkpoints: `can_vacuum_deletes = options.type !=
CONCURRENT_CHECKPOINT` (`row_group_collection.cpp:1462`). A plain `CHECKPOINT` becomes
`CONCURRENT_CHECKPOINT` when some transaction may still need old data
(`src/transaction/duck_transaction_manager.cpp:248-252`) or the vacuum lock is unavailable
(`src/storage/storage_manager.cpp:739-751`). If row groups were appended concurrently after the checkpoint
started, vacuum is disabled as well (`row_group_collection.cpp:1478-1484`).

**Stage 1: `InitializeVacuumState`** (`:1458-1554`):

* Gets the index strategy from `GetVacuumIndexStrategy` (`:81-94`): `REMAP` (bound ARTs and storage that
  can persist rowid gaps), `REBUILD`, `NO_INDEXES` or `KEEP_ROW_IDS`. `can_change_row_ids` is true for
  every strategy except `KEEP_ROW_IDS` (`:1472`).
* For each row group it computes `GetCommittedRowCount()` (`row_group.cpp:1496-1505`):
  * **0 committed rows**: the group is dropped immediately (`CommitDrop` + `DropSegment`, `:1515-1517`).
    On old storage that cannot persist rowid gaps, this happens only when rowids may change; otherwise
    only a trailing suffix of empty groups is dropped (`:1500-1512`, `:1536-1553`).
  * **Partially deleted and `!can_change_row_ids`**: the group is marked non-vacuumable
    (`emplace_back()` = invalid, `:1520-1526`).

**Stage 2: `ScheduleVacuumTasks`** (`:1556-1689`), called for each `segment_idx` in order:

* `MAX_MERGE_COUNT = 3` (`:1558`). For `target_count = 1..3` it greedily extends a window of consecutive
  vacuumable row groups while `merge_rows + next_row_count ≤ target_count × row_group_size`
  (`:1593-1647`). Without permission to change rowids, the window breaks on rowid gaps or partial deletes
  (`:1625-1642`).
* A merge happens when `target_count < merge_count`, i.e. it saves at least one row group (`:1665-1674`).
  The loop prefers the smallest `target_count`: "2 row groups into 1" beats "3 into 2" (`:1581-1586`).
* **Tail rule.** If the window reaches the end of the table, the merge happens only if
  `merge_rows < STANDARD_VECTOR_SIZE` or `merge_rows ≥ min(2 × first_rg_rows, row_group_size) × target_count`.
  This stops a large row group from being rewritten on every checkpoint just to absorb a few appended
  rows (`:1648-1664`).
* At most `max_vacuum_tasks` (default **100**, `settings.hpp:1879-1886`) vacuum tasks are scheduled per
  table (`row_group_collection.cpp:1716-1724`).

**`VacuumTask::ExecuteTask`** (`:1303-1444`):

1. creates `target_count` new empty row groups (`:1318-1329`).
2. scans the committed rows of the source groups with `TABLE_SCAN_COMMITTED_ROWS` and appends them
   (`:1357-1410`).
3. calls `CommitDrop` on each source group (`:1408-1409`).
4. installs the new groups with `SetSegment(row_start …)`. The merged group keeps the **first** source
   group's `row_start` (`:1364-1366`, `:1415-1423`).
5. remaps index rowids if needed (`:1429-1431`).
6. runs the `CheckpointTask` of each new group **inline, on the same thread** (`:1437-1443`).

If vacuum shifted rowids and the strategy is `REBUILD`, the indexes are rebuilt after the table checkpoint
(`row_group_collection.cpp:2057-2059`; `data_table.cpp:1582-1590`).

### 3.4 `RowGroup::WriteToDisk(RowGroupWriter&)`: choose an action per row group

`row_group.cpp:1597-1711`. There are three possible `RowGroupWriteAction`s
(`src/include/duckdb/storage/table/row_group.hpp:84-88`):

```
CanReuseMetadata(writer)?  (row_group.cpp:1568-1583: metadata reuse enabled, column_pointers non-empty,
                            and not (legacy start_row required && rowids changed))
 │
 ├─ yes and !HasChanges()  (row_group.cpp:1887-1907: has_changes flag, unserialized deletes,
 │                           any loaded column with changes)
 │     → REUSE_EXISTING_ROW_GROUP_METADATA      (row_group.cpp:1599-1624)
 │        no column is touched, no data or metadata is written in the parallel phase
 │
 ├─ yes, has per-column metadata blocks, SupportsPerColumnWrites()
 │     → PARTIALLY_REUSE_COLUMN_METADATA        (row_group.cpp:1632-1638)
 │        columns that are unloaded or have no changes: states[c] = nullptr, keep column_pointers[c]
 │        changed columns: CheckpointColumn(...)                         (row_group.cpp:1658-1697)
 │
 └─ otherwise
       → FULLY_CHECKPOINT_ROW_GROUP             (row_group.cpp:1639)
          every column goes through CheckpointColumn(...)
```

`has_changes` is set, for example, by `RowGroup::MoveToCollection` (`row_group.cpp:86-104`, with a FIXME
saying this is over-conservative for new storage versions) and by `CreateNewRowGroupCopy`
(`row_group.cpp:448`).

### 3.5 Column checkpoint: analyze, compress, flush segments

`RowGroup::CheckpointColumn` → `column.Checkpoint(row_group, checkpoint_info)` (`row_group.cpp:1419-1434`).

Per type:

* **Standard**: main data and validity share **one** `ColumnDataCheckpointer` with two states
  (`standard_column_data.cpp:279-314`). The comment at `:282-286` explains why the main data is
  checkpointed first and in the same pass: in concurrent checkpointing, a block flushed by another thread
  must not race with a validity re-scan.
* **Struct**: validity first, then each field in order (`struct_column_data.cpp:477-490`). The struct
  node itself has no segments.
* **List**: offsets (`ColumnData::Checkpoint`), then validity, then the child
  (`list_column_data.cpp:434-445`).
* **Array**: validity, then child (`array_column_data.cpp:355-364`).
* **Variant**: validity. Then, if the column changed and is large enough, it is (re)shredded into
  `unshredded` + `shredded` columns and those are checkpointed. Otherwise the existing sub-columns are
  checkpointed as they are (`variant_column_data.cpp:727-785`).

`ColumnDataCheckpointer::Checkpoint` (`src/storage/table/column_data_checkpointer.cpp:411-435`):

* If **no** state's `original_column.HasChanges()` (`column_data.cpp:105-120`: transient segments or
  updates), the existing blocks are marked as checkpointed. `FinalizeCheckpoint` then copies the
  *existing* data pointers (`WritePersistentSegments`, `:363-401`). **No data bytes are written.**
* Otherwise `WriteToDisk` (`:310-357`) runs:
  1. `DetectBestCompressionMethod` (`:172-282`): one `ScanSegments` pass (`:92-118`) that feeds every
     candidate's `analyze`, then the method with the lowest `final_analyze` score wins, unless one is
     forced (`force_compression` or a column `USING COMPRESSION`).
  2. `ValidityCoveredByBasedata`: if the data's compression handles NULLs itself, validity uses
     `COMPRESSION_EMPTY` (`:301-308`, `:312-321`).
  3. A second `ScanSegments` pass calls `compress` **for every state on each 2048-row vector**
     (`:340-346`). Data and validity of a standard column are therefore compressed in lockstep.
  4. `compress_finalize` (`:349-353`) flushes the last segments.
  5. `DropSegments` (`:284-299`) marks the old blocks as modified (`MarkBlockAsModified`).

Compression functions cut segments whenever a segment would exceed the block. **A segment never spans
blocks** (`row_group.cpp:1457-1459`; size check in `column_checkpoint_state.cpp:139-142`). Each finished
segment goes through `ColumnCheckpointState::FlushSegmentInternal`
(`column_checkpoint_state.cpp:138-224`):

```
stats.IsConstant()?  → ConvertToPersistent(nullptr, INVALID_BLOCK): no block, block_id = -1   (:158-160)
segment_size == 0?   → persistent, empty, no block                                           (:197-202)
otherwise:
  lock partial_block_manager                                                                  (:165)
  allocation = GetBlockAllocation(byte_size)                                                  (:167)
    ├─ fits in a partially filled block → memcpy into it at state.offset, AddSegmentToTail   (:171-181)
    └─ else new block: resize segment buffer to a full block, CreatePartialBlock              (:182-193)
  RegisterPartialBlock(allocation)    (may immediately Flush = write the block to disk)       (:195)
  DataPointer{block_id, offset, tuple_count, compression, stats, byte_size, segment_state}    (:205-219)
```

### 3.6 The `PartialBlockManager`: which block and offset a segment lands in

There is exactly **one** `PartialBlockManager` per checkpoint, of type `FULL_CHECKPOINT`, owned by
`SingleFileCheckpointWriter` (`checkpoint_manager.cpp:91-95`). Every `SingleFileRowGroupWriter` refers to
it (`table_data_writer.cpp:70-73`). Its rules (`src/storage/partial_block_manager.cpp`):

| Rule | Code |
|---|---|
| `max_partial_block_size = block_size / 5 * 4` (80% of 262136 = 209708 bytes) | `:52-53` |
| A segment ≤ 80% of a block looks for a partially filled block with `free_space ≥ size`. `multimap::lower_bound(size)` returns the **smallest** such free space (best fit) | `:59-79`, `:106-118` |
| Otherwise `AllocateBlock` gets a new block id **immediately** with `GetFreeBlockIdForCheckpoint` (`FULL_CHECKPOINT`) | `:86-96`, `:98-104` |
| After adding a segment, the offset is aligned up to 8 bytes and the gap is recorded as uninitialized (zeroed on flush) | `:131-138` |
| The block stays "partial" only if **≥ 20%** of it is still free; otherwise it is **flushed right away** | `:139-159` |
| At the end of each table, every remaining partial block is flushed | `FlushPartialBlocks`, `:197-202`, called from `row_group_collection.cpp:2049` |

`SingleFileBlockManager::GetFreeBlockIdInternal` returns the **lowest** id in the `free_list`
(`std::set<block_id_t>`), or `max_block++` when the list is empty
(`src/storage/single_file_block_manager.cpp:898-917`;
`src/include/duckdb/storage/single_file_block_manager.hpp:208`). The block id is fixed at allocation time,
so `DataPointer`s are final as soon as the segment is flushed, even though the bytes of a partial block are
written later.

`PartialBlockForCheckpoint::Flush` (`column_checkpoint_state.cpp:59-94`) converts the first segment to
persistent. That call, `BlockManager::ConvertToPersistent` (`src/storage/buffer/block_manager.cpp:59-118`),
writes the block to disk (`Write(context, *converted_buffer, block_id)`, `:97`). The other segments in the
block are only *marked* persistent, and the block's reference count is increased.

### 3.7 Reuse of unchanged data and metadata

| Level | Mechanism | Code |
|---|---|---|
| Whole table | All segments `REUSE_EXISTING_ROW_GROUP_METADATA` and none dropped → `WriteUnchangedTable`, same `table_pointer`, `ClearModifiedBlocks` on old pointers | `row_group_collection.cpp:1759-1792`; `table_data_writer.cpp:83-90`, `:136-145` |
| Row group | Reuse `column_pointers` and extra metadata blocks; still re-checkpoint deletes; clear modified bits | `row_group.cpp:1730-1764` |
| Column (v2.0) | `states[c] == nullptr` → reuse `column_pointers[c]` and its per-column extra blocks | `row_group.cpp:1794-1802`, `:1843-1856` |
| Segment data | Unchanged ColumnData → `WritePersistentSegments` copies existing pointers (no data I/O) | `column_data_checkpointer.cpp:363-401`, `:411-447` |
| Deletes | Not loaded, or no new delete commit → reuse `storage_pointers` | `row_group.cpp:1942-1956`; `row_version_manager.cpp:242-248` |

Metadata liveness is tracked per sub-block. At the start of `WriteHeader`,
`MetadataManager::MarkBlocksAsModified` (`metadata_manager.cpp:386-419`) does two things:

1. frees the sub-blocks recorded as modified in the *previous* round.
2. records **every** currently occupied sub-block as "modified" for the next round.

Each reuse path above calls `ClearModifiedBlocks(pointers)` (`metadata_manager.cpp:421-437`), which unsets
the bit so the sub-block survives. Data blocks follow the same pattern:

* `MarkBlockAsModified` (`single_file_block_manager.cpp:964-999`) moves a previously persisted block into
  `modified_blocks`.
* Those blocks become free only **after** the next header has been written
  (`single_file_block_manager.cpp:1411-1420`).

As a result, a checkpoint never overwrites blocks the previous header still references. In experiment V1
the new `meta_block` is sub-block 4 of block 0 because sub-blocks 0–3 still belong to the previous
checkpoint ([§6.5](#65-second-checkpoint-updates-deletes-vacuum-and-metadata-reuse)).

### 3.8 Ordering of writes: what is written when

```
time ─────────────────────────────────────────────────────────────────────────────────────►
CreateCheckpoint: allocate catalog meta_block (metadata block id, often the lowest free id)
│
│  for each catalog entry, in order (sequential):
│   ├─ catalog stream: {99 type, 100 info}
│   └─ if TABLE:
│       ├─ PARALLEL PHASE (WorkOnTasks):
│       │    per row group: analyze+compress columns (unlocked) → FlushSegment (locked):
│       │      block ids allocated; FULL blocks written to disk immediately;
│       │      partial blocks kept in memory
│       ├─ SEQUENTIAL PHASE (segment order 0..R-1):
│       │    RowGroup::Checkpoint: column metadata units → table-data stream (in-memory metadata)
│       │                          deletes → separate MetadataWriter chain per row group
│       ├─ FlushPartialBlocks: remaining partial data blocks written to disk
│       ├─ FinalizeTable: table stats + R + RowGroupPointers → table-data stream;
│       │                 index blocks; catalog fields 101..105
│  metadata_writer.Flush, table_metadata_writer.Flush (in-memory only)
WriteHeader: free-list sub-block → metadata_manager.Flush (METADATA BLOCKS WRITTEN)
             → fsync → DatabaseHeader written to inactive slot → fsync → free old blocks
Truncate file → WAL finish
```

Key facts:

* **Data before metadata.** Data blocks are written during the parallel phase and at `FlushPartialBlocks`.
  Metadata blocks are written only in `WriteHeader` (`single_file_block_manager.cpp:1370`). The header goes
  last, after an `fsync` (`:1384`, `:1405-1410`).
* **Column metadata comes before row-group pointers** in the table-data stream, and both come before the
  next table's data. All tables share one `table_metadata_writer`, so table *k*'s row-group list sits
  between table *k*'s and table *k+1*'s column metadata.
* **Deletes** use a fresh `MetadataWriter(manager, &storage_pointers)` (`row_version_manager.cpp:264-275`).
  Each row group with new delete information gets its own metadata chain, starting at a newly allocated
  sub-block. It is not interleaved with the table-data stream.
* **Partial blocks never span tables.** `FlushPartialBlocks` runs at the end of every table
  (`row_group_collection.cpp:2049`). Verified: two 1000-row tables `a` and `b` land in blocks 1 and 2,
  not both in block 1 ([§6.7](#67-small-checks)).

---

## 4. Multi-threaded checkpoint

### 4.1 Threads and tasks

* `TaskExecutor` (`src/include/duckdb/parallel/task_executor.hpp:21-62`; `src/parallel/task_executor.cpp`)
  wraps a producer token on the global `TaskScheduler`. `ScheduleTask` enqueues tasks (`:31-46`).
  `WorkOnTasks` → `DrainTasks` makes the **calling thread** run queued tasks from this producer until all
  are finished (`:53-83`). Background workers pick up tasks from the same queue.
* The `threads` setting configures `total_threads`. The scheduler starts
  `total_threads - external_threads` background workers (`src/parallel/task_scheduler.cpp:306-321`).
  With the default `external_threads = 1`, **`SET threads=1` means zero background workers**, and the
  checkpointing thread runs every task itself in queue order.
* `CHECKPOINT` uses the client's context (`TaskExecutor(*context)`). Shutdown or automatic checkpoints
  without a context use `TaskScheduler::GetScheduler(db)` (`table_data_writer.cpp:53-58`). Either way the
  thread count is the database instance's `threads` setting **at checkpoint time**.
* **Task granularity is one row group** (`CheckpointTask`, `row_group_collection.cpp:1142-1161`) or one
  vacuum merge window (`VacuumTask`). Within a row group, columns are checkpointed sequentially, in column
  order and depth-first through children.
* **Tables are checkpointed one at a time.** `WorkOnTasks` is a barrier inside
  `RowGroupCollection::Checkpoint` (`:1755`). The maximum useful parallelism is therefore the number of row
  groups (plus vacuum windows) in the *current* table.

Other thread-related settings:

| Setting | Effect | Source |
|---|---|---|
| `threads` | Number of workers that can run CheckpointTasks/VacuumTasks | `task_scheduler.cpp:306-321` |
| `external_threads` | Subtracted from `threads` to get background workers | same |
| `max_vacuum_tasks` (100) | Vacuum tasks per table | `row_group_collection.cpp:1717`; `settings.hpp:1879-1886` |
| `enable_optimistic_write` (true) | Large INSERTs write row groups *before* the checkpoint ([§4.6](#46-optimistic-writes-the-layout-was-often-decided-before-checkpoint)) | `src/storage/optimistic_data_writer.cpp:34-50` |
| `write_buffer_row_group_count` (5) | Row groups buffered before an optimistic flush | `optimistic_data_writer.cpp:90`; `settings.hpp:2483-2491` |
| `preserve_insertion_order` | Changes the parallel INSERT path, and so the RG → row mapping | ([§6.4](#64-parallel-insert-optimistic-writes)) |
| `checkpoint_threshold` (16 MiB) | WAL size that triggers an automatic checkpoint | `settings.hpp:529-531` |
| `experimental_metadata_reuse` (true) | Enables all metadata reuse paths | `settings.hpp:1363-1370` |
| `force_compression` | Overrides the analyze step (changes segment sizes) | `column_data_checkpointer.cpp:183-189` |

### 4.2 Shared state and locking

| Shared object | Lock | Held while | Code |
|---|---|---|---|
| `PartialBlockManager` | `partial_block_lock` (one mutex) | Entire segment placement: `GetBlockAllocation`, memcpy into the partial block, `CreatePartialBlock`, `RegisterPartialBlock`, **including the immediate disk write** of a block that is no longer partial | `column_checkpoint_state.cpp:157-196`; `partial_block_manager.hpp:127-129`, `:145` |
| `SingleFileBlockManager` free list / refcounts | `single_file_block_lock` | Block-id allocation, `MarkBlockAsModified`, ref-count changes | `single_file_block_manager.cpp:898-999` |
| `MetadataManager` | `block_lock` | Sub-block allocation, `ClearModifiedBlocks` | `metadata_manager.cpp:54-96`, `:421-437` |
| `RowGroup` | `row_group_lock` | Lazy column/delete loading | `row_group.cpp:201`, `:1115` |
| `RowVersionManager` | `version_lock` | Delete serialization | `row_version_manager.cpp:239` |
| `TableStatistics` | stats lock | Merging per-RG stats (sequential phase) | `row_group.cpp:1769-1784` |
| `writers[]`, `write_data[]` | none (disjoint slots) | | `row_group_collection.cpp:1151-1152` |

What actually runs in parallel is the **CPU work**: scanning, analyze, compress. Segment *placement* and
full-block writes are serialized by `partial_block_lock`.

### 4.3 Ordering: parallel data, sequential metadata

* Row-group **metadata** (column `PersistentColumnData` units, `RowGroupPointer`s, delete chains) is
  written **after** `WorkOnTasks` returns. It is produced by a plain loop over
  `segment_idx = 0 .. SegmentCount()-1` (`row_group_collection.cpp:1807-1880`) on the checkpointing
  thread, and `RowGroupPointer`s are appended in that order (`AddRowGroup`, `:1876`). Statistics and the
  pointer list follow in `FinalizeTable`.
* So the metadata **stream order is deterministic for a given row-group set**. Only the `DataPointer`
  *values* (block ids and offsets) inside it depend on thread timing.
* Data blocks are allocated in the order segments reach `FlushSegmentInternal`, across all running tasks.
  With N threads, the row groups of a table make progress at the same time, so "column c of every row
  group" tends to reach the partial block manager at about the same moment.

### 4.4 What decides a segment's block and offset

For a segment of size *s* the outcome is fully determined by:

1. the **global order** in which segments of the current table reach the locked section in
   `FlushSegmentInternal` (that is, the thread interleaving),
2. the current contents of `partially_filled_blocks` (free space → block), which depends on (1),
3. *s* itself (≤ 80% → best-fit search; > 80% → new block), the 8-byte alignment, and the 20%-free
   threshold that keeps or flushes the block,
4. the block manager's free list (lowest free id first) and `max_block`, which depend on earlier
   checkpoints, optimistic writes, and metadata allocations,
5. whether the segment is constant (no block) or empty.

### 4.5 Determinism

| Configuration | Physical layout across runs | Why |
|---|---|---|
| `threads=1`, same data, same starting file state | **Deterministic** (A1=A2=A3 by md5 of `pragma_storage_info`) | All tasks run FIFO on one thread; the PBM sees a fixed segment sequence |
| `threads=8` at checkpoint | **Not deterministic** (B1–B5: five different layouts; only 14–28 of 53 non-constant segments match between runs) | Segment arrival order at `partial_block_lock` depends on scheduling |
| `threads=8` vs `threads=1` | Same **logical** content: same RGs, same segments, same counts and compression, same metadata order. **Different** block ids/offsets (A1 vs B*: 1–2 of 53 segments match) and even a different total block count (24 vs 26 data blocks) | Best-fit packing depends on arrival order |
| Parallel INSERT + optimistic write, `preserve_insertion_order=false` | Not deterministic, **including which rows land in which row group** (R1: the 8480-row group is RG 3; R2: RG 4 and RG 0 starts at id 40960) | Thread-local collections are merged in completion order |

Three structural properties hold in every configuration:

1. the metadata stream order,
2. "a segment never spans blocks",
3. "no partial block holds segments of two tables" (for checkpoint-written data).

### 4.6 Optimistic writes: the layout was often decided before CHECKPOINT

For large INSERTs (`enable_optimistic_write=true`, a persistent database):

* `OptimisticDataWriter` writes row groups to disk **during the insert**, once
  `write_buffer_row_group_count` row groups are buffered (`optimistic_data_writer.cpp:74-116`), and the rest
  at commit (`WriteUnflushedRowGroups`, `:124-163`).
* It uses its own `APPEND_TO_TABLE` partial block manager (`:45-48`). Those allocate block ids lazily at
  flush time (`partial_block_manager.cpp:90-91`; `column_checkpoint_state.cpp:71-74`).
* It calls the **multi-row-group** `RowGroup::WriteToDisk(info, row_groups)`, which writes
  **column-at-a-time across row groups** "to co-locate columns across different row groups"
  (`row_group.cpp:1436-1487`, comment at `:1454-1463`).

At the following CHECKPOINT these segments are already persistent and unchanged, so
`ColumnDataCheckpointer` copies their pointers (`column_data_checkpointer.cpp:418-430`). **The checkpoint
thread count then has no effect on data placement.** Experiments E/C/Q show this: the layout is identical
for threads=1 and threads=8 when the insert itself was single-threaded.

---

## 5. Counting row groups and segments, and how wide tables interleave

### 5.1 Row groups

For an append-only table loaded by **one** appending thread:

```
R = ceil(N / row_group_size)           (default row_group_size = 122880)
RG k (k < R-1): rows [k·122880, (k+1)·122880),  tuple_count = 122880
RG R-1        : tuple_count = N − (R−1)·122880
```

For N = 500 000: R = 5, with 4 × 122880 + **8480**. This was observed in every scenario.

Things that change R:

* **Parallel inserts** produce thread-local collections that are merged. Partial row groups can end up
  anywhere (R1 has the 8480-row group in the middle).
* **Appends after a checkpoint** start a new RG (`SUGGEST_NEW`, [§2.2](#22-rowgroupcollection-and-the-row-group-segment-tree)).
* **Vacuum** drops empty RGs and merges windows of up to 3 adjacent RGs into fewer
  ([§3.3](#33-vacuum-dropping-and-merging-row-groups)). In V1, 5 RGs became 3.

### 5.2 Segments per row group

```
segments(RG) = Σ over leaf ColumnData streams L of  segments(L, RG)
segments(L, RG) ≥ 1   (if L has any rows; a constant or empty stream still has exactly 1 segment, block_id = -1)
segments(L, RG) = ceil(compressed_bytes(L, RG) / usable_block_bytes)   roughly, with the cut points
                  chosen by the compression function (always at vector granularity)
```

Leaf streams per column ([§2.4](#24-how-a-column-decomposes-into-columndata-trees-and-segment-streams)):

| Column type | Leaf streams |
|---|---|
| scalar (incl. VARCHAR) | 2 (data + validity) |
| `STRUCT(n fields of scalars)` | 1 + 2n |
| `LIST(scalar)` | 4 (offsets, validity, child data, child validity) |
| `ARRAY(scalar, k)` | 3 (validity, child data, child validity) |

For the experiment table, `2+2+2+2+5+4 = 17` streams per RG. Five RGs give 85 minimum segments. Columns
`i` (BitPacking, ~20 bits/value → 104448 rows fill a block) and `d` (ALP, 100352 rows) need **2 segments**
in each of the 4 full RGs: 85 + 8 = **93 segments**, as observed. 40 of the 93 are `Constant` validity
segments with `block_id = -1`; they take no block space.

### 5.3 How wide tables interleave columns in blocks

There is no per-column block ownership. A block is just a container of segments, and the
`PartialBlockManager` fills it best-fit with any segment of the **current table** that fits:

* A segment > 80% of a block always gets a fresh block. If at least 20% stays free, the block stays open
  for small segments that come later.
* Small segments (tiny validity, small bit-packed ints, dictionary strings, the last segment of a column)
  are packed into the open block with the least sufficient free space.

The thread count changes the *sequence* of placements, and therefore the resulting clustering:

```
threads=1  (row-group-major):  RG0.c0 RG0.c1 … RG0.cK | RG1.c0 RG1.c1 … | RG2…
threads=8  (≈ column-major):    RG0.c0 RG1.c0 RG2.c0 | RG0.c1 RG1.c1 RG2.c1 | …
optimistic WriteToDisk         column-major by construction (row_group.cpp:1466-1472)
```

Experiment W ([§6.7](#67-small-checks)), with 12 small-integer columns and 3 RGs:

```
threads=1                                                 threads=8
1| rg0.c0 rg0.c1 rg0.c2 rg0.c3 rg0.c4                     1| rg2.c0 rg0.c0 rg1.c0 rg0.c1 rg2.c1 rg1.c1 rg0.c2 rg1.c2
2| rg0.c5 rg0.c6 rg0.c7 rg0.c8 rg0.c9                     2| rg2.c2 rg0.c3 rg1.c3 rg2.c3
3| rg0.c10 rg0.c11 rg1.c0 rg1.c1                          3| rg0.c4 rg1.c4 rg2.c4
4| rg1.c2 rg1.c3 rg1.c4 rg1.c6 rg1.c7                     4| rg0.c5 rg1.c5 rg0.c6 rg1.c6
5| rg1.c5 rg1.c8 rg1.c9 rg2.c0                            5| rg2.c5 rg2.c6 rg0.c7 rg1.c7 rg2.c7 rg0.c8
6| rg1.c10 rg1.c11 rg2.c1 rg2.c2                          6| rg1.c8 rg2.c8 rg0.c9 rg1.c9
7| rg2.c3 rg2.c4 rg2.c5                                   7| rg2.c9 rg0.c10 rg1.c10
8| rg2.c6 rg2.c7 rg2.c8 rg2.c9 rg2.c10                    8| rg2.c10 rg0.c11
9| rg2.c11                                                9| rg2.c11 rg1.c11
```

The threads=1 column shows best fit at work: `rg1.c5` (~92 KB) does not fit into block 4's remaining
~75 KB, so it opens block 5. The following `rg1.c6` (~16 KB) then goes back into block 4, which has the
*smallest* sufficient free space.

---

## 6. Empirical validation

### 6.1 Setup

All files are in `/tmp/ckpt_exp`. Data generator (`gen.sql`):

```sql
CREATE TABLE t(
  id BIGINT, i INTEGER, d DOUBLE, s VARCHAR,
  st STRUCT(a INTEGER, b VARCHAR), l INTEGER[]);
INSERT INTO t
SELECT r AS id,
       (hash(r) % 1000000)::INTEGER AS i,
       (hash(r * 7) % 1000000) / 1000.0 AS d,
       'str_' || (hash(r * 3) % 5000) AS s,
       {'a': (hash(r * 11) % 100000)::INTEGER, 'b': 'b' || (hash(r * 13) % 300)} AS st,
       CASE WHEN r % 10 = 0 THEN NULL
            ELSE [ (hash(r*17) % 1000)::INTEGER, (hash(r*19) % 1000)::INTEGER ][1:(r % 3)::INTEGER] END AS l
FROM range(500000) tbl(r);
```

Runner (one fresh file per run; `$4` toggles optimistic writes; `checkpoint_threshold` is raised so that
no automatic checkpoint happens under the *insert* thread setting):

```bash
D=/Users/sgerrits/.duckdb/cli/latest/duckdb
run() { # name insert_threads ckpt_threads optimistic
  rm -f $1.duckdb $1.duckdb.wal
  $D -no-agent $1.duckdb \
    -c "SET checkpoint_threshold='1TB'; SET enable_optimistic_write=$4; SET threads=$2;" \
    -c ".read gen.sql" \
    -c "SET threads=$3; CHECKPOINT;" \
    -c "COPY (SELECT row_group_id, column_name, column_id, column_path, segment_id, segment_type, start,
                     count, compression, persistent, block_id, block_offset
              FROM pragma_storage_info('t') ORDER BY row_group_id, column_id, column_path, segment_id)
         TO '$1.csv' (HEADER);"
}
```

| Scenario | Insert threads | Optimistic write | Checkpoint threads | Purpose |
|---|---|---|---|---|
| A1–A3 | 1 | off | 1 | Pure single-threaded checkpoint layout |
| B1–B5 | 1 | off | 8 | Pure multi-threaded checkpoint layout |
| E1–E3 | 1 | on | 1 | Optimistic (insert-time) layout |
| C1–C3 | 8 | on | 8 | Default settings; `range()` is a single-threaded source |
| P1–P3 | 8 from Parquet, `preserve_insertion_order=true` | on | 8 | Parallel batch insert |
| Q1–Q2 | 1 from Parquet | on | 1 | Control for P |
| R1–R3 | 8 from Parquet, `preserve_insertion_order=false` | on | 8 | Parallel unordered insert |

(The Parquet source `src.parquet` was produced by `COPY t TO 'src.parquet' (ROW_GROUP_SIZE 20000)`, giving
25 Parquet row groups so the read is parallel.)

### 6.2 Determinism fingerprints

md5 of the exported `pragma_storage_info` CSV:

```
A1 71a427300b8b579db79d5f6a140891af   A2 71a42730…   A3 71a42730…      ← identical
B1 aa3097d5…  B2 b68b64b5…  B3 ee2ced13…  B4 a3b5c327…  B5 9fbb8365…  ← all different
C1 cc22d2cc…  C2 cc22d2cc…  C3 cc22d2cc…                                ← identical
E1 cc22d2cc…  E2 cc22d2cc…  E3 cc22d2cc…                                ← identical, = C
Q1 cc22d2cc…  Q2 cc22d2cc…                                              ← identical, = C = E
P1 65a1d62b…  P2 65a1d62b…  P3 65a1d62b…                                ← identical in 3 runs
R1 54215265…  R2 5691b233…  R3 3a16ed1d…                                ← all different
```

Pairwise agreement on `(block_id, block_offset)` for the 53 non-constant segments:

```
A1 vs B1..B5 : 1, 1, 1, 2, 2 of 53
B1 vs B2 : 14/53   B1 vs B3 : 15/53   B2 vs B3 : 28/53   B4 vs B5 : 17/53
R1 vs R2 :  9/51 (different row→RG mapping)               P1 vs P2 : 53/53
```

Block usage (`pragma_database_size`, distinct data blocks, metadata block id):

```
name  total_blocks  data_blocks  metadata_block
A1    25            24           0      ← catalog meta_block allocated first → block 0
A2    25            24           0
B1-5  27            26           0      ← parallel packing is less dense here
E1    27            26           26     ← data blocks allocated during INSERT, metadata last
P1    26            25           25
R1-3  26            25           25
```

Row-group sizes and which rows went into RG 0:

```
P1: 122880,122880,122880,122880,8480   RG0 ids 0..122879
R1: 122880,122880,122880,8480,122880   RG0 ids 0..430079   (rows not contiguous; 8480 RG in the middle)
R2: 122880,122880,122880,122880,8480   RG0 ids 40960..450559
R3: 122880,122880,122880,122880,8480   RG0 ids 0..389119
```

`A1.duckdb` and `A2.duckdb` are not byte-identical files, but the only differences are the main-header
database identifier, the header checksums, and the catalog name embedded in the table CreateInfo
(`"A1"` vs `"A2"`, in sub-block 0). The table and data bytes are identical.

### 6.3 Baseline layout, threads=1 (A1)

`pragma_storage_info('t')`, RG 0 and RG 1 (trimmed):

```
rg col path       seg type      start  count   compression  block_id block_offset
0  id  [0, 0]     0   VALIDITY  0      122880  Constant     -1       0
0  id  [0]        0   BIGINT    0      122880  BitPacking   1        0
0  i   [1, 0]     0   VALIDITY  0      122880  Constant     -1       0
0  i   [1]        0   INTEGER   0      104448  BitPacking   2        0
0  i   [1]        1   INTEGER   104448 18432   BitPacking   1        1208
0  d   [2]        0   DOUBLE    0      100352  ALP          3        0
0  d   [2]        1   DOUBLE    100352 22528   ALP          1        47408
0  s   [3]        0   VARCHAR   0      122880  DICT_FSST    4        0
0  st  [4, 0]     0   VALIDITY  0      122880  Constant     -1       0
0  st  [4, 1, 0]  0   VALIDITY  0      122880  Constant     -1       0
0  st  [4, 1]     0   INTEGER   0      122880  BitPacking   5        0
0  st  [4, 2, 0]  0   VALIDITY  0      122880  Constant     -1       0
0  st  [4, 2]     0   VARCHAR   0      122880  DICT_FSST    1        105920
0  l   [5, 0]     0   VALIDITY  0      122880  Uncompressed 6        32408
0  l   [5, 1, 0]  0   VALIDITY  0      110592  Constant     -1       0
0  l   [5, 1]     0   INTEGER   0      110592  BitPacking   6        47768
0  l   [5]        0   INTEGER[] 0      122880  BitPacking   6        0
1  id  [0]        0   BIGINT    0      122880  BitPacking   6        186664
1  i   [1]        0   INTEGER   0      104448  BitPacking   7        0
1  i   [1]        1   INTEGER   104448 18432   BitPacking   6        187872
…
```

Each block's contents, ordered by offset (A1, threads=1, row-group-major):

```
1 | rg0 [0]@0 | rg0 [1] s1@1208 | rg0 [2] s1@47408 | rg0 [4,2]@105920
2 | rg0 [1] s0@0
3 | rg0 [2] s0@0
4 | rg0 [3]@0
5 | rg0 [4,1]@0
6 | rg0 [5]@0 | rg0 [5,0]@32408 | rg0 [5,1]@47768 | rg1 [0]@186664 | rg1 [1] s1@187872
7 | rg1 [1] s0@0
8 | rg1 [2] s0@0
9 | rg1 [2] s1@0 | rg1 [4,2]@58680 | rg1 [5]@198152
…
23| rg3 [4,2]@0 | rg3 [5,0]@139472 | rg4 [0]@154832 | rg4 [1]@154944 | rg4 [2]@176216 | rg4 [3]@198192
24| rg3 [5,1]@0 | rg4 [4,1]@138896 | rg4 [4,2]@156992 | rg4 [5]@167768 | rg4 [5,0]@170040 | rg4 [5,1]@171320
```

What this shows:

* **Big segments open new blocks.** `i` seg0, `d` seg0, `s`, `st.a` and `l.child` are each > 80% of a block.
* **Small segments fill open blocks.** `id` (sequential values bit-pack to ~1.2 KB), the 18432-row tails
  of `i`, `d` and `st.b` share block 1. The list offsets, list validity and list child of RG 0 share
  block 6, and that block then also receives RG 1's `id`.
* **Offsets are 8-byte aligned** (1208, 47408, 105920).
* **Partial blocks are shared across row groups**, but only within one table.

### 6.4 Parallel checkpoint, threads=8 (B1): same logical layout, different placement

```
rg path   seg  A1(t=1)   B1(t=8)   B2(t=8)   E1(optimistic)
0  [0]    0    1:0       1:123664  1:123664  4:0
0  [1]    0    2:0       3:0       2:0       0:0
0  [1]    1    1:1208    1:184312  1:138112  4:4944
0  [2]    0    3:0       8:0       7:0       5:0
0  [3]    0    4:0       14:0      12:0      10:0
0  [4,2]  0    1:105920  22:0      11:116952 18:69856
0  [5]    0    6:0       20:204288 6:209400  19:150248
4  [0]    0    23:154832 1:0       1:0       4:4832
4  [1]    0    23:154944 1:112     1:112     4:189744
4  [2]    0    23:176216 1:21384   1:21384   18:0
```

B1's block contents:

```
1 | rg4 [0]@0 | rg4 [1]@112 | rg4 [2]@21384 | rg4 [3]@43360 | rg4 [4,1]@91240 | rg4 [4,2]@109336 |
    rg4 [5]@120112 | rg4 [5,0]@122384 | rg0 [0]@123664 | rg1 [0]@124872 | rg4 [5,1]@126080 |
    rg2 [0]@135696 | rg3 [0]@136904 | rg1 [1] s1@138112 | rg0 [1] s1@184312
2 | rg1 [1] s0@0           3 | rg0 [1] s0@0        4 | rg3 [1] s0@0       5 | rg2 [1] s0@0
6 | rg3 [1] s1@0 | rg2 [1] s1@46200 | rg1 [2] s1@92400 | rg0 [2] s1@151080 | rg3 [5]@209592
7 | rg1 [2] s0@0           8 | rg0 [2] s0@0        9 | rg3 [2] s0@0      10 | rg2 [2] s0@0
12| rg1 [3]@0             13 | rg3 [3]@0          14 | rg0 [3]@0         15 | rg2 [3]@0
16..19 | {rg1,rg3,rg0,rg2} [4,1]@0
20| rg3 [4,2]@0 | rg1 [5]@139472 | rg2 [5]@171880 | rg0 [5]@204288
21| rg2 [4,2]@0 | rg3 [5,0]@139472 | rg1 [5,0]@154832 | rg2 [5,0]@170192 | rg0 [5,0]@185552
22| rg0 [4,2]@0   23..26 | {rg3,rg1,rg2,rg0} [5,1]@0
```

What this shows:

* **Row groups interleave inside blocks.** Block 1 has small segments from all five RGs.
* **Placement becomes column-major.** Blocks 2–5 are column `i` seg0 of RGs 1, 0, 3, 2 (in completion
  order). Blocks 7–10 are `d`, 12–15 are `s`, 16–19 are `st.a`, 23–26 are `l.child`.
* **The small last RG (8480 rows) finishes first**, so its segments take the first offsets of block 1.
* **RG order in block-id space is arbitrary** (1, 0, 3, 2), and differs between B1 and B2.
* **Logical content is unchanged.** RG count, segment count (93), and per-segment `count`, `start`,
  `segment_type` and `compression` match A1 for **all 93 segments** in each of B1–B5 (a full outer join
  on `(rg, path, seg)` gives 93/93 matches).

### 6.5 Second checkpoint: updates, deletes, vacuum and metadata reuse

**Update (U).** Starting from `A1.duckdb`: `UPDATE t SET i=-1 WHERE id=250000; CHECKPOINT` (threads=1).
`[0]`, `[1]` and `[4,2]` placements per RG:

```
before                                              after
0|[0]:1@0  [1]:2@0  [1]:1@1208  [4,2]:1@105920    0| unchanged
1|[0]:6@186664 [1]:7@0 [1]:6@187872 [4,2]:9@58680 1| unchanged
2|[0]:12@154256 [1]:13@0 [1]:12@155464 [4,2]:17@0 2|[0]:12@154256 [1]:25@0 [1]:26@0 [4,2]:17@0
3|…                                                3| unchanged
4|…                                                4| unchanged
database_size: total_blocks 27, used 26, free 1;   metadata sub-blocks used 5
```

* **Only the updated column of the updated RG is rewritten**: RG 2, column `i`, both segments. This is
  the `PARTIALLY_REUSE_COLUMN_METADATA` path plus `ColumnDataCheckpointer` change detection.
* **Its old blocks are released.** Block 13 is freed. Block 12 is a shared partial block and only loses a
  reference.
* **The rewrite does not reuse old partial blocks.** The 18432-row tail goes to a **new** block 26 rather
  than into free space of an older block, because the `PartialBlockManager` starts empty in every
  checkpoint.

**Delete + vacuum (V1 and V8).** Starting from `A1.duckdb`:
`DELETE FROM t WHERE id < 200000 OR (id >= 300000 AND id < 400000); CHECKPOINT`.

```
rg rows    [0] / [1] placement
0  100000  [0]:25@0  [1]:26@0                          ← NEW: merged from old RG1 (45760 live) + RG2 (54240 live)
1  122880  [0]:17@187240 [1]:19@0 [1]:17@188448        ← old RG3, data REUSED, 31360 deletes stored separately
2  8480    [0]:23@154832 [1]:23@154944                 ← old RG4, REUSED
count(*) = 200000, min(rowid) = 122880, max(rowid) = 499999
decoded catalog: total_rows = 231360, next_row_id = 500000, meta_block = 0x0400000000000000 (block 0, sub-block 4)
database_size: total_blocks 30, used 14, free 16      (same result with threads=1 and threads=8)
```

Walking through it with [§3.3](#33-vacuum-dropping-and-merging-row-groups):

1. Old RG 0 has 0 committed rows and is dropped in `InitializeVacuumState`.
2. At segment 1 the window {RG1: 45760, RG2: 54240} = 100000 ≤ 122880. Adding RG3 (91520) would exceed it,
   so `merge_count = 2 > target_count = 1` and a merge is scheduled.
3. At segment 3 the window {RG3: 91520, RG4: 8480} reaches the end of the table. 100000 is less than
   `min(2·91520, 122880) = 122880`, so the **tail rule** skips the merge.
4. RG 3 keeps its column metadata and data blocks (per-column reuse). Only its delete vectors are
   serialized.
5. The merged RG keeps `row_start = 122880` (RG 1's start). The rowid gap is persisted (storage ≥ v2.0,
   `next_row_id` field 105).

### 6.6 Raw bytes: decoding the pointer graph of `A1.duckdb`

**DatabaseHeader (h1 at file offset 4096):**

```
00001000: 70bd c6b6 d6e5 8276 | 0100 0000 0000 0000 | 0000 0000 0000 0000 | 0000 0000 0000 0003
          checksum            | iteration = 1       | meta_block = 0x0    | free_list = 0x03<<56
00001020: 1900 0000 0000 0000 | 0000 0400 0000 0000 | 0008 0000 0000 0000 | 4500 0000 0000 0000
          block_count = 25    | alloc = 262144      | vector_size = 2048  | storage = 69 (V2_0_0)
```

* `meta_block = 0` means block 0, sub-block 0.
* `free_list = 0x0300000000000000` means block 0, sub-block 3.

**Metadata block 0** sits at file offset 12288. Its sub-blocks begin at `12288 + 8 + i·4088`, and each
starts with an 8-byte next pointer:

```
sub 0  next=-1          ~317 B used   catalog stream
sub 1  next=0x02<<56    full          table-data stream: column metadata (continues in sub 2)
sub 2  next=-1          ~3120 B used  …column metadata | @1685: TableStatistics, RG count, RG pointers
sub 3  next=-1          ~144 B used   free list: free=[], multi_use=[(9,3),(12,5),(1,4),(23,6),(17,5),
                                       (6,5),(18,3),(24,6)], metadata blocks=[(0, free-mask 0x…fff0)]
```

`multi_use` lists the partial blocks with their segment reference counts. For example, block 1 → 4 matches
the four segments in block 1 in [§6.3](#63-baseline-layout-threads1-a1).

**End of the table entry in the catalog stream** (field IDs are `u16` little-endian; integers are LEB128
varints, signed for `int64`; `ff ff` ends an object):

```
65 00                       field 101 table_pointer {
  64 00 80 80 80 80 80 80 80 80 02     100 block_pointer = 2<<56   (block 0, sub-block 2)
  65 00 95 0d                          101 offset = 1685
ff ff                       }
66 00 a0 c2 1e              field 102 total_rows = 500000
67 00 00                    field 103 index_pointers = []
68 00 00                    field 104 index_storage_infos = []
69 00 a0 c2 1e              field 105 next_row_id = 500000
```

**At `table_pointer` (sub-block 2, offset 1685):** 769 bytes of `TableStatistics`, then:

```
05 00 00 00 00 00 00 00                  u64 row_group_count = 5
64 00 00                                 RG0: 100 row_start = 0
65 00 80 c0 07                               101 tuple_count = 122880
66 00 06                                     102 data_pointers: 6 entries
   {64 00 <1<<56> 65 00 08}                    col0 → block 0 sub 1 @8
   {… 65 00 77}  {… a9 02} {… f4 03}           col1 @119, col2 @297, col3 @500
   {… f5 04}     {… 9d 07}                     col4 @629, col5 @925
67 00 00                                     103 delete_pointers = []
68 00 01                                     104 has_metadata_blocks = true
6a 00 01                                     106 has_per_column_metadata_blocks = true
ff ff
64 00 80 c0 07 65 00 80 c0 07 66 00 06 …    RG1: row_start = 122880, tuple_count = 122880, …
```

**Column metadata of RG0.`id`** (sub-block 1, offset 8, 111 bytes):

```
64 00 01                                  100 data_pointers: 1 DataPointer
   65 00 80 c0 07                           101 tuple_count = 122880   (100 row_start omitted: ≥ v1.5)
   66 00 {64 00 01 ff ff}                   102 block_pointer = {block_id 1, offset 0 (default)}
   67 00 06                                 103 compression_type (BitPacking)
   68 00 {…}                                104 statistics (min/max …)
   6a 00 01 b8 09                           106 byte_size = 1208      ← the next segment in block 1 starts at 1208
ff ff
65 00 {64 00 01 {65 00 80 c0 07            101 validity: 1 DataPointer, tuple_count 122880,
        66 00 {64 00 7f …} 67 00 …}}            block_id = 0x7f = -1 (signed LEB128) → Constant, no block
```

Every link of the graph in [§1.7](#17-the-full-pointer-graph) is visible in these bytes: header →
catalog sub-block → `table_pointer` → RG pointers → column metadata → `{block_id, offset}` → segment bytes.

### 6.7 Small checks

* **Partial blocks are per table.** With threads=1 and optimistic writes off:
  `CREATE TABLE a AS SELECT range i FROM range(1000); CREATE TABLE b AS SELECT range*2 j FROM range(1000); CHECKPOINT;`
  gives `a [0]` → block 1 @0 and `b [0]` → block 2 @0. Each table's tiny segment gets its own block.
* **Wide-table interleave (W).** Twelve `INTEGER` columns with `c_k = hash(r·(k+1)) % 2^((k mod 6)+1)`
  and 368640 rows (3 RGs). Both settings use 9 blocks; threads=1 packs row-group-major and threads=8
  packs nearly column-major ([§5.3](#53-how-wide-tables-interleave-columns-in-blocks)).
* **Wide columns that don't share.** With 24 columns of 10–15 bits per value (`% ((k+1)·1000)`), each
  bit-packed segment is roughly 58–88% of a block. Any leftover space (< 42%) is too small for the next
  column's segment, so every segment gets its own block. Block ids then follow placement order exactly: RG-major (`1..24` = rg0.c0..c23) with threads=1,
  alternating `rg0.cK, rg1.cK` with threads=8.

---

## 7. Summary of invariants

**File structure**

1. The only root is the active `DatabaseHeader`. Everything reachable from `meta_block` (plus the free
   list) is live; everything else is free or freed after the next checkpoint
   (`single_file_block_manager.cpp:1320-1423`).
2. A checkpoint never overwrites a block or metadata sub-block that the current header references.
   Freed blocks go to `modified_blocks` and are released only after the new header is synced
   (`single_file_block_manager.cpp:964-999`, `:1411-1420`; `metadata_manager.cpp:386-419`).
3. Write order is data blocks → metadata blocks → fsync → header → fsync (`:1370-1410`).
4. Metadata block ids and data block ids come from one allocator (lowest free id first). A metadata
   pointer packs `block_id | sub_block << 56` (`metadata_manager.cpp:196-208`).

**Logical layout**

5. Table ⊃ ordered row groups (by `row_start`, possibly with gaps on ≥ v2.0) ⊃ one `PersistentColumnData`
   tree per top-level column ⊃ leaf segment streams ⊃ segments.
6. `RowGroupPointer.data_pointers.size()` equals the table's physical column count; otherwise the reader
   reports corruption (`row_group.cpp:52-54`). Each loaded column's `count` must equal the RG's
   `tuple_count` (`:217-221`).
7. **A segment never spans blocks.** One `(block_id, offset, byte_size)` gives its complete byte range.
   Constant segments have `block_id = -1` and no bytes.
8. Offsets inside a shared block are 8-byte aligned. Gaps and tails are zero-filled before writing
   (`partial_block_manager.cpp:24-36`, `:131-138`).
9. `total_rows` = Σ physical `tuple_count`, including deleted rows not yet vacuumed.
   `next_row_id` = max(`row_start + tuple_count`) (`table_data_writer.cpp:119-126`).

**Checkpoint behavior**

10. The catalog stream is ordered per schema as types → sequences → tables (FK-ordered) → views →
    triggers → macros → table macros → indexes, then topologically re-sorted by dependencies.
11. Within one table's metadata, all column metadata units come before the `TableStatistics` + RG list
    at `table_pointer`. The RG list is in segment order.
12. Row-group *data* is produced in parallel (one task per RG or vacuum window). Row-group *metadata* is
    produced sequentially, in RG order, after all tasks finish.
13. Segment placement is serialized by one `partial_block_lock` per checkpoint. Partial blocks are shared
    across RGs and columns of one table, but never across tables (flushed per table).
14. Unchanged data is never rewritten, and unchanged metadata is reused at table, RG or column level when
    `experimental_metadata_reuse` is on.
15. Vacuum (full checkpoints only) drops empty RGs and merges ≤ 3 adjacent RGs into fewer, subject to the
    tail rule and the index or rowid constraints.

**Determinism**

16. With threads=1, the same data and the same starting file state, the physical layout is
    deterministic. With threads > 1, the logical layout (RGs, segments, compression, metadata order) is
    deterministic, but block ids and offsets — and even the total block count — are not.
17. With optimistic writes, the layout is decided at INSERT time by the multi-RG, column-at-a-time
    `WriteToDisk`. The checkpoint thread count then does not matter for already-persisted row groups.

---

## 8. Quick reference: serialized field IDs

| Object | Field IDs | Source |
|---|---|---|
| Catalog root | 100 `catalog_entries` | `checkpoint_manager.cpp:274` |
| Catalog entry | 99 `catalog_type`, 100 payload | `checkpoint_manager.cpp:412-460` |
| Table entry (extra) | 101 `table_pointer`, 102 `total_rows`, 103 `index_pointers`, 104 `index_storage_infos`, 105 `next_row_id` | `table_data_writer.cpp:188-219` |
| TableStatistics | 100 `column_stats`, 101 `table_sample` | `table_statistics.cpp:236-247` |
| RowGroupPointer | 100 `row_start`, 101 `tuple_count`, 102 `data_pointers`, 103 `delete_pointers`, 104 `has_metadata_blocks`, 105 `extra_metadata_blocks`, 106 `has_per_column_metadata_blocks`, 107 `per_column_metadata_blocks` | `row_group.cpp:1958-1978` |
| PersistentColumnData | 99 `extra_data`, 100 `data_pointers`, 101 `validity`, 102 `child_column` / `sub_columns` / `unshredded`, 103 `shredded` | `column_data.cpp:937-978` |
| DataPointer | 100 `row_start` (< v1.5), 101 `tuple_count`, 102 `block_pointer`, 103 `compression_type`, 104 `statistics`, 105 `segment_state`, 106 `byte_size` (≥ v2.0) | `serialize_storage.cpp:27-39` |
| BlockPointer | 100 `block_id`, 101 `offset` | `serialize_storage.cpp:15-18` |
| MetaBlockPointer | 100 `block_pointer`, 101 `offset` | `serialize_storage.cpp:108-111` |
| Delete chain (raw) | u64 count, {u64 vector_idx, ChunkInfo}… | `row_version_manager.cpp:264-275` |

---

## 9. Limitations and caveats

* **Binary/source mismatch.** The experiments used CLI build `b32b1368b8` (v2.0.0-alpha49003), not
  `fb38af476a7`. The behavior matched the source in every case I checked (field IDs, header layout,
  vacuum decisions, partial-block rules), but small differences between the two builds can't be ruled out.
* **Non-determinism is timing-dependent.** P1–P3 (parallel batch insert with order preserved) produced
  identical layouts in 3 runs. That is an observation, not a guarantee: the code has no ordering barrier
  that would make it deterministic in general.
* **What the CSV hashes cover.** They hash `pragma_storage_info` output (placement and segmentation), not
  the full files. File bytes also differ in the header identifier, the checksums and the catalog name.
* **Not measured byte-by-byte.** Index storage (ART blocks, `IndexStorageInfo`), overflow-string blocks
  (`segment_state`), and the per-column extra metadata blocks of very wide tables are described from the
  source only.
* **Machine and data dependence.** Thread scheduling, and therefore the exact B/R layouts, depends on the
  machine. Segment byte sizes depend on the data and the compression analysis.
