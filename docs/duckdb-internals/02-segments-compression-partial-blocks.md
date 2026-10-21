# DuckDB internals 02 — Column segments, checkpoint compression, and partial-block packing

This document explains how a column's data becomes **column segments**, how a checkpoint compresses
those segments, and how the **PartialBlockManager** packs one or more segments into the 256 KiB blocks
of a `.duckdb` file. It also covers sharing blocks between segments, reference counting, segment reuse
across checkpoints, parallel checkpoints, and optimistic writes.

## 0. Conventions, sources, and validation environment

* **Source tree:** `/Users/sgerrits/repos/duckdb` at commit `fb38af476a7`
  (`perf(variant): Optimize shredded vector value retrieval (#25458)`). The tree was used read-only.
  Paths in citations are relative to the repository root. `file:12-34` means lines 12 through 34.
  Every citation also names the function or type.
* **Binary used for experiments:** `/Users/sgerrits/.duckdb/cli/latest/duckdb`, which reports
  `v2.0.0-alpha49003 (Cyanoptera) b32b1368b8`. This binary was **not** built from `fb38af476a7`.
  `git diff b32b1368b8 fb38af476a7` shows these placement files are byte-identical in both trees:
  * `src/storage/partial_block_manager.cpp`
  * `src/include/duckdb/storage/partial_block_manager.hpp`
  * `src/storage/table/column_checkpoint_state.cpp`
  * `src/storage/table/column_data_checkpointer.cpp`
  * `src/storage/table/in_memory_checkpoint.cpp`

  Other files differ, mainly by corruption hardening and changes to scan and select signatures. The
  segment layouts and the block-assignment logic described here behave the same in both trees.
* **Terminology**
  * **Block:** one allocation unit of the single-file block manager, 262,144 bytes on disk.
  * **Usable block size:** a block minus its 8-byte checksum header, 262,136 bytes. This is what
    `BlockManager::GetBlockSize()` returns.
  * **Segment:** one `ColumnSegment`.
  * **Partial block:** a block that the `PartialBlockManager` has not yet written to disk because
    more segments may still be appended to it.

### 0.1 Constants used throughout

| Constant | Value | Source |
|---|---|---|
| `DEFAULT_BLOCK_ALLOC_SIZE` | 262144 | `src/include/duckdb/storage/storage_info.hpp:33` |
| `DEFAULT_BLOCK_HEADER_STORAGE_SIZE` / `Storage::DEFAULT_BLOCK_HEADER_SIZE` | 8 (`sizeof(idx_t)`, the checksum) | `storage_info.hpp:35`, `:64` |
| `Storage::DEFAULT_BLOCK_SIZE` (usable) | 262144 − 8 = **262136** | `storage_info.hpp:68` |
| `BlockManager::GetBlockSize()` | `block_alloc_size − block_header_size` | `src/include/duckdb/storage/block_manager.hpp:144-146` |
| `Storage::FILE_HEADER_SIZE` | 4096 | `storage_info.hpp:56` |
| `SingleFileBlockManager::BLOCK_START` | 3 × 4096 = 12288 (main header plus two DB headers) | `src/include/duckdb/storage/single_file_block_manager.hpp:70` |
| File position of block *b* | `BLOCK_START + b * GetBlockAllocSize()` | `src/storage/single_file_block_manager.cpp:1158-1160` (`GetBlockLocation`) |
| `max_partial_block_size` (default) | `GetBlockSize() / 5 * 4` = 262136/5*4 = **209708** | `src/storage/partial_block_manager.cpp:52-53` (ctor) |
| "still partial" threshold for remaining space | `GetBlockSize() − max_partial_block_size` = **52428** | `partial_block_manager.cpp:141` (`RegisterPartialBlock`) |
| Compaction flush limit used by string/dictionary/FSST compressors | `GetBlockSize() / 5 * 4` (same 80%) | `src/include/duckdb/function/compression_info.hpp:22-24` (`GetCompactionFlushLimit`) |
| `AlignValue(n)` default alignment | 8 | `src/include/duckdb/common/helper.hpp:197-200` |
| `PartialBlockManager::DEFAULT_MAX_USE_COUNT` | `1u << 20` | `partial_block_manager.hpp:95` |
| `PartialBlockManager::MAX_BLOCK_MAP_SIZE` | `1u << 31` | `partial_block_manager.hpp:98` |
| `initial_column_segment_size` default | 2048 | `src/include/duckdb/main/settings.hpp:1668-1680` |

---

## 1. `ColumnSegment`: the unit of column storage

### 1.1 Class hierarchy: `SegmentBase`, `SegmentNode`, `SegmentTree`

* **`SegmentBase<T>`** holds a single field, `atomic<idx_t> count` ("The amount of entries in this
  storage chunk") (`src/include/duckdb/storage/table/segment_base.hpp:16-24`). In this tree the base
  class has no `start` field.
* **`SegmentNode<T>`** wraps a `shared_ptr<T> node` and carries the segment's position:
  * `row_start`, the start row relative to the owning tree.
  * an atomic `next` pointer.
  * the node's `index` in the tree.

  See `src/include/duckdb/storage/table/segment_tree.hpp:22-85`. The node fields are at lines 75-84.
  `GetRowStart()` returns `row_start`. `GetRowEnd()` returns `row_start + node->count`
  (`segment_tree.hpp:37-42`). A segment's start is therefore a property of its tree node, not of the
  `ColumnSegment`.
* **`SegmentTree<T, SUPPORTS_LAZY_LOADING>`** holds `vector<unique_ptr<SegmentNode<T>>> nodes` behind a
  mutex (`segment_tree.hpp:103-360`, members at 355-360). It also holds a `base_row_id`.
  * `AppendSegmentInternal(l, segment)` gives a new node `row_start = last->GetRowEnd()`, or
    `base_row_id` for the first node. It also links `next` (`segment_tree.hpp:479-498`).
  * Lookups use `TryGetSegmentIndex`, which binary-searches the half-open interval
    `[row_start, row_end)` (`segment_tree.hpp:268-300`).
  * The `Verify` method asserts that nodes are contiguous in debug builds (`segment_tree.hpp:302-314`).
* **`ColumnSegmentTree`** is `SegmentTree<ColumnSegment>` with lazy loading off
  (`src/include/duckdb/storage/table/column_segment_tree.hpp:16`). Lazy loading is a row-group-level
  feature: `LoadNextSegment` returns `false` unless `SUPPORTS_LAZY_LOADING` is set
  (`segment_tree.hpp:455-468`).

### 1.2 `ColumnSegment` fields

`src/include/duckdb/storage/table/column_segment.hpp:37-190`:

| Field | Meaning |
|---|---|
| `segment_type` | `ColumnSegmentType::TRANSIENT` or `PERSISTENT` (enum at line 37) |
| `block` | `shared_ptr<BlockHandle>`. This is `nullptr` for constant segments (comment at `column_segment.cpp:106`). |
| `function` | Reference to the `CompressionFunction` that encodes the bytes |
| `block_id` | On-disk block id for persistent segments, otherwise `INVALID_BLOCK` (-1). `GetBlockId()` asserts that the segment is persistent (lines 109-112). |
| `offset` | Byte offset of this segment inside `block` (`GetBlockOffset()`) |
| `segment_size` | Allocated size of the in-memory buffer slice, bounded by the block size (comment at line 182) |
| `data_size_in_bytes` | `optional<uint32_t>`, the number of bytes the segment actually occupies. This is set at flush time. |
| `segment_state` | `unique_ptr<CompressedSegmentState>`, runtime per-segment state such as overflow blocks |
| `stats` | `SegmentStatistics`, which holds the zone map for the segment |

The constructor calls `function.init_segment(*this, block_id, segment_state_p)` when it is defined.
This converts a deserialized `ColumnSegmentState` into a runtime `CompressedSegmentState`
(`src/storage/table/column_segment.cpp:92-108`).

### 1.3 Transient segments: allocation during appends

Appends always write to **transient, uncompressed** segments.
* `ColumnData::InitializeAppend` appends a new transient segment in two cases: when the tree is
  empty, or when the last segment is persistent or has no `init_append`
  (`src/storage/table/column_data.cpp:588-609`).
* `ColumnData::AppendData` loops until all rows are written. When a segment is full, it flushes the
  segment's stats and calls `AppendTransientSegment(..., append_segment)` (`column_data.cpp:611-641`).

`ColumnData::AppendTransientSegment` (`column_data.cpp:759-801`) chooses the size of the next segment:

1. If there is no previous segment, or the previous segment is persistent:
   `segment_size = max(GetTypeIdSize(type), initial_column_segment_size)` (lines 766-768).
   Otherwise the new size is `prev_segment->SegmentSize() * 2`, a doubling growth policy (line 770).
2. Validity (`BIT`) segments are at least `ValidityMask::STANDARD_MASK_SIZE` (lines 775-777).
3. If `segment_size >= 1024`, it is rounded with
   `segment_size = NextPowerOfTwo(segment_size) − block_header_size`, so that 2048 becomes
   2048 − 8 = 2040 (lines 783-786).
4. The size is capped at `block_manager.GetBlockSize()` (lines 789-790).
5. The function is always `COMPRESSION_UNCOMPRESSED` (line 793).
6. The segment is allocated from the row group's **`SuballocationBlock`** only when all of these hold:
   * a `transient` pointer was supplied,
   * `segment_size < block_size`,
   * `initial_bytes < segment_size`.

   Otherwise it gets its own buffer (lines 795-799).

Allocation paths:

* `ColumnSegment::CreateTransientSegment` calls `BufferManager::RegisterTransientMemory(segment_size,
  block_manager)` and creates the segment with `INVALID_BLOCK` and offset 0
  (`column_segment.cpp:55-66`). `StandardBufferManager::RegisterTransientMemory` creates a
  **small, non-block-sized** buffer through `RegisterSmallMemory` when `size < block size`. Otherwise it
  allocates a full block buffer (`src/storage/standard_buffer_manager.cpp:140-152`, `154-169`).
* `SuballocationBlock::CreateTransientSegment` carves `segment_size` bytes out of one shared
  temporary-block-sized buffer. It keeps `allocated` as a bump pointer and starts a new buffer when
  the request no longer fits. The segment's `offset` is set to the bump position
  (`column_segment.cpp:68-87`; struct in `src/include/duckdb/storage/table/append_state.hpp:32-43`).
  `RowGroup::InitializeAppendInternal` passes `&append_state.transient` to each top-level column
  (`src/storage/table/row_group.cpp:1265-1278`, line 1275). Child append states, such as validity
  in `StandardColumnData::InitializeAppend` (`src/storage/table/standard_column_data.cpp:123-128`),
  do not receive it. Those segments therefore always get a standalone buffer at offset 0.

Observed in an in-memory database (`INSERT ... range(100000)` into `t(a INT, b INT)`): the segment
`count`s of `a` were 510, 1022, 2046, 4094, 8190, 16382, 32766, 34990. These match buffer sizes of
2040, 4088, 8184, 16376, 32760, 65528, 131064 bytes divided by 4 bytes per value. The 8-byte header
is subtracted after each power-of-two rounding. The validity segments held 14336, 30720, and 54944
rows. The first of these is 2040 bytes / 256 bytes-per-2048-rows rounded down to 7 masks.

### 1.4 Checkpoint-time segments are full-block buffers

Every compression function creates its output segments through `CompressionState::CreateNewSegment`.
That function calls `ColumnSegment::CreateTransientSegment(..., info.GetBlockSize(), ...)`, which
creates a **full usable-block-size buffer** at offset 0
(`src/storage/compression/standard_compression_state.cpp:11-14`). The compressor fills the buffer,
compacts it, and reports the number of bytes actually used as `segment_size` in `FlushSegment`
(§2.6).

### 1.5 Becoming persistent

Three methods change a segment from `TRANSIENT` to `PERSISTENT`:

* **`ColumnSegment::ConvertToPersistent(context, block_manager, block_id)`**
  (`column_segment.cpp:252-275`) sets `segment_type = PERSISTENT`, `block_id`, and `offset = 0`.
  * If `block_id != INVALID_BLOCK`, it calls `block_manager->ConvertToPersistent(context, block_id,
    std::move(block))`. That call registers the on-disk id, converts the in-memory buffer, **writes it
    to disk** (`Write(context, *converted_buffer, block_id)`), and swaps the handle
    (`src/storage/buffer/block_manager.cpp:59-118`, `120-126`).
  * If `block_id == INVALID_BLOCK`, the stats must be constant. The function is replaced with
    `COMPRESSION_CONSTANT` and the buffer is released with `block.reset()`. No block is written.
* **`ColumnSegment::MarkAsPersistent(block, offset_in_block)`** is used by the second and later
  segments of a shared block. It takes `block_id` from the shared handle and calls `SetBlock`. No I/O
  happens here, because the first segment's conversion already wrote the whole block
  (`column_segment.cpp:277-281`; comment in header lines 102-104).
* **`ColumnSegment::SetBlock(block, offset)`** sets `PERSISTENT`, `offset`, and `block`
  (`column_segment.cpp:283-287`). The in-memory checkpoint path also uses it (§3.10).

`ColumnSegment::CreatePersistentSegment(db, block_manager, data_pointer)` loads a segment from a
`DataPointer` (`column_segment.cpp:30-53`):
* It calls `block_manager.RegisterBlock(block_id)` only if `block_id != INVALID_BLOCK`. Constant
  segments have no block.
* It sets `segment_size = block_manager.GetBlockSize()` and passes `byte_size` through as
  `data_size_in_bytes`.

### 1.6 `DataPointer`: the per-segment metadata record

`src/include/duckdb/storage/data_pointer.hpp:51-73`:

| Field | Type | Meaning |
|---|---|---|
| `row_start` | `uint64_t` | First row of the segment relative to its column in the row group |
| `tuple_count` | `uint64_t` | `segment.count` |
| `block_pointer` | `BlockPointer {block_id, offset}` | Where the segment's bytes begin |
| `compression_type` | `CompressionType` | Selects the `CompressionFunction` on load |
| `byte_size` | `optional<uint32_t>` | Bytes occupied inside the block |
| `statistics` | `BaseStatistics` | Segment zone map |
| `segment_state` | `unique_ptr<ColumnSegmentState>` | Serialized compression state. Its base class carries `vector<block_id_t> blocks` (`data_pointer.hpp:29-49`). |

A `DataPointer` is created in one of two ways:
* For **newly written** segments, by `ColumnCheckpointState::FlushSegmentInternal`
  (`src/storage/table/column_checkpoint_state.cpp:204-219`). There `row_start` is the previous
  pointer's `row_start + tuple_count`.
* For **existing persistent** segments, by `ColumnSegment::GetDataPointer(row_start)`
  (`column_segment.cpp:289-305`). It copies `block_id` and `offset` and calls `serialize_state` if one
  is defined.

**Serialization** is generated code in `src/storage/serialization/serialize_storage.cpp`:

```
BlockPointer::Serialize   (:15-18)  100 block_id, 101 offset (default 0 omitted)
DataPointer::Serialize    (:27-39)
  100 row_start      – ONLY if !ShouldSerialize(V1_5_0), i.e. when targeting storage < v1.5.0
  101 tuple_count
  102 block_pointer
  103 compression_type
  104 statistics
  105 segment_state  (WithDefault: omitted when nullptr)
  106 byte_size      – ONLY if ShouldSerialize(V2_0_0)
DataPointer::Deserialize  (:41-56)  ReadDeletedProperty(100,"row_start"); ...
                                    Set<CompressionType> so that ColumnSegmentState can dispatch
```

`ColumnSegmentState::Deserialize` looks up the compression function from the
`CompressionType` and physical type in the deserializer context. It then calls that function's
`deserialize_state` (`src/storage/data_pointer.cpp:31-42`).

Because `row_start` is no longer stored, the loader rebuilds it:
`ColumnData::InitializeColumn` assigns `data_pointer.row_start = count` cumulatively
(`column_data.cpp:885-905`, line 891). Older targets still need absolute starts, so
`RowGroup::Checkpoint` adds the row group start through `IncrementSegmentStart` before serializing
(`src/storage/table/row_group.cpp:1713-1720`, used at 1821-1824). `PersistentColumnData::Serialize`
writes the vector under field `100 "data_pointers"`, with validity as `101` and other children after
it (`column_data.cpp:937-978`).

The `byte_size` value bounds reads: `CompressionSegmentReader::FromSegment` throws if `byte_size`
exceeds `block_size − block_offset` (`src/storage/compression/compression_segment_reader.cpp:9-21`).

---

## 2. Compression at checkpoint

### 2.1 Granularity: per column, per row group

`RowGroup::WriteToDisk(RowGroupWriter&)` calls `CheckpointColumn` for each column whose changes
require a rewrite (`row_group.cpp:1597-1711`, loop at 1659-1697). `CheckpointColumn` calls
`column.Checkpoint(row_group, checkpoint_info)` (`row_group.cpp:1419-1434`). For a standard column,
`StandardColumnData::Checkpoint` builds checkpoint states for the data column and its validity child.
It then runs **one `ColumnDataCheckpointer` over both states together**
(`standard_column_data.cpp:279-314`). The compression choice is therefore made **per (column, row
group)**, separately for the data stream and the validity stream. All segments that this checkpoint
writes for that pair use the chosen function, with two exceptions:
* any segment whose stats are constant becomes `CONSTANT` (§2.7),
* validity may be replaced by `EMPTY` (§2.5).

### 2.2 `ColumnDataCheckpointer` lifecycle

`src/storage/table/column_data_checkpointer.cpp`:

1. **Constructor** (lines 73-90). Fetches `config.GetCompressionFunctions(physical_type)` for each
   state. That list excludes disabled methods and methods that cannot be emitted.
   `EmitCompressionFunction` excludes `CONSTANT`, `EMPTY`, and `AUTO`
   (`src/function/compression_config.cpp:114-150`). The candidate order is the order of
   `internal_compression_methods`: constant, uncompressed, rle, bitpacking, dictionary, chimp, patas,
   alp, alprd, fsst, zstd, roaring, empty, dict_fsst (`compression_config.cpp:17-35`).
2. **`Checkpoint()`** (lines 411-435). If no state's column `HasChanges()`, it marks every block id as
   checkpointed through `CheckpointBlockIdMarker` and returns (§4.4). Otherwise it calls
   `WriteToDisk()`.
3. **`WriteToDisk()`** (lines 310-357) runs four steps:
   * `DetectBestCompressionMethod()` (analyze).
   * `init_compression`.
   * `ScanSegments(compress)`.
   * `compress_finalize`, then `DropSegments()`.
4. **`FinalizeCheckpoint()`** (lines 437-448). If nothing changed, `WritePersistentSegments` copies the
   existing `DataPointer`s.

`ScanSegments` (lines 92-115) walks all old segments, whether transient or persistent. It reads at
most `STANDARD_VECTOR_SIZE` rows at a time through `ColumnData::CheckpointScan`, which also merges
committed updates (`column_data.cpp:835-851`). It passes each vector to a callback. **Both analyze
and compress therefore see the complete column of the row group, one vector at a time and in row
order.**

### 2.3 Analyze phase and scoring

`DetectBestCompressionMethod` (lines 172-271) runs in five steps:

1. **Forced compression.** The per-column `USING COMPRESSION` setting, or the global
   `force_compression` setting, calls `ForceCompression`. That function nulls out every candidate
   except the forced method and `UNCOMPRESSED`, which stays as a fallback (lines 117-152, 178-190).
2. **`InitAnalyze()`** calls `func->init_analyze(col_data, physical_type)` for each candidate
   (lines 154-170). A function may return `nullptr` to opt out:
   * dictionary and FSST opt out when the storage target is ≥ v1.3.0
     (`src/storage/compression/dictionary_compression.cpp:70-78`, `fsst.cpp:99-106`).
   * dict_fsst opts out when the target is < v1.3.0 (`dict_fsst.cpp:71-79`).
   * zstd opts out for in-memory databases or targets < v1.2.0 (`zstd.cpp:140-157`).
   * chimp and patas always opt out (`chimp/chimp_analyze.hpp` `ChimpInitAnalyze` "deprecated";
     `patas/patas_analyze.hpp:21-25`).
3. **Scan.** For every vector, each surviving candidate runs `func->analyze(state, vector)`. If it
   returns `false`, the candidate is dropped (lines 194-211).
4. **Score.** `score = func->final_analyze(state)`. `DConstants::INVALID_INDEX` means "unusable". The
   **lowest score wins**, compared with strict `<`, so earlier candidates win ties. A forced method
   wins immediately and the loop breaks (lines 216-254).
5. If nothing survives, a `FatalException` is thrown (lines 258-261).

Scores computed by the main `final_analyze` functions:

| Function | `final_analyze` score | Source |
|---|---|---|
| Uncompressed fixed | `sizeof(T) * count` | `fixed_size_uncompressed.cpp:36-40` |
| Uncompressed validity | `(count + 7) / 8` | `validity_uncompressed.cpp:196-199` |
| Uncompressed string | `count*4 + total_string_size + overflow_strings*12` | `string_uncompressed.cpp:60-63` |
| RLE | `(sizeof(rle_count_t)=2 + sizeof(T)) * run_count` | `rle.cpp:15`, `115-118` |
| Bitpacking | Estimated `total_size`, or `INVALID_INDEX` if the flush fails | `bitpacking.cpp:379-387` |
| ALP / ALPRD | Size estimated by encoding sampled vectors | `alp/alp_analyze.hpp:153+`, `alprd/alprd_analyze.hpp:123-152` |
| dict_fsst | `total_string_length / 2` | `dict_fsst/analyze.cpp:80-82` |
| zstd | `(total/2 + count*4 + vector_metadata) * penalty`. The penalty is 1, or 1000 if the average length is below `zstd_min_string_length` (default 4096). | `zstd.cpp:191-226`; settings.hpp `ZstdMinStringLength` |
| Roaring | Estimated container space | `roaring/common.cpp:187+` |

### 2.4 Compress phase

* `function->init_compression(checkpoint_data, std::move(analyze_state))` is called once per state.
  The `ColumnDataCheckpointData` gives the compressor access to the `ColumnCheckpointState`. Through
  it, the compressor reaches the `PartialBlockManager` (`column_data_checkpointer.cpp:323-337`).
* A second `ScanSegments` calls `function->compress(state, vector)` for every vector, for the data
  stream and then the validity stream (lines 339-346).
* `compress_finalize` is called for each state in order, data first and validity second
  (lines 348-353).
* `DropSegments()` visits **all old segments' block ids**, including additional blocks, and calls
  `BlockManager::MarkBlockAsModified` on each (lines 273-299; §4.2).

### 2.5 `CompressionFunction` callbacks

`src/include/duckdb/function/compression_function.hpp:208-313` (typedefs at 139-204):

| Phase | Callback | Contract |
|---|---|---|
| Analyze | `init_analyze(ColumnData&, PhysicalType) -> unique_ptr<AnalyzeState>` | `nullptr` opts out |
| | `analyze(AnalyzeState&, const Vector&) -> bool` | Called once per vector. `false` means "cannot use this method". |
| | `final_analyze(AnalyzeState&) -> idx_t` | Score, ideally in bytes. `INVALID_INDEX` means skip. |
| Compress | `init_compression(ColumnDataCheckpointData&, unique_ptr<AnalyzeState>)` | May reuse the analyze state |
| | `compress(CompressionState&, const Vector&)` | Called once per vector |
| | `compress_finalize(CompressionState&)` | Flushes the last segment |
| Scan | `init_prefetch`, `init_scan`, `scan_vector`, `scan_partial`, `select`, `filter`, `fetch_row`, `skip` | Read side |
| Append | `init_segment`, `init_append`, `append`, `finalize_append`, `revert_append` | Uncompressed only. `finalize_append` returns the compacted byte size. |
| State | `serialize_state(ColumnSegment&) -> unique_ptr<ColumnSegmentState>` | Writes to `DataPointer.segment_state` |
| | `deserialize_state(Deserializer&)` | Reads it back |
| | `visit_block_ids(const ColumnSegment&, BlockIdVisitor&)` | Enumerates **extra** blocks. This replaced the old "cleanup state" hook (comment at line 196). |
| Info | `get_segment_info` | Only for `pragma_storage_info` extended info |
| Flag | `validity` (`REQUIRES_VALIDITY` / `NO_VALIDITY_REQUIRED`) | |

`ColumnSegment::VisitBlockIds` always visits `block_id` when it is valid. If the function defines
`visit_block_ids`, that callback is called as well (`column_segment.cpp:310-317`). The
`additional_block_ids` column of `pragma_storage_info` is filled from `visit_block_ids`
(`column_data.cpp:1320-1328`).

**Validity replacement.** dict_fsst sets `validity = NO_VALIDITY_REQUIRED` because it encodes NULLs
itself (`dict_fsst.cpp:283`). When the data function reports this, `ValidityCoveredByBasedata` is
true. The validity function is then swapped for `COMPRESSION_EMPTY` (`column_data_checkpointer.cpp:301-321`).
`EmptyValidityCompression::FinalizeCompress` writes a single segment through
`FlushSegment(..., segment_size = 0)` (`src/include/duckdb/storage/compression/empty_validity.hpp:53-74`).

### 2.6 `ColumnCheckpointState::FlushSegment` and `FlushSegmentInternal`

Every compressor ends a segment by calling one of these:
* `StandardCompressionState::FlushCurrentSegment(stats_writer, segment_size)`
  (`src/include/duckdb/storage/compression/standard_compression_state.hpp:24-33`). It merges the stats
  into the segment and calls `ColumnCheckpointState::FlushSegment(std::move(current_segment),
  std::move(handle), segment_size)` (`standard_compression_state.cpp:31-34`).
* `ColumnCheckpointState::FlushSegmentInternal` directly, as the uncompressed path does
  (`fixed_size_uncompressed.cpp:83-96`).

`FlushSegment` releases the pin first, with `handle.Destroy()`, so that the buffer can be converted
destructively. It then calls `FlushSegmentInternal` (`column_checkpoint_state.cpp:133-136`).

`FlushSegmentInternal(segment, segment_size)` is the **only** place where a checkpointed segment
gets a block location (`column_checkpoint_state.cpp:138-224`):

```
if segment_size > block_size:          InternalException                               (139-142)
if tuple_count == 0:                   return (drop segment)                            (144-147)
segment->SetByteSize(segment_size); global_stats->Merge(segment stats)                  (148-152)
if stats.IsConstant():                 ConvertToPersistent(nullptr, INVALID_BLOCK)      (158-160)
                                       -> block_id = INVALID_BLOCK, offset 0, CONSTANT fn
elif segment_size != 0:                                                                  (161-196)
    lock = partial_block_manager.GetLock()          # one mutex per PartialBlockManager
    allocation = GetBlockAllocation(byte_size)
    if allocation.partial_block:                    # reuse an existing partial block
        assert offset_in_block > 0
        memcpy(target_block + offset_in_block, segment_buffer, segment_size)
        pstate.AddSegmentToTail(result_column, segment, offset_in_block)
    else:                                           # start a new block
        if segment->SegmentSize() != block_size: segment->Resize(block_size)
        allocation.partial_block = CreatePartialBlock(result_column, segment, state, bm)
    RegisterPartialBlock(std::move(allocation))     # may flush (write) a block now
else:                                  # segment_size == 0 (e.g. EMPTY validity)          (197-202)
    SetSegmentType(PERSISTENT); block handle reset; block_id INVALID_BLOCK
DataPointer{stats, block_id, offset_in_block, row_start, tuple_count,
            compression_type, byte_size, serialize_state(segment)}                     (204-219)
result_column.segment_tree.AppendSegment(segment); data_pointers.push_back(...)         (221-223)
```

In `FULL_CHECKPOINT` mode, `block_id` is already final when the `DataPointer` is built, even though
the block has not been written yet (§3.4). `ColumnSegment::Resize` copies a smaller buffer into a new
full-size allocation. It requires `offset == 0` (`column_segment.cpp:199-213`). All compression
outputs are already block-sized (§1.4), so this is a fallback path.

### 2.7 How compressors decide segment boundaries

A segment can never span blocks. The comment in `RowGroup::WriteToDisk` says "Segments cannot span
blocks" (`row_group.cpp:1458-1459`). Every compressor therefore builds its output in a buffer of one
usable block and starts a new segment when the next unit does not fit. The unit depends on the
compressor:

| Compressor | Boundary rule | Unit |
|---|---|---|
| Uncompressed fixed | `FixedSizeAppend` copies `min(count, SegmentSize()/sizeof(T) − segment.count)` rows. A short copy means full. `UncompressedFunctions::Compress` then flushes and creates a new segment (`fixed_size_uncompressed.cpp:113-134`, `260-270`). | Row. A segment holds `262136/sizeof(T)` rows, e.g. 65534 INTEGERs. |
| Uncompressed validity | `max_tuples = SegmentSize()/STANDARD_MASK_SIZE*STANDARD_VECTOR_SIZE` (`validity_uncompressed.cpp:584-607`) | Row, in multiples of 2048 |
| Uncompressed string | The segment is full when the 4-byte offset or the string (or big-string marker) does not fit (`string_uncompressed.hpp:104-149`) | Row |
| RLE | `entry_count == max_rle_count`, where `max_rle_count = AlignValueFloor((block_size − 8)/(sizeof(T)+2))` (`rle.cpp:145-148`, `184-189`) | Run |
| Bitpacking | `FlushAndCreateSegmentIfFull` when `!CanStore(data_bytes, meta_bytes)` (`bitpacking.cpp:504-530`) | Group of `BITPACKING_METADATA_GROUP_SIZE` = 2048 values (`bitpacking.cpp:28`) |
| ALP / ALPRD | `HasEnoughSpace(vector_size)` (`alp/alp_compress.hpp:61-69`, `101-104`) | ALP vector (1024 values) |
| dictionary / dict_fsst / FSST | `HasEnoughSpace` checks a string against the remaining space | Row |
| zstd | `vectors_per_segment` is computed during analyze from vector metadata space (`zstd.cpp:176-185`). A new segment starts after that many vectors (`zstd.cpp:361-364`). | ZSTD vector (2048 strings) |
| Roaring | `CanStore(container)` (`roaring/compress.cpp:217-269`) | Container (2048 bits) |
| Empty validity | Always one segment, 0 bytes | Whole column |

Observed in `j.db`, an INTEGER column forced to uncompressed with 122880 rows:

| col | type | seg | start | count | compression | block_id | block_offset |
|---|---|---:|---:|---:|---|---:|---:|
| a | INTEGER | 0 | 0 | 65534 | Uncompressed | 1 | 0 |
| a | INTEGER | 1 | 65534 | 57346 | Uncompressed | 2 | 0 |

65534 × 4 = 262136 bytes, one full usable block.

### 2.8 Constant segments

* The `CONSTANT` function has no analyze or compress callbacks, only scan and fetch callbacks
  (`src/storage/compression/numeric_constant.cpp:325-339`). It is never chosen by analyze.
* A segment becomes constant at flush time whenever `segment->GetStats().IsConstant()`
  (`column_checkpoint_state.cpp:158-160`).
* `BaseStatistics::IsConstant` is true in two cases (`src/storage/statistics/base_statistics.cpp:134-152`;
  `numeric_stats.cpp:324-326`):
  * for validity: all valid or all NULL.
  * for numeric types: `max <= min`, on supported numeric types.
* A constant segment has `block_id = INVALID_BLOCK` (-1), offset 0, no block handle, and
  `compression_type = CONSTANT`. The value is stored only in the statistics. `pragma_storage_info`
  shows these segments as `block_id = -1`, as in §6.1.

### 2.9 On-block layouts

All offsets below are relative to the segment's `block_offset` inside the usable 262136-byte payload.
In the file, the payload starts after the 8-byte block checksum.

**Uncompressed fixed size** (`fixed_size_uncompressed.cpp:260-275`):

```
+-------------------------------------------+
| T[0] | T[1] | ... | T[count-1] |
+-------------------------------------------+
byte_size = count * sizeof(T)   (FixedSizeFinalizeAppend)
```

**Uncompressed validity** (`validity_uncompressed.cpp:573-611`): a bitmask of `validity_t` words.
* The buffer is initialized to `0xFF`, all valid (`ValidityInitSegment`).
* Only invalid rows clear bits.
* `byte_size = ceil(count/2048) * 256`.

**Constant:** no bytes. `INVALID_BLOCK`.

**RLE** (`rle.cpp:123-209`):

```
+----------+------------------------+-pad-+-----------------------+
| u64 off  | T values[entry_count]  | 0.. | u16 counts[entry_cnt] |
+----------+------------------------+-----+-----------------------+
 ^ 0        ^ 8                      ^ minimal  ^ off = AlignValue(8 + sizeof(T)*entry_count)
```

* During compression, counts live at `8 + max_rle_count*sizeof(T)`.
* `FlushSegment` moves the counts down to the aligned offset, zero-fills the pad, and stores that
  offset in the first 8 bytes.
* `byte_size = aligned_offset + 2*entry_count`.

**Bitpacking** (`bitpacking.cpp:404-556`):

```
+---------+----------------------------------+-pad-+------------------------------+
| u64 hdr | group data (grows up)            | 0.. | group metadata u32 (grows dn) |
+---------+----------------------------------+-----+------------------------------+
 hdr = offset of END of metadata (= metadata_offset + metadata_size)
```

* Each group has a metadata word. `EncodeMeta` packs `mode << 24 | data_offset` into 24+8 bits
  (lines 37-42).
* The modes are `CONSTANT`, `CONSTANT_DELTA`, `FOR`, and `DELTA_FOR`. Their data is, respectively:
  * `[T]`
  * `[T for, T delta]`
  * `[T for, T width, packed]`
  * `[T for, T width, T delta_offset, packed]`

  (lines 412-467).
* While compressing, metadata is written downward from the end of the block.
* `FlushSegment` aligns the data end, zero-fills the pad, `memmove`s the metadata down, and stores
  the end offset in the header (lines 532-556).

**ALP** (`alp/alp_compress.hpp:75-235`):

```
+--------+-------------------------------------------+---pad---+--------------------+
| u32    | per-vector: exp,factor,exc_count,FOR,bw,   |         | u32 vector start   |
| size   | packed values, exceptions, exc positions   |         | offsets (grow dn)  |
+--------+-------------------------------------------+---------+--------------------+
```

* An uncompressed vector stores a sentinel exponent followed by the raw values (lines 175-196).
* At flush, the metadata is compacted next to the data only if used space is less than
  `COMPACT_BLOCK_THRESHOLD = 0.80` (`alp_constants.hpp:48`). Otherwise
  `total_segment_size = block_size`, which means the segment takes a whole block.
* The header word stores `total_segment_size`.

**ALPRD** (`alprd/alprd_compress.hpp:194-239`, `alprd_constants.hpp:43-45`): the header is
`u32 size | u8 right_bw | u8 left_bw | u8 dict_count` followed by the left-part dictionary. The rest
of the layout matches ALP and uses the same 80% compaction rule.

**Uncompressed strings** (`string_uncompressed.cpp:200-319`, `string_uncompressed.hpp:53-195`):

```
during append (segment of SegmentSize bytes):
+------+------+-----------------------------+ . . . free . . . +--------------------------+
|dsize |dend  | i32 offsets[count]          |                  |  string bytes (grow <-)  |
+------+------+-----------------------------+                  +--------------------------+
 0      4      8                                                        dend = SegmentSize
after FinalizeAppend when total < 80% of block (compaction):
+------+------+-----------------------------+--------------------------+
|dsize |dend  | i32 offsets[count]          |  string bytes            |  byte_size = dend
+------+------+-----------------------------+--------------------------+
```

* `offsets[i]` is the cumulative dictionary size after string *i*. The string is found at
  `dend − offsets[i]` and its length is `offsets[i] − offsets[i−1]`.
* A NULL repeats the previous offset.
* Strings of at least `GetStringBlockLimit(block_size) = min(AlignValueFloor(block/4), 4096)` bytes
  (`src/include/duckdb/storage/segment/uncompressed.hpp:53-59`) are **overflow strings**:
  * The dictionary stores a 12-byte big-string marker, `block_id_t block + i32 offset`.
  * The offset entry is **negative** (`string_uncompressed.hpp:140-172`).
* `FinalizeAppend` `memmove`s the dictionary down next to the offsets **only** if
  `total_size < GetCompactionFlushLimit()`. Otherwise it reports the full `SegmentSize()`
  (`string_uncompressed.cpp:219-244`).

**Overflow string blocks** (`src/storage/checkpoint/write_overflow_strings_to_disk.cpp:63-134`).
At checkpoint, `UncompressedCompressState::CreateEmptySegment` installs a `WriteOverflowStringsToDisk`
bound to the checkpoint's `PartialBlockManager` (`fixed_size_uncompressed.cpp:65-81`).

```
overflow block (full block, never shared with segments):
+-----------+----------+-----------+----------+ ... +-------------------+
| u32 len   | bytes    | u32 len   | bytes    |     | next block_id (8) |
+-----------+----------+-----------+----------+ ... +-------------------+
                                       GetStringSpace() = block_size - 8
```

* Block ids come from `partial_block_manager.GetFreeBlockId()`. A string longer than the remaining
  space continues in a new block, and the id of the next block is written into the last 8 bytes
  (`AllocateNewBlock`, lines 118-129).
* Each id is registered in the segment state's `on_disk_blocks` (lines 29-40).
* `Flush` zeroes the unused tail and writes the block **directly** with `block_manager.Write`. It does
  not go through partial-block packing (lines 104-116). `UncompressedCompressState::FlushSegment`
  flushes the writer before the segment itself is placed (lines 83-96).
* `SerializeState` writes `on_disk_blocks` as the `"overflow_blocks"` field. `VisitBlockIds`
  enumerates them (`string_uncompressed.cpp:196-198`, `249-269`).

**Legacy dictionary** (`dictionary/common.hpp:10-16`, `dictionary/compression.cpp:115-170`):

```
| header {dict_size, dict_end, index_buffer_offset, index_buffer_count, bitpacking_width} |
| bitpacked selection buffer | u32 index_buffer[] | dictionary strings (memmoved if <80%) |
```

**Legacy FSST** (`fsst.cpp:325-384`): a header with `dict_size, dict_end, bitpacking_width,
fsst_symbol_table_offset`, followed by bitpacked string lengths, the FSST symbol table, and the
encoded dictionary. It is compacted only below 80%.

**dict_fsst** (`dict_fsst/common.hpp:20-27`, `dict_fsst/compression.cpp:54-135`). Every region
start is 8-byte aligned with `AlignValue`:

```
+-------------------------------+---------------+----------------+----------------+---------------+
| header {dict_size, dict_count,| dictionary    | FSST symbol    | bitpacked      | bitpacked     |
| mode, str_len_width,          | (plain or     | table (only if | string lengths | dict indices  |
| dict_idx_width, symtab_size}  | FSST-encoded) | encoded)       |                | (per row)     |
+-------------------------------+---------------+----------------+----------------+---------------+
byte_size = required_space (exact, always compacted)
```

`DictFSSTMode` is `DICTIONARY`, `DICT_FSST`, or `FSST_ONLY`. dict_fsst handles NULLs, which is why
the validity column becomes `EMPTY` (§2.5).

**ZSTD** (`src/storage/compression/zstd.cpp`). ZSTD is the main example of a segment with
**additional blocks**:

* The segment page, created by `CreateEmptySegment` (lines 538-545), starts with vector metadata.
  `GetVectorMetadataSize`, at lines 56-69, sizes four arrays, each aligned:
  * `page_ids[n]`
  * `page_offsets[n]`
  * `uncompressed_sizes[n]`
  * `compressed_sizes[n]`

  The metadata is followed by string lengths and compressed bytes for as long as they fit.
* When a vector does not fit, `NewPage` calls `FinalizePage`. That function obtains
  `partial_block_manager.GetFreeBlockId()`, registers the id in the segment's `on_disk_blocks`, and
  writes the id of the next page as an 8-byte pointer at the current offset (lines 443-465). Extra
  pages are written with `block_manager.Write` (`FlushPage`, 467-475). They are **never** placed
  through the partial block manager.
* The **segment page itself** goes through `FlushSegment(..., segment_block_size)`, where
  `segment_block_size` is the bytes used on the segment page. It can therefore share a block with
  other segments if it is small (lines 547-591).
* A vector whose `page_id == INVALID_BLOCK` lives on the segment page at `segment_block_offset +
  page_offset` (scan, lines 794-808).
* State and ids are handled by `SerializeState`, `DeserializeState`, and `VisitBlockIds`, which
  reuse `SerializedStringSegmentState` (lines 1043-1063).

**Roaring** (validity and boolean, storage ≥ v1.2.0 / ≥ v1.5.0 for BOOL;
`roaring/common.cpp:170-173`). The layout is documented in `RoaringCompressState::FlushSegment`
(`roaring/compress.cpp:296-338`) as `|x|ddd…||mmm|`:
* `x` is a u64 offset to the metadata.
* `ddd` is container data, aligned to 8.
* `mmm` is serialized container metadata.

**Chimp / Patas.** These are still registered (`compression_config.cpp:24-25`) so that old files
can be read. `CompressionTypeIsAvailable` marks them deprecated (`src/common/enums/compression_type.cpp:34-36`).
Their `init_analyze` returns `nullptr` and their `analyze` throws "deprecated, can no longer be used
to compress data" (`chimp/chimp_analyze.hpp`, `patas/patas_analyze.hpp:21-36`). They are never
written.

### 2.10 Segment state vs. additional blocks

There are two state types:
* **`ColumnSegmentState`** is serialized. It has a `vector<block_id_t> blocks`
  (`data_pointer.hpp:29-49`). The string and ZSTD implementation is `SerializedStringSegmentState`,
  which writes field 1 `"overflow_blocks"` (`string_uncompressed.cpp:189-198`).
* **`CompressedSegmentState`** is runtime only (`compression_function.hpp:86-105`). For strings and
  ZSTD this is `UncompressedStringSegmentState`, which has `on_disk_blocks`, a handle cache, and an
  overflow writer. `init_segment` moves the deserialized `blocks` into `on_disk_blocks`
  (`string_uncompressed.cpp:200-217`, `zstd.cpp:1034-1040`).

**Additional blocks are owned exclusively by one segment.** They are full blocks obtained with
`GetFreeBlockId()` and written directly. They are listed in `additional_block_ids` and are freed
through `VisitBlockIds` → `MarkBlockAsModified` when the segment is dropped or rewritten.

---

## 3. `PartialBlockManager`

### 3.1 Data structures

`src/include/duckdb/storage/partial_block_manager.hpp`:

```cpp
struct UninitializedRegion { idx_t start, end; };                        // :27-30
struct PartialBlockState {                                                // :33-42
    block_id_t block_id;     // INVALID_BLOCK until assigned (see 3.4)
    uint32_t   block_size;   // bytes assignable (= usable block size)
    uint32_t   offset;       // next allocation offset == bytes used so far (8-aligned)
    uint32_t   block_use_count; // number of allocations placed in this block
};
struct PartialBlock {                                                     // :44-74
    PartialBlockState state;
    vector<UninitializedRegion> uninitialized_regions;   // alignment gaps to zero
    BlockManager &block_manager;
    shared_ptr<BlockHandle> block_handle;  // the in-memory buffer receiving all segments
    virtual Flush/Merge/Clear/AddSegmentToTail ...
};
struct PartialBlockAllocation {                                           // :76-85
    BlockManager *block_manager; uint32_t allocation_size;
    PartialBlockState state;               // a COPY of the block's state at allocation time
    unique_ptr<PartialBlock> partial_block;// non-null iff an existing block was reused
};
enum class PartialBlockType { FULL_CHECKPOINT, APPEND_TO_TABLE, IN_MEMORY_CHECKPOINT }; // :87
class PartialBlockManager {                                               // :92-163
    multimap<idx_t /*free space*/, unique_ptr<PartialBlock>> partially_filled_blocks; // :149
    uint32_t max_partial_block_size, max_use_count;  mutex partial_block_lock; ...
};
```

`PartialBlockForCheckpoint` (`src/include/duckdb/storage/table/column_checkpoint_state.hpp:70-98`)
adds `vector<PartialColumnSegment{ColumnData&, ColumnSegment&, uint32_t offset_in_block}> segments`.
Its constructor registers the first segment at offset 0 (`column_checkpoint_state.cpp:45-49`), and
its `block_handle` is **that first segment's (resized) buffer**.

### 3.2 Construction and the 80% rule

The constructor (`partial_block_manager.cpp:42-54`) uses `max_partial_block_size` when the caller
passes it. Otherwise it uses `block_size / 5 * 4`, described in the code as "a ratio of 20% free and
80% utilization". Both rules below use this value:

* **Admission:** a segment with `segment_size <= max_partial_block_size` (≤ 209708 bytes) may
  **join** an existing partial block (`GetBlockAllocation`, line 67). A larger segment always starts
  a new block.
* **Retention:** after an allocation, the block stays in the map only if
  `new_space_left >= block_size − max_partial_block_size`, that is, at least 52428 bytes (20%) are
  free (`RegisterPartialBlock`, line 141). Otherwise it is **flushed immediately**.

A block is therefore "full enough to write" once its aligned fill exceeds 209708 bytes (80%). A
segment larger than 80% fills its block alone and is written at once.

### 3.3 `GetBlockAllocation(segment_size)`: best fit

`partial_block_manager.cpp:59-79`, `106-118`:

```
allocation.allocation_size = segment_size
if segment_size <= max_partial_block_size
   and (entry = partially_filled_blocks.lower_bound(segment_size)) exists:  # GetPartialBlock
       take entry out of the map                     # removed while being written to
       assert(offset > 0 && ValueIsAligned(offset))   # offsets are always 8-aligned
       partial_block.state.block_use_count += 1
       allocation.state = partial_block.state         # copy: state.offset is where to write
       if FULL_CHECKPOINT: block_manager.IncreaseBlockReferenceCount(block_id)
else:
       AllocateBlock(state):                          # :86-96
           block_id = FULL_CHECKPOINT ? GetFreeBlockIdForCheckpoint() : INVALID_BLOCK
           block_size = usable block size; offset = 0; block_use_count = 1
```

The map key is the remaining free space. `lower_bound(segment_size)` returns the block with the
**smallest free space that still fits**, which is a best-fit policy. Among equal keys it returns the
earliest inserted block.

### 3.4 When block ids are taken from the free list

| Type | Id obtained | Where |
|---|---|---|
| `FULL_CHECKPOINT` | **When the block is created**, i.e. when its first segment arrives. Uses `GetFreeBlockIdForCheckpoint()`. | `AllocateBlock` (`partial_block_manager.cpp:88-90`), `GetFreeBlockId` (98-104) |
| `APPEND_TO_TABLE` | **At flush time.** Uses `GetFreeBlockId()`. | `PartialBlockForCheckpoint::Flush`, `fetch_new_block` (`column_checkpoint_state.cpp:71-74`) |
| `IN_MEMORY_CHECKPOINT` | Never; uses in-memory buffers | `AllocateBlock` sets `INVALID_BLOCK` |

`SingleFileBlockManager::GetFreeBlockIdInternal` takes the **lowest** id in `free_list`, which is a
`set<block_id_t>`. If the free list is empty it uses `max_block++`. Ids from
`GetFreeBlockId()` (`NEWLY_USED_BLOCK`) are also added to `newly_used_blocks`, while checkpoint ids
are not (`single_file_block_manager.cpp:898-925`; `free_list` at `.hpp:208`).

`FULL_CHECKPOINT` needs the eager id because the `DataPointer` is serialized into metadata by
`RowGroup::Checkpoint` **before** `FlushPartialBlocks` writes the data
(`row_group_collection.cpp:1865-1866` vs `2045-2049`). The bytes on disk do not matter until the
database header is written (`SingleFileBlockManager::WriteHeader`, after `handle->Sync()`,
`single_file_block_manager.cpp:1383-1410`).

### 3.5 `RegisterPartialBlock`: alignment, retention, immediate flush

`partial_block_manager.cpp:128-160`:

```
state = allocation.partial_block->state            # the block's live state (not the copy)
if state.block_use_count < max_use_count:
    unaligned = allocation_size + state.offset
    new_size  = AlignValue(unaligned)               # round up to multiple of 8
    if new_size != unaligned: AddUninitializedRegion(unaligned, new_size)
    state.offset = new_size
    if block_size - new_size >= block_size - max_partial_block_size:   # >= 20% free
        partially_filled_blocks.insert({block_size - new_size, partial_block})   # keep
free_space  = state.block_size - state.offset
block_to_free = allocation.partial_block           # non-null iff NOT re-inserted above
if !block_to_free and map.size() > MAX_BLOCK_MAP_SIZE: evict the entry with least free space
if block_to_free: block_to_free->Flush(context, free_space)   # WRITE NOW
```

Consequences:

* **Every segment start inside a shared block is 8-byte aligned.** The bytes between a segment's
  end and the next aligned offset are recorded as an `UninitializedRegion` and zeroed at flush time.
* `max_use_count` defaults to `1<<20`, so in practice there is no limit on the number of segments per
  block. If it is reached, the block is flushed. Existing bean `repos-mgqt` records that in this case
  the newest allocation is not added to `state.offset`, so the tail-zeroing would overwrite it. No
  in-tree caller sets a small limit.
* `MAX_BLOCK_MAP_SIZE = 1<<31`. **The number of partial blocks retained at once is effectively
  unbounded.** Only the 20%-free rule limits it, because any block with at least 52428 free bytes
  stays until the scope ends. Each retained block keeps one full block-sized buffer alive in the
  buffer manager.
* The flush happens inside `FlushSegmentInternal` **while holding the manager's mutex**, so that
  block write is serialized with all other placements that use the same manager.

### 3.6 `Flush`, `FlushInternal`, `Clear`

`PartialBlock::FlushInternal(free_space_left)` (`partial_block_manager.cpp:24-36`) pins the block.
It `memset`s every `uninitialized_region` to 0, then `memset`s the last `free_space_left` bytes to 0
"to ensure that we do not leak any data". Bytes inside a segment, such as internal padding, are the
compressor's responsibility. RLE and bitpacking zero their own pads explicitly (`rle.cpp:201-203`,
`bitpacking.cpp:547-550`).

`PartialBlockForCheckpoint::Flush(context, free_space_left)` (`column_checkpoint_state.cpp:59-94`)
runs these steps:

1. It calls `FlushInternal` to zero the gaps.
2. If `state.block_id == INVALID_BLOCK` (`APPEND_TO_TABLE`), it gets an id now.
3. It calls `segments[0].ConvertToPersistent(context, &block_manager, block_id)`. This **writes the
   whole block, including all tail segments**, and then takes the new persistent handle.
4. For every other segment it calls `MarkAsPersistent(block_handle, offset_in_block)`. When the id
   was fetched in step 2, it also calls `IncreaseBlockReferenceCount(block_id)` for each of them.
5. It calls `Clear()`.

`Clear()` drops the uninitialized regions, the handle, and the segment list (`:127-131`).
`IsFlushed()` returns `segments.empty()`.

### 3.7 `FlushPartialBlocks`, `ClearBlocks`, `Rollback`

* `FlushPartialBlocks()` calls `Flush(context, free_space)` on every map entry in ascending free-space
  order, then clears the map (`partial_block_manager.cpp:197-202`).
* `ClearBlocks()` calls `Clear()` on each block **without writing** (`:190-195`). `Rollback()` is
  `ClearBlocks()` (`:212-214`). Block ids already assigned in `FULL_CHECKPOINT` mode are not returned
  here. Rollback is only used for `APPEND_TO_TABLE`, where ids are assigned only at flush, so no ids
  have been taken (§5.3).

### 3.8 `Merge(other)`

`partial_block_manager.cpp:162-188` merges another manager's retained blocks into this one. For
each block in `other`, in ascending free-space order:

```
used = block_size - free_space(other block)
if HasBlockAllocation(used):         # used <= 80% and some block here has >= used free
    allocation = GetBlockAllocation(used)               # best fit target
    target.Merge(other_block, allocation.state.offset, used)
        # PartialBlockForCheckpoint::Merge (column_checkpoint_state.cpp:96-121):
        # memcpy(target+offset, other, used); shift other's uninitialized regions by offset;
        # AddSegmentToTail for each of other's segments at (offset_in_block + offset); other.Clear()
    allocation.state.offset += used       # (dead store: RegisterPartialBlock uses the block's state)
    RegisterPartialBlock(allocation)      # re-aligns, re-inserts or flushes
else:
    move the block into this->partially_filled_blocks unchanged
other.partially_filled_blocks.clear()
```

Only `OptimisticDataWriter` calls `Merge` (§5.3), which uses `APPEND_TO_TABLE` managers. That mode
has no ids or reference counts yet, so copying bytes and segment lists is enough.
`InMemoryPartialBlock::Merge` only clears the other block (`in_memory_checkpoint.cpp:139-142`).

### 3.9 Scope: what can share a block

| Scope | Shares one manager? | Evidence |
|---|---|---|
| Segments of the same column in a row group | yes | Same `ColumnCheckpointState::partial_block_manager` |
| Data and validity of one column | yes | Both states are created with the same manager (`standard_column_data.cpp:287-291`) |
| Different columns of a row group | yes | `RowGroupWriteInfo` returns `manager` unless per-column managers are set (`row_group.cpp:1404-1409`) |
| Different row groups of a table (checkpoint) | yes | Every `SingleFileRowGroupWriter` gets `checkpoint_manager.partial_block_manager` (`table_data_writer.cpp:70-73`) |
| **Different tables** | **no** | `RowGroupCollection::Checkpoint` calls `writer.FlushPartialBlocks()` at the end of each table (`row_group_collection.cpp:2045-2049` → `table_data_writer.cpp:92-94`). Tables are written sequentially (`checkpoint_manager.cpp:431-434`, `691-710`). |
| Different checkpoints | **no** | The manager belongs to one `SingleFileCheckpointWriter` (`checkpoint_manager.cpp:91-95`). The manager does not know the free space left inside blocks written by earlier checkpoints. |
| Index (ART) buffers | separate manager | `ART::WritePartialBlocks` creates its own `FULL_CHECKPOINT` manager and flushes it (`src/execution/index/art/art.cpp:1088-1097`) |
| Overflow and ZSTD extra pages | never shared | Written directly (§2.9) |

Placement boundaries:
* A partial block is **flushed when it becomes ≥80% full**, or when it is created with a segment
  larger than 80%. This happens during compression of that segment.
* All remaining partial blocks are flushed **at the end of each table's data**, before the new row
  group tree is installed. The comment says "flushing partial blocks updates where data lives … this
  HAS to happen before we call SetRowGroups" (`row_group_collection.cpp:2045-2049`).
* An unchanged table returns early from `RowGroupCollection::Checkpoint` (lines 1759-1793) before
  this flush. It has written nothing, so there is nothing to flush.

### 3.10 `IN_MEMORY_CHECKPOINT`

`InMemoryCheckpointer` creates an `IN_MEMORY_CHECKPOINT` manager (`in_memory_checkpoint.cpp:17-22`).
It runs when compression is enabled for an in-memory database:
* `CreatePartialBlock` returns an `InMemoryPartialBlock` (`partial_block_manager.cpp:120-126`).
* Its `AddSegmentToTail` immediately calls `segment.SetBlock(block_handle, offset)`. The segment then
  points into the shared in-memory buffer and is marked `PERSISTENT`, with no on-disk id.
* `Flush` only calls `Clear()` (`in_memory_checkpoint.cpp:126-151`).
* Reference counts are not touched, because `IncreaseBlockReferenceCount` is gated on
  `FULL_CHECKPOINT` (`partial_block_manager.cpp:71-73`).
* `InMemoryCheckpointer::WriteTable` flushes after each table "BEFORE releasing the table lock"
  (`in_memory_checkpoint.cpp:63-72`).
* ZSTD opts out in memory (`zstd.cpp:144-147`).

### 3.11 Diagram: one block holding several segments

The following diagram is based on the observed experiment in §6.2. Block 2 holds column `x3` of
table `u` and column `s` of the same table and row group:

```
file offset 12288 + 2*262144 = 536576
+--------+------------------------------------------------------------------------------------+
|checksum| usable payload: 262136 bytes                                                       |
| 8 B    |                                                                                    |
+--------+-------------------------------+--+-----------------------+--+----------------------+
         | x3 INTEGER uncompressed       |pd| s SMALLINT uncompressed|pd| zero-filled free     |
         | 30001*4 = 120004 bytes        |4 | 30001*2 = 60002 bytes  |6 | space (82120 bytes)  |
         +-------------------------------+--+-----------------------+--+----------------------+
         ^offset 0                        ^120008                     ^180016                 ^262136
           DataPointer(x3).offset = 0      DataPointer(s).offset = 120008
           pd = UninitializedRegion -> memset 0     free tail -> memset 0 (FlushInternal)
           multi_use_blocks[2] = 2  (two segments reference block 2)
```

---

## 4. Blocks shared by multiple segments: reference counts and reuse

### 4.1 Multi-use reference counting

`SingleFileBlockManager` keeps four sets (`single_file_block_manager.hpp:208-218`):
* `free_list`, of type `set`
* `newly_used_blocks`, of type `set`
* `multi_use_blocks`, of type `unordered_map<block_id, uint32_t>`
* `modified_blocks`, of type `unordered_set`

A block used by one segment has **no entry** in `multi_use_blocks`, which stands for an implicit
count of 1. `IncreaseBlockReferenceCountInternal` sets the first increment to 2 and later increments
add one (`single_file_block_manager.cpp:1001-1011`, `1103-1106`). The increments happen here:

* `FULL_CHECKPOINT`: once for every segment after the first, in `GetBlockAllocation`
  (`partial_block_manager.cpp:71-73`).
* `APPEND_TO_TABLE`: once for every segment after the first, in `PartialBlockForCheckpoint::Flush`
  (`column_checkpoint_state.cpp:87-90`).
* On load, `MarkBlockAsUsed` increments when a block id is already in use
  (`single_file_block_manager.cpp:942-962`). That path is used by WAL replay
  (`wal_replay.cpp:1319`).

`multi_use_blocks` is **persisted** in the free-list metadata at every checkpoint:
* `WriteHeader` writes the free blocks, then `(block_id, count)` pairs
  (`single_file_block_manager.cpp:1337-1362`).
* `LoadFreeList` reads them back (`:870-892`).

### 4.2 Dropping one user of a shared block

`MarkBlockAsModified(block_id)` (`single_file_block_manager.cpp:964-999`) behaves as follows:

```
if block in multi_use_blocks:
    --count; if count <= 1: erase entry      # still used by remaining segment(s)
    return                                     # NOT freed
if block in newly_used_blocks:                 # written since last checkpoint, never in a header
    erase; AddFreeBlock                        # immediately reusable
else:
    modified_blocks.insert(block)              # freed only after the next header is written
```

After the header is written and synced, `WriteHeader` moves `modified_blocks` into the free list
(`:1411-1420`). Callers include:
* the checkpoint `DropSegments` path (`column_data_checkpointer.cpp:273-299`),
* table and row-group drops through `CommitDropState::FinalizeCommit` (`src/transaction/commit_state.cpp:46-60`),
* metadata and index buffers.

When a column that shares a block is rewritten, the block **stays allocated** until its last segment
is dropped. Then it waits **one more checkpoint**, until the new header no longer references it,
before its id can be reused. The new data for the rewritten column always goes to fresh blocks,
because the manager never appends into blocks from earlier checkpoints (§3.9). See the experiment
in §6.3.

`MarkBlockAsCheckpointed` removes a block from `newly_used_blocks` (`:936-940`). An optimistically
written block that survives a checkpoint therefore becomes a "used in storage" block.

### 4.3 When a column is reused vs. rewritten

The decision is made at three levels:

1. **Table level.** `RowGroupCollection::Checkpoint` checks whether every row group's `write_action`
   is `REUSE_EXISTING_ROW_GROUP_METADATA` and no row group was dropped. If so, it calls
   `writer.WriteUnchangedTable(...)` and returns. The table metadata pointer is reused and no column
   or partial-block work is done (`row_group_collection.cpp:1759-1793`). This requires
   `experimental_metadata_reuse`, which defaults to true (`src/common/settings.json:802`).
2. **Row group level.** `RowGroup::WriteToDisk(RowGroupWriter&)` (`row_group.cpp:1597-1711`):
   * If `CanReuseMetadata` holds (metadata reuse is on, `column_pointers` exist, and no legacy
     start-row rewrite is needed; `:1568-1583`) **and** `!HasChanges()` (`:1887-1907`: no flag, no
     unserialized deletes, no column changes), the row group is
     `REUSE_EXISTING_ROW_GROUP_METADATA`.
   * Otherwise, with per-column metadata support, unchanged or unloaded columns are reused by
     `column_pointers` and only changed columns are checkpointed (`PARTIALLY_REUSE_COLUMN_METADATA`,
     lines 1632-1697).
   * Otherwise the row group is `FULLY_CHECKPOINT_ROW_GROUP`.
3. **Column level.** `ColumnDataCheckpointer::Checkpoint` sets `has_changes` if any state's
   `ColumnData::HasChanges()` is true. That function (`column_data.cpp:105-120`) is true if **any
   segment is transient** or **any segment's row range has updates** (`HasChanges(start,end)` →
   `updates->HasUpdates`). Without changes, the old segments are kept and
   `WritePersistentSegments` emits `segment.GetDataPointer(row)` for each one: same `block_id`, same
   `offset`, same `byte_size`. Only metadata is rewritten (`column_data_checkpointer.cpp:363-398`,
   `437-448`).

Data is rewritten only by:
* new data (transient segments from appends),
* updates,
* vacuum (row-group merges through `VacuumTask`, `row_group_collection.cpp:1295+`),
* storage changes such as `ALTER TYPE` that create new column data.

A rewrite always covers the **whole (column, row group)**: all of its segments are re-analyzed and
recompressed. Deletes are serialized separately with `CheckpointDeletes` and do **not** rewrite
column data, as §6.3 shows.

---

## 5. Single-threaded vs. multi-threaded writes

### 5.1 Parallel checkpoint of a table

* `RowGroupCollection::Checkpoint` schedules one `CheckpointTask` per row group on a `TaskExecutor`
  and calls `WorkOnTasks()` (`row_group_collection.cpp:1704-1755`; task at 1142-1161; executor from
  `TableDataWriter::CreateTaskExecutor`, `table_data_writer.cpp:53-58`).
* Each task calls `row_group.WriteToDisk(*writer)`. Every writer refers to the **single shared**
  `SingleFileCheckpointWriter::partial_block_manager` (`table_data_writer.cpp:70-73`). There are
  **no per-task partial block managers** on the checkpoint path.
* Analyze and compress run fully in parallel. Placement is serialized by the manager's mutex, which
  is taken in `FlushSegmentInternal` (`column_checkpoint_state.cpp:157-166`).
* A segment's block can be written to disk by **another thread**, the one whose placement filled the
  block. `StandardColumnData::Checkpoint` handles this by checkpointing the main column before
  validity (comment at `standard_column_data.cpp:282-286`).
* The row group pointers are then serialized in row group order (`row_group_collection.cpp:1807-1880`),
  and the table's partial blocks are flushed (2049).

### 5.2 Order within one thread

`RowGroup::WriteToDisk(RowGroupWriter&)` processes columns in order inside a row group. Within a
column, data and validity are compressed together. Segments are flushed in fill order, and the final
flush is data first, then validity (§2.4). With `threads=1`, tasks run in schedule order (row
group 0, 1, …). **The layout is a deterministic function of the input data and the starting free
list.** §6.5 shows that the layout is exactly reproducible across runs.

### 5.3 Optimistic writes (`OptimisticDataWriter`)

Large inserts write row groups to disk **before commit** (`src/storage/optimistic_data_writer.cpp`):

* `PrepareWrite` checks three things:
  * `enable_optimistic_write` is on (default true, `settings.json:737-741`),
  * the table is not temporary, the storage is not in memory, and the database is not read-only,
  * an `APPEND_TO_TABLE` `PartialBlockManager` `partial_manager` exists, and is created if not
    (lines 34-50).
* `CreateCollection` builds a transaction-local `RowGroupCollection`. In `PER_COLUMN` mode, which is
  the default and is used by `PhysicalInsert` (`physical_insert.cpp:634`) and `PhysicalBatchInsert`
  (`physical_batch_insert.cpp:120`), it also builds **one `APPEND_TO_TABLE` manager per column**
  (lines 52-72). `LocalTableStorage` uses `GLOBAL` mode, which has only the writer's own manager
  (`local_storage.cpp:19-30`).
* `WriteNewRowGroup` decides when to flush (lines 74-116):
  * when `write_buffer_row_group_count` row groups are pending (default 5, `settings.json:1513-1517`),
  * or when pending memory exceeds `write_buffer_row_group_memory_limit`, which defaults to
    `maximum_memory / 5 / (threads+1)`.

  `FlushToDisk` then calls `RowGroup::WriteToDisk(info, row_groups)` with a `RowGroupWriteInfo` that
  routes column *i* to manager *i* (lines 184-199; `row_group.cpp:1398-1409`).
* `RowGroup::WriteToDisk(info, vector<RowGroup>)` writes **column-at-a-time across row groups**
  "in order to co-locate columns across different row groups" (`row_group.cpp:1436-1487`, comment
  1454-1463).
* `WriteUnflushedRowGroups` flushes the remainder. It then **merges** each per-column manager into
  `partial_manager` using `PartialBlockManager::Merge`, through `OptimisticDataWriter::Merge`
  (lines 124-163, 201-211). Small per-column leftovers are packed together this way.
* `FinalFlush` calls `FlushPartialBlocks` on `partial_manager` (lines 217-222). This is when
  `APPEND_TO_TABLE` blocks get ids from `GetFreeBlockId()` (`NEWLY_USED_BLOCK`). The ids follow
  **flush order**, which is ascending free space in the multimap.
* `Rollback` clears the partial blocks without writing them (lines 224-229). Blocks already written
  are dropped through `CommitDropState` (`local_storage.cpp:264-275`). Those blocks are in
  `newly_used_blocks`, so `MarkBlockAsModified` frees them immediately (§4.2).

Parallel insert (`physical_insert.cpp`):
* Each thread has its own `OptimisticDataWriter` and collection (`Sink`, 627-653).
* In `Combine`, a thread with at least one row group of data calls `WriteUnflushedRowGroups`, then
  `FinalFlush`, and merges its writer into the table's transaction-local writer. Smaller leftovers
  are deferred to `Finalize` (655-698).
* In `Finalize`, `MergeCollectionsTask`s compact the leftovers with fresh writers. These are merged
  and flushed in `FinishEvent` (700-754).
* At commit, `LocalStorage::Flush` either merges the row groups directly, keeping their blocks, or
  rolls the written blocks back and re-appends the rows (`local_storage.cpp:559-600`).

At the next checkpoint, these row groups have only persistent, unchanged segments. Their blocks are
**reused as-is** (§4.3) and `MarkBlockAsCheckpointed` makes them permanent. §6.4 shows this.

### 5.4 Determinism of byte layout

| Factor | Effect |
|---|---|
| Parallel checkpoint tasks | The order in which threads take the partial-block mutex decides packing, offsets, and block ids. **Not deterministic** (§6.5). |
| Free-list history | New ids are the lowest free ids (§3.4), so the same data can land in different block ids depending on what was freed earlier. |
| Optimistic writes | Ids are assigned at flush time. The flush order depends on per-thread Combine and Finalize scheduling and on merge order. In this tree no code imposes a deterministic order across threads. The workloads in §6.4 happened to produce identical layouts. |
| Gaps inside blocks | Always zeroed by `FlushInternal`, and the overflow writer zeroes its tail (`write_overflow_strings_to_disk.cpp:107-109`). Gaps never contain stale memory. |
| Segment content | Set by the compressor for a fixed vector order. With `threads=1` and the same starting state, the same input gives the same bytes. |

---

## 6. Empirical validation

All runs use `/Users/sgerrits/.duckdb/cli/latest/duckdb -no-agent -markdown` on new files in
`/tmp/pbm_exp`. Block 0 is the catalog metadata block in checkpoint-only runs:
`pragma_metadata_info()` returned `block_id = 0` for `a.db`.

### 6.1 Several columns and compression types share one block

```sql
SET threads=1;
CREATE TABLE t AS SELECT i::INTEGER AS a, (i*7)::BIGINT AS b, 'str' || (i % 50) AS c,
       (i/3.0)::DOUBLE AS d, 42 AS k FROM range(10000) r(i);
CHECKPOINT;
SELECT row_group_id rg, column_name col, column_path path, segment_id seg, segment_type type, count,
       compression, block_id, block_offset, additional_block_ids
FROM pragma_storage_info('t') ORDER BY block_id NULLS LAST, block_offset;
```

| rg | col | path | seg | type | count | compression | block_id | block_offset | additional_block_ids |
|---:|---|---|---:|---|---:|---|---:|---:|---|
| 0 | a | [0, 0] | 0 | VALIDITY | 10000 | Constant | -1 | 0 | [] |
| 0 | b | [1, 0] | 0 | VALIDITY | 10000 | Constant | -1 | 0 | [] |
| 0 | c | [2, 0] | 0 | VALIDITY | 10000 | Constant | -1 | 0 | [] |
| 0 | d | [3, 0] | 0 | VALIDITY | 10000 | Constant | -1 | 0 | [] |
| 0 | k | [4] | 0 | INTEGER | 10000 | Constant | -1 | 0 | [] |
| 0 | k | [4, 0] | 0 | VALIDITY | 10000 | Constant | -1 | 0 | [] |
| 0 | a | [0] | 0 | INTEGER | 10000 | BitPacking | 1 | 0 | [] |
| 0 | b | [1] | 0 | BIGINT | 10000 | BitPacking | 1 | 72 | [] |
| 0 | c | [2] | 0 | VARCHAR | 10000 | DICT_FSST | 1 | 184 | [] |
| 0 | d | [3] | 0 | DOUBLE | 10000 | ALPRD | 1 | 7976 | [] |

* Constant segments, including the constant column `k` and all-valid validity, have
  `block_id = -1` (§2.8).
* Four different compression types share block 1.
* Every offset is a multiple of 8.
* The validity of `c` would be `EMPTY` if it contained NULLs. That variant was run as well:
  `n(s VARCHAR with NULLs, x BIGINT with NULLs)` showed `s [0,0] Empty Validity -1`,
  `s DICT_FSST 1@0`, `x BitPacking 1@2560`, and `x [1,0] VALIDITY Uncompressed 1@9424`. The validity
  stream shares the block with the data streams.

### 6.2 The 80% rule, 8-byte alignment, best fit, and per-table flush

```sql
SET threads=1; SET force_compression='uncompressed';
CREATE TABLE u AS SELECT i::INTEGER x1, (i+1)::INTEGER x2, (i+2)::INTEGER x3, i::BIGINT big,
       (i % 2)::SMALLINT s FROM range(30001) r(i);
CREATE TABLE v AS SELECT i::INTEGER y FROM range(1000) r(i);
CHECKPOINT;
```

| tbl | col | type | count | compression | block_id | block_offset |
|---|---|---|---:|---|---:|---:|
| u | x1 | INTEGER | 30001 | Uncompressed | 1 | 0 |
| u | x2 | INTEGER | 30001 | Uncompressed | 1 | 120008 |
| u | x3 | INTEGER | 30001 | Uncompressed | 2 | 0 |
| u | s | SMALLINT | 30001 | Uncompressed | 2 | 120008 |
| u | big | BIGINT | 30001 | Uncompressed | 3 | 0 |
| v | y | INTEGER | 1000 | Uncompressed | 4 | 0 |

`pragma_database_size()`: `block_size 262144, total_blocks 5, used_blocks 5, free_blocks 0`.

Step-by-step trace through §3.3–§3.5:

| Segment | bytes | Action | Block state after |
|---|---:|---|---|
| x1 | 120004 | No partial block → `AllocateBlock`, id 1 | offset `AlignValue(120004)=120008`, gap [120004,120008) recorded, free 142128 ≥ 52428 → retained |
| x2 | 120004 | `lower_bound(120004)` → block 1 (free 142128) at offset 120008, ref count of block 1 becomes 2 | offset 240016, free 22120 < 52428 → **flushed immediately** |
| x3 | 120004 | Map empty → new block, id 2 | offset 120008, retained |
| big | 240008 | > 209708 → new block, **id 3**, without trying the map | free 22128 → flushed immediately |
| s | 60002 | Best fit → block 2 at 120008 | offset 180016, free 82120 → retained |
| end of table u | | `FlushPartialBlocks` writes block 2 | |
| v.y | 4000 | New manager scope → new block 4, **not** block 2 | flushed at end of table v |

Block 3 was assigned to `big` before `s` joined block 2. This confirms that `FULL_CHECKPOINT` ids
are assigned when a block is created (§3.4). Table `v` received its own block even though block 2
had 82 KB free, which confirms the per-table flush (§3.9).

Raw bytes of block 1, payload at file offset 12288 + 262144 + 8:

```
$ xxd -s $((12288 + 262144 + 8 + 119996)) -l 24 b2.db
000604c4: 2f75 0000 3075 0000 0000 0000 0100 0000  /u..0u..........
000604d4: 0200 0000 0300 0000                      ........
$ xxd -s $((12288 + 262144 + 8 + 240008)) -l 16 b2.db
0007d990: 3175 0000 0000 0000 0000 0000 0000 0000  1u..............
$ xxd -s $((12288 + 262144 + 8 + 262120)) -l 16 b2.db
00082ff0: 0000 0000 0000 0000 0000 0000 0000 0000  ................
$ xxd -s $((12288 + 262144)) -l 8 b2.db       # 8-byte block checksum
00043000: 9ce3 fad4 7d6b 870e
```

* The bytes at payload offsets 119996–120003 are x1's last two values, 29999 and 30000 (`0x752f`,
  `0x7530`).
* Payload bytes 120004–120007 are the zeroed alignment `UninitializedRegion`.
* x2 starts at 120008 with the values 1, 2, 3.
* x2's last value, 30001 (`0x7531`), is followed by zeros through the end of the block. This is the
  free-space `memset` in `FlushInternal`.

### 6.3 Rewriting one user of a shared block; deletes do not rewrite

The database is `b.db` from §6.2. Each step forces uncompressed storage.

```sql
UPDATE u SET x1 = x1 + 1 WHERE x1 = 5; CHECKPOINT;
```

| col | type | count | block_id | block_offset |
|---|---|---:|---:|---:|
| x2 | INTEGER | 30001 | 1 | 120008 |
| x3 | INTEGER | 30001 | 2 | 0 |
| s | SMALLINT | 30001 | 2 | 120008 |
| big | BIGINT | 30001 | 3 | 0 |
| x1 | INTEGER | 30001 | 5 | 0 |

`total_blocks 6, used_blocks 6, free_blocks 0`.

* Only `x1` was rewritten, and it went to the new block 5.
* `x2`, `x3`, `s`, and `big` kept their exact `DataPointer`s.
* Block 1 is **still used**. `MarkBlockAsModified(1)` lowered its multi-use count from 2 to 1 and did
  not free it (§4.2).

```sql
UPDATE u SET x2 = x2 + 1 WHERE x2 = 5; CHECKPOINT;
```

| col | type | count | block_id | block_offset |
|---|---|---:|---:|---:|
| x3 | INTEGER | 30001 | 2 | 0 |
| s | SMALLINT | 30001 | 2 | 120008 |
| big | BIGINT | 30001 | 3 | 0 |
| x1 | INTEGER | 30001 | 5 | 0 |
| x2 | INTEGER | 30001 | 6 | 0 |

`total_blocks 7, used_blocks 6, free_blocks 1`.

* The last user of block 1 was dropped, so block 1 went to `modified_blocks` and then to the free
  list after the header was written.
* `x2` was **not** placed into block 5, even though block 5 had about 142 KB free. Blocks from
  earlier checkpoints are never refilled.

```sql
CREATE TABLE w AS SELECT i::INTEGER z FROM range(100) r(i); CHECKPOINT;
```

The result is `z 100 rows → block_id 1, offset 0`, with `total_blocks 7, used_blocks 7,
free_blocks 0`. The freed id 1 is the lowest free id and was reused first.

A `DELETE FROM u WHERE x1 = 7; CHECKPOINT;` on the `b2.db` copy left every `block_id` and
`block_offset` unchanged. The segment counts remained 30001 while `count(*)` became 30000. Deletes
are stored as row-group metadata, not as column rewrites.

### 6.4 Optimistic writes: per-column managers merged, blocks reused at checkpoint

```sql
SET threads=1; SET checkpoint_threshold='10GB';
CREATE TABLE o AS SELECT i::BIGINT a, (i % 1000)::INTEGER b FROM range(4 * 122880) r(i);
-- storage_info before and after CHECKPOINT (validity rows omitted)
```

| rg | col | type | count | compression | persistent | block_id | block_offset |
|---:|---|---|---:|---|---|---:|---:|
| 0 | a | BIGINT | 122880 | BitPacking | true | 0 | 0 |
| 1 | a | BIGINT | 122880 | BitPacking | true | 0 | 1208 |
| 2 | a | BIGINT | 122880 | BitPacking | true | 0 | 2416 |
| 3 | a | BIGINT | 122880 | BitPacking | true | 0 | 3624 |
| 0 | b | INTEGER | 122880 | BitPacking | true | 0 | 4832 |
| 1 | b | INTEGER | 122880 | BitPacking | true | 1 | 0 |
| 2 | b | INTEGER | 122880 | BitPacking | true | 2 | 0 |
| 3 | b | INTEGER | 122880 | BitPacking | true | 3 | 0 |

The table after `CHECKPOINT` was **identical**. Reading the result:

* Segments are already `persistent` before any checkpoint, because the data was written
  optimistically.
* Column `a` of all four row groups is packed together, column-at-a-time (§5.3).
* Each `b` segment is about 154 KB, so the four `b` segments went to separate blocks in manager B.
  During `WriteUnflushedRowGroups → Merge`, `b0`'s block, which had the least free space, fit into
  manager A's block 0 at the aligned offset 4832. It was memcpy-merged there (§3.8). The other three
  did not fit and were moved over unchanged.
* The ids 0–3 were assigned at flush time. The metadata went to block 4 (`pragma_metadata_info`).
* The checkpoint reused every `DataPointer` (§4.3).

Parallel variants of the same CTAS were also run: `threads=8`, with and without
`preserve_insertion_order=false`. They gave identical layouts across 2–3 runs each. With this source,
row-group contents were also identical (`stats.min` per row group: 0, 122880, …). Identical runs here
do not show that optimistic writes are deterministic in general (§5.4).

### 6.5 Parallel checkpoint is not layout-deterministic

```sql
SET threads=$N; SET enable_optimistic_write=false; SET checkpoint_threshold='10GB';
CREATE TABLE p AS SELECT i::BIGINT a, (i % 1000)::INTEGER b FROM range(8 * 122880) r(i);
CHECKPOINT;
SELECT string_agg(row_group_id || column_name || ':' || block_id || '@' || block_offset, ' '
                  ORDER BY row_group_id, column_name)
FROM pragma_storage_info('p') WHERE segment_type <> 'VALIDITY';
```

```
threads=1  0a:1@0 0b:1@1208 1a:1@155776 1b:2@0 2a:1@156984 2b:3@0 3a:1@158192 3b:4@0 4a:1@159400 4b:5@0 5a:1@160608 5b:6@0 6a:1@161816 6b:7@0 7a:1@163024 7b:8@0
threads=1  (identical)
threads=8  0a:1@4832 0b:2@0 1a:1@0 1b:4@0 2a:1@1208 2b:5@0 3a:1@6040 3b:6@0 4a:1@3624 4b:1@9664 5a:1@2416 5b:3@0 6a:1@7248 6b:8@0 7a:1@8456 7b:7@0
threads=8  0a:1@0 0b:2@0 1a:1@2416 1b:3@0 2a:1@3624 2b:5@0 3a:1@4832 3b:4@0 4a:1@6040 4b:6@0 5a:1@1208 5b:1@9664 6a:1@7248 6b:8@0 7a:1@8456 7b:7@0
threads=8  0a:1@0 0b:3@0 1a:1@6040 1b:6@0 2a:1@3624 2b:5@0 3a:1@1208 3b:4@0 4a:1@2416 4b:1@9664 5a:1@4832 5b:2@0 6a:1@8456 6b:7@0 7a:1@7248 7b:8@0
```

* **Segments from different row groups share block 1.**
* With `threads=1` the layout is row-group-major (`0a, 0b, 1a, …`) and reproducible.
* With `threads=8` the same data gets a different permutation of offsets and block ids on each run.
  The cause is the shared, mutex-serialized manager (§5.1).

### 6.6 Additional blocks: overflow strings and ZSTD pages

The first run forces uncompressed storage. Every tenth row has a 5000-byte string, which is above
the 4096-byte overflow limit:

| col | type | count | compression | block_id | block_offset | additional_block_ids |
|---|---|---:|---|---:|---:|---|
| id | INTEGER | 200 | Uncompressed | 1 | 0 | [] |
| str | VARCHAR | 200 | Uncompressed | 1 | 800 | [2] |

The string segment shares block 1 with `id`. Its overflow strings live in the exclusively owned block
2, which was assigned during compression, before the segment itself was placed.

The second run forces zstd on 20000 rows of 96-character strings:

| col | type | count | compression | block_id | block_offset | additional_block_ids |
|---|---|---:|---|---:|---:|---|
| id | INTEGER | 20000 | BitPacking | 1 | 0 | [] |
| str | VARCHAR | 20000 | ZSTD | 4 | 0 | [2, 3] |

The ZSTD extra pages 2 and 3 were assigned with `GetFreeBlockId` while compressing. The segment page
was large (>80%), so it got block 4 for itself.

---

## 7. Summary of invariants

1. **A segment never spans blocks.** Its bytes are `[block_offset, block_offset + byte_size)` inside a
   single usable block of 262136 bytes (`FlushSegmentInternal` rejects `segment_size > block_size`).
2. **A segment's start row is kept in the tree node**, as `SegmentNode::row_start`. Since v1.5.0
   storage it is not serialized; it is rebuilt as the running sum of `tuple_count`.
3. **Constant and empty segments have no block**: `block_id = INVALID_BLOCK (-1)`, `offset = 0`.
4. **Every segment offset inside a shared block is a multiple of 8.** Gaps are recorded as
   `UninitializedRegion`s and zeroed, the free tail is zeroed, and nothing stale is written.
5. **A segment joins an existing partial block only if it is ≤ 80% of a block (209708 B). A block
   stays open only while ≥ 20% (52428 B) is free.** It is flushed at once when it crosses that line,
   and otherwise at the end of the table.
6. **Placement uses best fit**: the open block with the least free space that still fits.
7. **Packing scope is one table in one checkpoint.** Within it, data and validity of all columns of
   all row groups may share blocks. Blocks are never shared across tables. Blocks from earlier
   checkpoints are never refilled. Overflow-string and ZSTD extra pages are never shared.
8. **`FULL_CHECKPOINT` ids come from the free list when the block is created**, using the lowest free
   id, so `DataPointer`s are final before the bytes are written. **`APPEND_TO_TABLE` ids are assigned
   at flush time.**
9. **The reference count of a shared block equals its number of segments.** It is stored in
   `multi_use_blocks`, with an implicit count of 1 for a single user, and persisted with the free
   list. A block is freed only when its last segment is dropped. If the block was already in a
   header, it is reused only after the next checkpoint.
10. **Unchanged columns are not rewritten.** "Unchanged" means no transient segments and no updates.
    They keep the same `block_id` and `offset`. A changed (column, row group) is re-analyzed and fully
    recompressed into new blocks. Deletes do not rewrite column data.
11. **One `PartialBlockManager` per checkpoint is shared by all checkpoint threads behind a mutex.**
    Parallelism therefore changes packing and ids but never correctness. Byte layout is reproducible
    only with `threads=1` and an identical starting free list.

## 8. Limitations of this document

* The experiments used CLI build `b32b1368b8`, not `fb38af476a7` (§0). The core placement files are
  identical in both, but the string, bitpacking, RLE, and ZSTD sources differ by validation hardening.
* The ALP, ALPRD, Roaring, legacy FSST, and dictionary layouts are described from source only. They
  were not dumped byte by byte. The scoring of ALP, ALPRD, and Roaring is summarized, not derived.
* No workload was found that makes optimistic-write layouts differ between runs. The claim that they
  are not deterministic rests on source inspection (§5.4).
* A latent issue was found by inspection: `ValidityAppend` ignores `GetBlockOffset()`
  (`validity_uncompressed.cpp:595`). This is safe today only because validity never uses the
  `SuballocationBlock` (§1.3). It is recorded as bean `repos-cd9o`.
