# Source map and technical boundaries

All implementation links below are pinned to DuckDB
**`fb38af476a7d07408df3e1f943dd2eb3cd426ff0`**. The local checkout was clean when
inspected. The rehearsed CLI reports `v2.1.0-dev84001 … fb38af476a`; the fixture
writer explicitly requests storage **v2.0.0 / 69**. Neither an adjacent checkout
nor an abbreviated version string certifies all binary build inputs. See generated
manifests for the executable fingerprint and actual settings.

These are implementation observations, not promises about every released DuckDB
version. File Atlas's existing [format notes](../docs/storage-format.md) cover its
reader, including older-format differences; some of those notes use an earlier
source pin. Use the links here for the workshop baseline.

## Anatomy and units

- [storage_info.hpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/include/duckdb/storage/storage_info.hpp): defaults, file-header size, storage-version table. Default row group 122,880 rows, execution vector ordinarily 2,048, block allocation 262,144 bytes. Configuration and build context matter.
- [single_file_block_manager.hpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/include/duckdb/storage/single_file_block_manager.hpp): three file-header pages before block-addressed storage.
- [metadata_manager.hpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/include/duckdb/storage/metadata/metadata_manager.hpp): 64 metadata slots per storage block at this revision.
- [column_data.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/table/column_data.cpp): `CreateColumn`, `Verify`, `HasChanges`, `CheckpointScan`, `GetColumnSegmentInfo`. Scalar, validity, list and nested-child distinctions.
- [standard_column_data.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/table/standard_column_data.cpp): base and validity checkpoint states.

The deck's block diagrams are **schematic and not to scale**. No numerical chart
claims to measure their relative byte lengths. Segment output sizes differ from
block capacity and whole-file size.

## Write paths and publication

| Claim | Entry point / source |
|---|---|
| Small local appends and eligible bulk storage take different commit paths | [`LocalStorage::Flush`, `ShouldUseBulkCommit`, `Commit`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/local_storage.cpp) |
| WAL can contain tuple inserts or persistent row-group descriptions/references | [`DataTable::WriteToLog`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/data_table.cpp) |
| Optimistic writes depend on target/settings and thresholds; they can precede commit | [`OptimisticDataWriter::WriteNewRowGroup`, `WriteUnflushedRowGroups`, `FlushToDisk`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/optimistic_data_writer.cpp) |
| Multi-row-group bulk writes loop column first, then row group; metadata can be reused | [`RowGroup::WriteToDisk`, `CanReuseMetadata`, `CheckpointDeletes`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/table/row_group.cpp) |
| Ordinary checkpoints schedule row-group work; deletion vacuum/merging is conditional | [`row_group_collection.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/table/row_group_collection.cpp) |
| Partial-block packing uses aligned allocations and available-space selection | [`PartialBlockManager::GetBlockAllocation`, `RegisterPartialBlock`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/partial_block_manager.cpp) |
| Sync data before publishing alternate header; retired checkpoint blocks have delayed reuse | [`SingleFileBlockManager::WriteHeader`, `MarkBlockAsModified`, `GetFreeBlockId`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/single_file_block_manager.cpp) |
| Checkpoint publication also coordinates with WAL / concurrent commits | [`checkpoint_manager.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/checkpoint_manager.cpp) |

Caveats to preserve when editing slides:

- COPY FROM feeds insertion; CTAS chooses insertion operators. SQL spelling alone
  does not decide whether optimistic writing occurs.
- Small-append/WAL is the ordinary path, not an assertion that every commit writes
  a WAL in temporary, in-memory, recovery, or auto-checkpoint situations.
- Payload reuse and metadata reuse are distinct. Changing a compression preference
  does not itself make an unchanged persistent column require rewriting.
- Partial deletes do not necessarily rewrite every stored value. Conversely,
  eligible vacuum/merging can change stored spans. Concurrent checkpoints do not
  vacuum deletes in this baseline. Indexes do not universally prohibit reclamation:
  supported ART remap/rebuild policies exist here.
- File truncation removes a free suffix; interior free blocks are not equivalent
  to EOF shrinkage. A final free-list snapshot is not a timeline of availability.

## Selection framework and internal codec API

- [column_data_checkpointer.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/table/column_data_checkpointer.cpp): `Checkpoint`, `DetectBestCompressionMethod`, `ScanSegments`, `WriteToDisk`, `FinalizeCheckpoint`.
- [compression_config.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/function/compression_config.cpp): registry, physical-type candidates, special Constant/Empty paths.
- [compression_function.hpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/include/duckdb/function/compression_function.hpp): analyze/compress/scan/partial/fetch/skip callbacks, optional select/filter/prefetch, validity contract, persistent-state serialization and block visitation.
- [column_checkpoint_state.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/table/column_checkpoint_state.cpp): `FlushSegmentInternal`, normal primary-payload block-capacity requirement, constant/empty outputs and partial blocks.
- [column_segment.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/table/column_segment.cpp): `InitializeScan`, `Scan`, `ScanPartial`, `FetchRow`, `Skip`, `VisitBlockIds`, `ConvertToPersistent`.

Decision scope: a physical column stream in a row-group rewrite. Analyze visits
all input at this framework level; candidates can reject input or return invalid
scores. Lowest surviving score wins automatically. A valid forced candidate has
preference, with uncompressed fallback retained. One winner can emit several
segments and internal modes; constant conversion can change the output codec.

A score is size-oriented by contract but may be estimated and penalized. Examples
include trial/sample-based ALP estimates, dictionary/FSST preference factors,
coarse DICT_FSST estimates, and the ZSTD short-average-string penalty. Do not teach
score as exact bytes, measured latency, or final total allocation size.

This is an **internal C++ API**, not documentation for a stable external plugin ABI.

## Codec layouts and readers

| Family | Writer / reader sources | Key workshop distinction |
|---|---|---|
| Constant | [`numeric_constant.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/numeric_constant.cpp) + `ColumnSegment::ConvertToPersistent` | Metadata/statistics can represent the value with no physical payload block |
| RLE | [`rle.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/rle.cpp) | Count-array offset, run values, aligned u16 run lengths; scan/fetch traverse runs |
| BitPacking | [`bitpacking.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/bitpacking.cpp) | Group payloads and reverse mode/offset metadata; Constant, Constant Delta, FOR, Delta FOR |
| Legacy Dictionary | [`dictionary/compression.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/dictionary/compression.cpp) | Bitpacked row IDs, cumulative offsets, string bytes; use actual writer over stale ASCII diagrams |
| Legacy FSST | [`fsst.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/fsst.cpp) | Packed compressed lengths, serialized symbol table, encoded bytes; not necessarily deduplicated values |
| DICT_FSST | [`dict_fsst.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/dict_fsst.cpp), [`dict_fsst/compression.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/dict_fsst/compression.cpp), [`dict_fsst/analyze.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/dict_fsst/analyze.cpp) | Dictionary / Dict-FSST / FSST-only modes; embeds nullness; large values can reject analysis |
| ALP | [`alp/`](https://github.com/duckdb/duckdb/tree/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/include/duckdb/storage/compression/alp) | Integer representation + exact exceptions; 1024-value internal vectors; offsets for access |
| ALPRD | [`alprd/`](https://github.com/duckdb/duckdb/tree/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/include/duckdb/storage/compression/alprd) | Bit-pattern split, high-part dictionary, packed low bits and exceptions |
| ZSTD strings | [`zstd.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/zstd.cpp) | Primary per-vector descriptors; lengths and compressed frames inline or in auxiliary pages |
| Uncompressed strings | [`string_uncompressed.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/string_uncompressed.cpp), [`write_overflow_strings_to_disk.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/checkpoint/write_overflow_strings_to_disk.cpp) | Inline data versus overflow markers/pages; auxiliary ownership visitation |
| Roaring | [`roaring/common.cpp`](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/compression/roaring/common.cpp) | Specialized validity/boolean representation; storage gates differ |

Layout slides omit alignment/field-width details unless labelled explicitly.
Partial scans must satisfy flat-vector requirements in this baseline; full scans
may return constant/dictionary/FSST representations when the path supports them.
FSST vectors are not universally enabled. Fetch capability does not imply constant
or cheap access: ALP/ALPRD decode internal vectors, ZSTD may decode/discard preceding
strings within a target vector, and delta modes require local reconstruction.

### Storage and writing gates

- ZSTD strings and Roaring validity: storage ≥1.2; ZSTD also rejects an in-memory block manager.
- Legacy Dictionary/FSST writers: older targets; DICT_FSST starts at ≥1.3.
- Roaring booleans: ≥1.5.
- ALP/ALPRD: small-block restrictions before 1.5; raw-vector fallback from ≥1.5.
- Chimp/Patas: retained readers, `InitAnalyze` returns null; not new-write candidates.
- PFOR_DELTA: enum placeholder, not a registered implementation.
- Constant/Empty: not ordinary competing analyze candidates.

## Introspection and bytes

- [pragma_storage_info.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/function/table/system/pragma_storage_info.cpp): available output fields and optional codec segment information.
- [serialize_storage.cpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/storage/serialization/serialize_storage.cpp): `DataPointer` field 106, optional `byte_size` in storage format 69.
- [table_storage_info.hpp](https://github.com/duckdb/duckdb/blob/fb38af476a7d07408df3e1f943dd2eb3cd426ff0/src/include/duckdb/storage/table_storage_info.hpp): engine storage-info structures, distinct from all serialized checkpoint fields.

At this baseline the pragma does **not** expose exact segment byte lengths. It
provides row counts, persistence, primary block ID/offset, stats and auxiliary IDs.
Its scalar `start` is row-group-relative here, while Atlas presents table-global
scalar row positions after combining checkpoint metadata. Its `block_offset` is
payload-relative; Atlas's block range includes the block header when converting to
physical offsets. Do not interchange these coordinate systems.

Missing byte sizes in older/retained segments remain unknown. Constant segments
with INVALID_BLOCK have zero physical payload even if a serialized codec-size
field is nonzero. Auxiliary allocation capacity is not measured payload usage.

## Future directions: distinguish existing work from proposals

**Already implemented:** codec-local sampling in FSST/ALP/ALPRD; string overflow;
ZSTD auxiliary pages; codec state serialization and block-ID visitation.

**Proposals relative to this baseline:** framework-level sampled selection that
avoids the full ordered analyze scan; generalized reusable auxiliary allocation for
additional codecs. The slides do not assert a particular feature branch is merged.

Evaluation questions: input-validation completeness, worst-case selection regret,
training-state compatibility, write CPU, scan/fetch cost, read amplification,
memory, allocation ownership, crash-safe publication, and backward compatibility.

## Useful existing sqllogictests for follow-up

These paths were inspected as relevant coverage, **not executed as part of making
the slides**. Workshop fixture E2E checks are separate and documented under demos.

- `test/sql/storage/optimistic_write/optimistic_write_with_regular_writes_wal.test_slow`
- `test/sql/storage/optimistic_write/optimistic_write_update.test`
- `test/sql/storage/metadata/partial_column_metadata_reuse.test`
- `test/sql/storage/partial_delete_checkpoint_mask.test`
- `test/sql/storage/compression/compression_selection.test`
- `test/sql/storage/compression/compression_selection_dict_fsst.test`
- `test/sql/storage/compression/skip_explicit_compression_analyze.test`
- `test/sql/attach/attach_new_compression.test`
- `test/sql/storage/compression/alp/alp_storage_version.test`
- `test/sql/storage/compression/zstd/fetch_row.test`
- `test/sql/storage/compression/zstd/reclaim_space_table.test_slow`

When changing engine behavior, prefer reproducing it in sqllogictest and then add
storage-boundary/reopen tests; do not rely on a slide screenshot as a regression.
