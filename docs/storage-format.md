# Storage format and native inspection

The current source reference is DuckDB commit [`1b4c3e54ba3`](https://github.com/duckdb/duckdb/tree/1b4c3e54ba3), whose generated storage-version table maps `V2_0_0` to numeric version 69 and `latest` to the same value in [`src/storage/storage_info.cpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/storage/storage_info.cpp). The public enum also declares `V2_0_0 = 69` in [`src/include/duckdb/storage/storage_info.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/storage_info.hpp). This project's reader intentionally rejects other values.

## Physical layout

[`src/include/duckdb/storage/storage_info.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/storage_info.hpp) defines a 4 KiB file-header page. [`src/include/duckdb/storage/single_file_block_manager.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/single_file_block_manager.hpp) places data blocks after three header pages, at `FILE_HEADER_SIZE * 3`. The file reader validates checksums on those headers, chooses the newest valid checkpoint, and follows bounded metadata and free-list chains from the active checkpoint.

The semantic manifest's `Segment.offset` is relative to the beginning of its referenced physical block and includes the block's checksum header. `pragma_storage_info.block_offset` is the offset inside the data payload. The exporter adds the block header size from the physical inspection before writing the manifest. `ByteRange.offset` values are absolute file offsets, so the app adds the physical block start when drawing a segment range.

## What `pragma_storage_info` supplies

At this source revision, [`src/function/table/system/pragma_storage_info.cpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/function/table/system/pragma_storage_info.cpp) returns row-group ID, column name and ID, column path, segment ID and type, row start and count, compression, statistics, persistence, primary `block_id` and `block_offset`, and `additional_block_ids`. Its optional `include_segment_info` output requests compression-specific detail. It does not return an exact segment byte length. The exporter omits non-persistent rows and rows with invalid or absent block IDs. It currently maps each segment's primary block pointer; compression-specific `additional_block_ids` such as overflow or dictionary storage are not represented by the `Segment` sidecar contract yet.

The fields are assembled in [`src/storage/table/column_data.cpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/storage/table/column_data.cpp). Persistent segments supply their block ID and `GetBlockOffset()`; transient segments have null block pointers. Additional block IDs are gathered through the compression function's block-ID visitor. The corresponding [`ColumnSegmentInfo`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/table_storage_info.hpp) structure has row and block offsets, but no byte-size field.

Internally, [`src/include/duckdb/storage/data_pointer.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/data_pointer.hpp) defines an optional `DataPointer.byte_size`. The browser reads that field directly; the SQL exporter cannot, because `pragma_storage_info` does not expose it and compression-specific `segment_info` is only a descriptive string. The exporter leaves `byteSize` null. It does not infer a segment length from the next pointer, row count, compression mode, or the end of a block.

## Sidecar validation

The sidecar format is `duckdb-file-layout/v1`. The app checks exact format and storage version, file size, and a SHA-256 fingerprint of the first 12 KiB, which contains the three header pages used by this reader. Each segment must use safe integer IDs, row bounds, block offsets, and optional byte sizes; its block must exist in the physical inspection and its extent must fit both the block and file. Exact extents may not overlap each other or a known physical range. When exact extents are present, they split any underlying unknown range so the visualization does not draw overlapping claims.

The fingerprint is a guard against importing a sidecar for a different database that happens to have the same length. It is not a whole-file content hash: external modifications to data pages that preserve all three headers are not detected by this check. For reliable results, export and inspect the same stable, checkpointed file.

## Native checkpoint traversal (revision 69)

The browser now reads the catalog stream itself, then follows each table pointer to its statistics and row-group list, and each row-group column pointer to its persistent column tree. The binary decoder uses little-endian 16-bit field IDs, signed/unsigned LEB128 integers, nullable flags, list lengths, and object terminators. It never searches arbitrary bytes for a plausible record. Every metadata allocation read is checksummed; pointers, counts, nesting, lengths, and cache sizes are bounded.

Revision 69 adds optional DataPointer field 106, `byte_size`. This is the number of bytes occupied by a segment within its data block. It is distinct from a block's allocation size and from an uncompressed value size. Missing byte sizes stay unknown, including old segments retained in an upgraded file. The reader does not infer a segment's size from the next pointer.

Within a data block, known segment intervals are sorted and checked for overlap. Only completely mapped blocks without unmeasured index/overflow allocations have their uncovered intervals labeled unused. This includes alignment gaps and an unallocated tail; it does not establish which gaps can be reused by a running database. Whole free blocks are shown separately. Aggregate internal free space includes its measurement coverage, so unknown bytes never become savings or fragmentation by subtraction.

Constants can occupy metadata without a data block; these remain inspectable in the logical view. Segment row positions are table-global for scalar and validity streams, using row-group row_start plus the running tuple count. List element streams use their own child positions. String zonemaps can be truncated bounds rather than full values, and checkpoint null flags do not imply an exact mixed null count.

Source references: `src/storage/checkpoint_manager.cpp`, `src/storage/metadata/metadata_reader.cpp`, `src/storage/serialization/serialize_storage.cpp` (DataPointer field 106), `src/storage/table/row_group.cpp`, `src/storage/table/column_data.cpp`, `src/storage/table/column_segment.cpp`, `src/storage/table/column_checkpoint_state.cpp`, and `src/storage/partial_block_manager.cpp` in the supplied DuckDB checkout.

`byte_size` needs one further distinction: for a constant segment with `INVALID_BLOCK`, DuckDB can serialize a nonzero in-memory codec size even though the checkpoint never allocated physical bytes. The reader retains that as `storedByteSize` and reports a physical size of zero. It accepts this sentinel only for known zero-payload compression modes. Regular allocated segment sizes continue to use the recorded byte length.

## Index allocator inspection

The allocator/deletion implementation was cross-checked against the local DuckDB source at `fb38af476a7d07408df3e1f943dd2eb3cd426ff0` and real files generated by CLI `v2.0.0-alpha44357`. These are not assumed to have identical raw node ABIs: for example, observed NODE256_LEAF slot sizes differ. The inspector reads the recorded `segment_size` and gates recognized per-index storage versions and allocator layouts; it does not reinterpret raw node structs.

`IndexStorageInfo` and `FixedSizeAllocatorInfo` are serialized in `src/storage/serialization/serialize_storage.cpp`. Buffer IDs, physical block pointers, segment counts, and allocation sizes are parallel arrays, not sorted or contiguous identifiers. A persisted buffer starts at the payload-relative block offset, contains a free-slot mask followed by fixed-size slots, and ends at its occupied high-water slot. A set mask bit means **free**. Geometry follows `src/execution/index/fixed_size_allocator.cpp`; every inspected index block is checksummed, and slot counts, envelope bounds, array consistency, root allocation, and cross-buffer overlaps are validated.

Free stored-slot bytes exclude logical capacity outside the persisted envelope. Alignment gaps/tails within a fully mapped physical index block are measured separately. Unsupported legacy roots/layouts remain named incomplete inspections. Work and range budgets prevent unbounded slot materialization.

## Metadata provenance and checkpoint deletes

Metadata reads retain absolute positions for payload chunks. Successful coarse parser spans are split across those chunks and refine allocated metadata or verified unknown ranges only; checksums, free slots and geometric tails cannot be overlaid. Exact repeated observations deduplicate, conflicting/shared observations retain shared provenance, and unconsumed allocated bytes never become unused merely because they are zero-filled.

Persistent delete streams (`row_version_manager.cpp`, `chunk_info.cpp`, and `validity_mask.cpp`) use fixed-width ReadStream fields, not field-ID/LEB128 objects. Only the first deletion pointer is a stream root; remaining pointers enumerate the same stream's allocations. Constant records delete an entire existing vector; vector masks use bitmask, deleted-position, or alive-position encodings. Set/valid bits mean **deleted**. Full-vector mask validation precedes clipping to a partial final vector. Decoder budgets bound vectors, work, and coalesced deletion ranges.

Native summaries retain stored physical row counts and separately derive live/deleted counts for the active checkpoint. They do not reconstruct transaction history, replay WAL, or turn tombstones into estimated reclaimable storage.
