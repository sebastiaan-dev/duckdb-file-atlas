# Storage format and semantic sidecars

The current source reference is DuckDB commit [`1b4c3e54ba3`](https://github.com/duckdb/duckdb/tree/1b4c3e54ba3), whose generated storage-version table maps `V2_0_0` to numeric version 69 and `latest` to the same value in [`src/storage/storage_info.cpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/storage/storage_info.cpp). The public enum also declares `V2_0_0 = 69` in [`src/include/duckdb/storage/storage_info.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/storage_info.hpp). This project's reader intentionally rejects other values.

## Physical layout

[`src/include/duckdb/storage/storage_info.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/storage_info.hpp) defines a 4 KiB file-header page. [`src/include/duckdb/storage/single_file_block_manager.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/single_file_block_manager.hpp) places data blocks after three header pages, at `FILE_HEADER_SIZE * 3`. The file reader validates checksums on those headers, chooses the newest valid checkpoint, and follows bounded metadata and free-list chains from the active checkpoint.

The semantic manifest's `Segment.offset` is relative to the beginning of its referenced physical block and includes the block's checksum header. `pragma_storage_info.block_offset` is the offset inside the data payload. The exporter adds the block header size from the physical inspection before writing the manifest. `ByteRange.offset` values are absolute file offsets, so the app adds the physical block start when drawing a segment range.

## What `pragma_storage_info` supplies

At this source revision, [`src/function/table/system/pragma_storage_info.cpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/function/table/system/pragma_storage_info.cpp) returns row-group ID, column name and ID, column path, segment ID and type, row start and count, compression, statistics, persistence, primary `block_id` and `block_offset`, and `additional_block_ids`. Its optional `include_segment_info` output requests compression-specific detail. It does not return an exact segment byte length. The exporter omits non-persistent rows and rows with invalid or absent block IDs. It currently maps each segment's primary block pointer; compression-specific `additional_block_ids` such as overflow or dictionary storage are not represented by the `Segment` sidecar contract yet.

The fields are assembled in [`src/storage/table/column_data.cpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/storage/table/column_data.cpp). Persistent segments supply their block ID and `GetBlockOffset()`; transient segments have null block pointers. Additional block IDs are gathered through the compression function's block-ID visitor. The corresponding [`ColumnSegmentInfo`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/table_storage_info.hpp) structure has row and block offsets, but no byte-size field.

Internally, [`src/include/duckdb/storage/data_pointer.hpp`](https://github.com/duckdb/duckdb/blob/1b4c3e54ba3/src/include/duckdb/storage/data_pointer.hpp) defines an optional `DataPointer.byte_size`. That fact alone is not enough to claim exact sizes in this tool: `pragma_storage_info` does not expose it, and compression-specific `segment_info` is a descriptive string rather than a stable size contract. The exporter leaves `byteSize` null. It does not infer a segment length from the next pointer, row count, compression mode, or the end of a block.

## Sidecar validation

The sidecar format is `duckdb-file-layout/v1`. The app checks exact format and storage version, file size, and a SHA-256 fingerprint of the first 12 KiB, which contains the three header pages used by this reader. Each segment must use safe integer IDs, row bounds, block offsets, and optional byte sizes; its block must exist in the physical inspection and its extent must fit both the block and file. Exact extents may not overlap each other or a known physical range. When exact extents are present, they split any underlying unknown range so the visualization does not draw overlapping claims.

The fingerprint is a guard against importing a sidecar for a different database that happens to have the same length. It is not a whole-file content hash: external modifications to data pages that preserve all three headers are not detected by this check. For reliable results, export and inspect the same stable, checkpointed file.

## Roadmap

Logical segment metadata is a layer over physical block discovery. Decoding catalog pages directly could remove the need for a native sidecar process, but it requires versioned catalog serializers, checksums, free-list and metadata-pointer rules, and compatibility handling across storage formats. Decoding exact data extents requires using the serialized `DataPointer.byte_size` safely across validity, overflow, dictionary, and compression-specific auxiliary blocks. Both steps need fixtures from each supported DuckDB release and corruption tests before the browser should claim more than the public SQL interface proves.
