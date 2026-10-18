# UI performance check

Measured with the same decoded TPC-H SF4 fixture: 4,279 blocks, 294 row groups, and 10,298 segments (including constants). Both builds ran in the same local in-app browser, at the same viewport, using a development React Profiler wrapper without Strict Mode. No rows were removed or paginated.

| Interaction | Before median | After median | Samples per build |
| --- | ---: | ---: | ---: |
| Physical grid: ArrowRight | 406.6 ms | 10.0 ms | 10 |
| Logical matrix: Tab | 298.8 ms | 4.5 ms | 8 |

The timing starts in the capturing key handler and ends in the next animation-frame callback. It describes these local interactions, rather than a guarantee for other hardware or a production benchmark. The profiler reports zero React commits for logical focus movement after the change. Samples are saved in [performance.json](performance.json). Pointer hover uses the same local grid update path as keyboard focus.

## Changes

- A single shared tooltip replaces one Radix tooltip tree per physical cell. Hover and focus stay inside the grid.
- Memoized cells update when their own selection, focus, links, or search state changes. Colors and labels are calculated when the file or color mode changes.
- Logical hover/focus uses CSS. Indexed cells and cached row models retain every segment, including shared blocks and metadata-only constants. Selection rerenders affected rows.
- Block and segment lookups, overview summaries, and search strings are indexed once per inspection. Search rendering is deferred so input can update promptly.
- Large-file incremental rendering retains the existing 50,000-block/segment thresholds. Appending groups reuses the earlier row models.

## Interaction checks

Checked physical-to-logical selection, exact byte ranges, pointer links, search, Escape dismissal, roving keyboard focus, and selection visibility after the inspector changes the grid width. The interface has no outer frame, empty inspector, repeated navigation, or privacy slogans. A narrow viewport and both color themes retain the file metrics and controls.
