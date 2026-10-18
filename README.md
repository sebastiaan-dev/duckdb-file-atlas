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

The light and dark themes share soft inset panels, clear storage metrics, and a dense disk heatmap. Change themes with the sun/moon control; the preference is stored locally. The physical map preserves byte-offset order and has a **Tile size** slider from 4–24 px, defaulting to compact 8 px squares. Columns adapt to the available width so small tiles reveal the overall file structure rather than stretching to fill a fixed column count. Search dimming, pointer-target highlights, and bounded tooltips remain available. Use the arrow keys to explore the heatmap, then Enter or Space to inspect a block. The sample is an illustrative 80 MiB layout with 320 physical blocks and 582 segments; it is not a real database file.

The heatmap adapts the compact cell and hover treatment from [Bklit's heatmap](https://bklit.com/docs/components/heatmap-chart) to physical block IDs. It does not use calendar dates or add placeholder blocks. The implementation uses the existing React/shadcn stack without a new chart dependency.

## Visualization approach

Use the physical grid as the default map: its positions preserve disk-offset order, while selection expands into a proportional byte strip and a bounded hex inspector. Keep the three 4 KiB headers separate so equal-sized tiles never imply that they occupy as much disk space as a data block. A linked row-group × column matrix answers which logical data owns those blocks; cells retain every segment, including separate validity segments. Mixed-owner stripes expose shared physical blocks. Unknown byte sizes stay unknown, so a color never promises an inferred storage footprint.

The layouts share selection and pointer highlighting. The selected block's byte strip and range-list swatches follow the main physical-map color setting, without a separate selector or legend. Table, column, and compression colors match the map's palettes; space-used and internal-free-space modes use the same measured block ramp. Unused bytes inside allocated blocks and whole reusable free blocks have distinct green fills, while unknown bytes stay hatched in every mode. Colors never infer unrecorded segment sizes. Animated transitions, predicate/zonemap pruning, and compressed vector decoding remain follow-up work.

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

Run the Chromium interaction regressions with:

```sh
bunx playwright install chromium
bun run test:browser
```

These tests also run in CI. They generate local database fixtures and require no DuckDB executable. See [the browser-test notes](tests/browser/README.md) for details.

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

The UI keeps hover local to the grid, shares one block tooltip, and caches logical cell and lookup indices. The inspector appears on selection. The map remains continuous; search and view controls stay available while scrolling. See [the measured SF4 comparison](docs/performance.md).

### Logical colors

The logical map uses its own color modes and remembers its selection independently of the physical map. Each square represents a segment; hatching marks constants without a data block.

- **Compression:** recorded codec.
- **Bytes per row:** recorded segment bytes divided by that segment's row count (child columns use their own value counts). This measures the segment payload, not unassigned auxiliary-block overhead.
- **Relative footprint:** bytes per row divided by the median of known segment rates in the same table and column. The center is 1×; colors saturate at 0.25× and 4×. A zero median maps zero-byte segments to 1× and positive-byte segments above the scale.
- **Value ranges:** select a numeric or date/timestamp column; each square transitions from its zonemap minimum to maximum on a shared column scale. Other columns dim. Numeric bounds and timestamp subsecond differences retain exact precision during normalization. Unsupported, infinite, and missing bounds stay unknown.
- **Null fraction:** exact null counts, or 0%/100% confirmed by checkpoint statistics. Mixed null presence alone never supplies a percentage.

All scales and column medians use the full inspection, so filtering and progressive loading do not shift the baseline. Missing measurements stay gray. Hover or select a segment to read its measurement.

### Free-list tracking

The Free list view follows the active checkpoint's allocator stream. It shows serialized free block IDs grouped into contiguous runs, implicit free blocks beyond the checkpoint extent, per-block 64-slot metadata allocation masks, and shared-block reference counts. The pointer chain retains block and slot IDs; selecting a chain node or free run opens the physical block inspector with allocator provenance.

Whole free blocks are reusable allocations, separate from gaps inside live data blocks and reusable slots inside metadata blocks. A bounded/incomplete free-list scan shows unknown totals. Historical owners and the time a block was freed are not stored by this snapshot. Only very large maps append additional runs and allocator rows while scrolling.

Free-block runs open as a lean, Bklit-inspired horizontal bar chart: continuous rounded bars show run lengths against the full file's largest run, with subtle vertical ticks and one count at each bar end. Rows stay in disk-offset order, but the x axis measures **run length**, not file offsets. Filtering retains the global scale. A quiet color legend distinguishes serialized free-list entries from implicit blocks outside the checkpoint extent; hover or keyboard focus shows the range, block count, byte size, and provenance.

Click a bar or press Enter to explore that run's blocks, then use **Back to run overview** to return. Detail provides Fit and zoom controls: long runs group into power-of-two ranges that expand on click, while individual zoom has one tile per block. Hover shows IDs, sizes, and offsets; arrow keys and Home/End move within a run, and Enter or Space inspects a block or expands a group. Numeric ID search reveals the exact matching block without moving focus out of the search input. SVG patterns keep detail bounded in DOM size even for 100,000-block runs, without a chart dependency. Both views adapt to light/dark themes and narrow screens.
