# DuckDB File Atlas

DuckDB File Atlas links the physical checkpoint layout of a DuckDB database to table and column storage metadata. The browser reader verifies the three header pages and maps metadata, free-list, and unknown blocks. A semantic sidecar can add table, column, row-group, compression, and row-range information to verified data blocks.

The app reads a local file in the browser. To create semantic metadata, run the companion exporter with a DuckDB CLI built from source that supports storage version 69:

```sh
bun scripts/inspect.ts --duckdb /path/to/duckdb /path/to/database.duckdb > manifest.json
```

The exporter checks the file header first, requires storage version 69 (`v2.0.0`), then runs the catalog and `pragma_storage_info` queries with the DuckDB CLI in JSON and read-only mode. It writes only the manifest to stdout and sends errors to stderr. The app accepts the sidecar only when its format, storage version, exact file size, and SHA-256 fingerprint of the first 12 KiB match the inspected file. The fingerprint covers the three DuckDB header pages; it is not a digest of all database contents.

DuckDB's public `pragma_storage_info` does not report a segment's exact byte length. The exporter therefore records `byteSize: null`, and the visualization marks the data block without drawing a guessed segment extent. It includes the payload-relative `block_offset` adjusted to a physical block-relative offset, the 8-byte checksum header included. Non-persistent rows and rows with invalid or absent block pointers are omitted. Exact per-segment ranges can be shown only when a future trusted source supplies a bounded byte size.

## Interface

The light and dark themes share soft inset panels, clear storage metrics, and a dense disk heatmap. Change themes with the sun/moon control; the preference is stored locally. The physical map preserves byte-offset order and supports three cell densities, search dimming, pointer-target highlights, and bounded tooltips. Use the arrow keys to explore the heatmap, then Enter or Space to inspect a block. The sample is an illustrative 80 MiB layout with 320 physical blocks and 582 segments; it is not a real database file.

The heatmap adapts the compact cell and hover treatment from [Bklit's heatmap](https://bklit.com/docs/components/heatmap-chart) to physical block IDs. It does not use calendar dates or add placeholder blocks. The implementation uses the existing React/shadcn stack without a new chart dependency.

## Visualization approach

Use the physical grid as the default map: its positions preserve disk-offset order, while selection expands into a proportional byte strip and a bounded hex inspector. Keep the three 4 KiB headers separate so equal-sized tiles never imply that they occupy as much disk space as a data block. A linked row-group × column matrix answers which logical data owns those blocks; cells retain every segment, including separate validity segments. Mixed-owner stripes expose shared physical blocks. Unknown byte sizes stay unknown, so a color never promises an inferred storage footprint.

This first iteration uses linked selection between layouts. Animated physical-to-logical transitions, predicate/zonemap pruning, exact compressed vector layouts, and browser-native catalog deserialization remain follow-up work.

## Run it

```sh
bun install
bun run dev
```

The dev server prints a local URL. Open it, then choose a real `.duckdb` file. A demo inspection is available before you select a file.

## Check and build

```sh
bun test
bun run build
```

The semantic tests validate manifest shape, file matching, block pointers, physical bounds, exact range handling, and reapplication. The optional native integration test runs when `DUCKDB_BIN` points to a compatible DuckDB executable.

## Make a demo database

Use the same source-built DuckDB executable that supports storage version 69:

```sh
/path/to/duckdb demo.duckdb < docs/demo.sql
bun scripts/inspect.ts --duckdb /path/to/duckdb demo.duckdb > demo.manifest.json
```

If the supplied DuckDB checkout has no executable yet, build its shell outside the source tree (requires CMake, Ninja, and a C++ compiler):

```sh
cmake -S /path/to/duckdb -B .cache/duckdb -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_UNITTESTS=OFF -DBUILD_SHELL=ON \
  -DENABLE_SANITIZER=OFF -DBUILD_EXTENSIONS=core_functions \
  -DSKIP_EXTENSIONS='parquet;json;icu'
cmake --build .cache/duckdb --target duckdb -j 6
```

Then use `.cache/duckdb/duckdb` as the exporter executable. To run the native integration checks:

```sh
DUCKDB_BIN="$PWD/.cache/duckdb/duckdb" bun test
```

The SQL ends with `CHECKPOINT` so the file is self-contained before the read-only export.

## Supported scope

- DuckDB storage version 69 (`v2.0.0`) only.
- Unencrypted, checkpointed, single-file databases.
- Physical header and block metadata plus logical segment metadata returned by DuckDB.
- Browser discovery is capped at 100,000 physical blocks, with bounded metadata-chain scanning; partial scans are labeled.
- Unknown bytes remain unknown. Free space is reported only when verified from the file's free list.

The exporter rejects nonempty `.wal`, `.wal.checkpoint`, and `.wal.recovery` siblings before and after reading. The browser can inspect only the chosen file and cannot check for sibling WAL files: checkpoint and close a database before opening it.

The reader does not decode DuckDB catalog pages or compressed column bytes. The sidecar does not expose or reconstruct user values. Older storage versions, encrypted files, files with unresolved WAL changes, and formats newer than storage version 69 are outside the current supported scope.

See [the storage-format notes](docs/storage-format.md) for the source references and the limits behind these claims.

### Continuous layouts

Physical blocks and logical row groups are shown in one continuous layout, without pagination. Maps up to 50,000 blocks (about 12.2 GiB with default block sizes), or up to 50,000 logical segments, render in full. Larger maps append blocks or complete row groups as you approach the bottom; a “Load more” control also supports keyboard navigation. Searching and selecting blocks reveal the relevant part of the continuous map.
