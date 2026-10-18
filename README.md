# DuckDB File Atlas

DuckDB File Atlas reads a local DuckDB database directly in your browser. It traverses the active checkpoint’s catalog, table, row-group, and column metadata, then builds a linked physical block map and logical segment inspector. No metadata sidecar, DuckDB runtime, upload, or server is needed for supported revision-69 checkpoints.

The parser runs in a background worker, reads bounded slices of the file, and verifies each metadata block it traverses. Segment sizes come from the checkpoint’s optional `byte_size` field. Constants that have no physical block occupy zero physical bytes, even when DuckDB records a nonzero codec size.

The overview and **Internal free space** color mode measure gaps and unused tails only in completely mapped data blocks. They show coverage and exclude whole free blocks. Index and string overflow allocations are identified but their internal free bytes remain unmeasured. Missing recorded sizes stay unknown; segment lengths are never estimated from neighboring pointers. Empty and nested columns are handled separately from physical data allocations.

An optional companion exporter remains available as a fallback when the native decoder encounters an unsupported catalog or storage feature:

```sh
bun scripts/inspect.ts --duckdb /path/to/duckdb /path/to/database.duckdb > manifest.json
```

The exporter uses a compatible, read-only DuckDB CLI. Sidecars are matched to the file size, storage version, and SHA-256 of the first 12 KiB. They do not expose exact segment sizes and cannot replace a successfully decoded native map.

## Interface

The light and dark themes share soft inset panels, clear storage metrics, and a dense disk heatmap. Change themes with the sun/moon control; the preference is stored locally. The physical map preserves byte-offset order and supports three cell densities, search dimming, pointer-target highlights, and bounded tooltips. Use the arrow keys to explore the heatmap, then Enter or Space to inspect a block. The sample is an illustrative 80 MiB layout with 320 physical blocks and 582 segments; it is not a real database file.

The heatmap adapts the compact cell and hover treatment from [Bklit's heatmap](https://bklit.com/docs/components/heatmap-chart) to physical block IDs. It does not use calendar dates or add placeholder blocks. The implementation uses the existing React/shadcn stack without a new chart dependency.

## Visualization approach

Use the physical grid as the default map: its positions preserve disk-offset order, while selection expands into a proportional byte strip and a bounded hex inspector. Keep the three 4 KiB headers separate so equal-sized tiles never imply that they occupy as much disk space as a data block. A linked row-group × column matrix answers which logical data owns those blocks; cells retain every segment, including separate validity segments. Mixed-owner stripes expose shared physical blocks. Unknown byte sizes stay unknown, so a color never promises an inferred storage footprint.

The layouts share selection and pointer highlighting. Animated transitions, predicate/zonemap pruning, and compressed vector decoding remain follow-up work.

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
- Native catalog, row-group, persistent column, statistics, and recorded byte-size traversal.
- Browser discovery is capped at 100,000 physical blocks. Metadata decoding is bounded by a 128 MiB cache, 4,096 slots per stream, one million traversal steps, and 64 object levels. Unsupported or incomplete native decoding falls back to physical inspection with an explanation.
- Unknown bytes remain unknown. Free space is reported only when verified from the file's free list.

The exporter rejects nonempty `.wal`, `.wal.checkpoint`, and `.wal.recovery` siblings before and after reading. The browser can inspect only the chosen file and cannot check for sibling WAL files: checkpoint and close a database before opening it.

The reader does not decompress column values or reconstruct every SQL expression, materialized table sample, VARIANT/GEOMETRY layout, or extension-specific storage feature. Unsupported layouts remain explicitly unknown instead of producing fragmentation estimates. Older storage versions, encrypted files, files with unresolved WAL changes, and formats newer than storage version 69 are outside the current supported scope.

See [the storage-format notes](docs/storage-format.md) for the source references and the limits behind these claims.

### Continuous layouts

Physical blocks and logical row groups are shown in one continuous layout, without pagination. Maps up to 50,000 blocks (about 12.2 GiB with default block sizes), or up to 50,000 logical segments, render in full. Larger maps append blocks or complete row groups as you approach the bottom; a “Load more” control also supports keyboard navigation. Searching and selecting blocks reveal the relevant part of the continuous map.
