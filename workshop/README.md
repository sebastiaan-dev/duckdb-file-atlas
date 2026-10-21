# Inside a DuckDB file — compression workshop

A **90-minute developer workshop** with a 60-minute route. The initial complete
deck has **39 teaching slides + 6 chapter dividers + 4 appendix slides**, per-slide
speaker notes, schematic file/segment diagrams, and real CLI exercises. It focuses on explaining storage
rather than benchmarking compression speed. Tune depth and timing after rehearsal.

## Present the slides

From the repository root:

```sh
bun install
bun run workshop:dev
```

Open **http://127.0.0.1:5184/**. This is a separate Vite entry point; it does not
start Atlas, fetch the DuckDB-WASM runtime, or change the app's routing/build.
Reveal.js **5.2.1**, its plugins, and the keynote artwork are local dependencies/assets,
not CDN resources. Typography uses local Suisse Intl / Helvetica / Arial and a
bundled open-source JetBrains Mono code font; no commercial font is downloaded or
redistributed. Once dependencies are installed the deck runs without internet.

The design follows the supplied **`260617_DuckDB-Keynote.pptx`**: white content slides,
black typography, yellow gradient title/chapter slides, an inset white canvas for
architecture diagrams, yellow-headed cards, and a split white/black code slide. See
[artwork provenance and design notes](assets/README.md). The six chapter dividers
are visual pauses, not additional teaching content; timing and existing slide IDs
are unchanged.

- **Space / arrow keys:** advance; **Esc:** overview; **F:** fullscreen. There are
  no on-screen arrows (keynote style); the page number is in the footer.
- **S:** speaker view with notes, next slide, and timer. Allow the popup.
- Hash URLs name slides, e.g. `/#/selection` or `/#/order-lab`.
- Browser zoom / Reveal scaling accommodate smaller screens; a landscape display
  is best for the side-by-side diagrams and tables.
- Source-edit `slides.md`: `---` separates slides, `Notes:` starts presenter-only
  notes, and `<!-- .slide: id="…" -->` supplies a stable navigation target.
- Edit `theme.css` for appearance. No animation or fragment timing is required.

### Build, serve, and print

```sh
bun run workshop:build
bun run workshop:preview
```

The standalone output is **`dist-workshop/`**, not the Atlas `dist/`. Serve it over
HTTP; opening `index.html` directly via `file://` is not supported. The relative
asset base allows hosting this folder under another site's subdirectory. It is
**not automatically included in the existing GitHub Pages deployment**.

For PDF, open `http://127.0.0.1:5184/?print-pdf`, then Chrome's Print → Save as PDF,
landscape, background graphics on, headers/footers off. Reveal supplies the page
geometry. To include notes, add `&showNotes=separate-page`. The printable
facilitator script below is usually easier to consult while rehearsing.

## Workshop material

| File | Purpose |
|---|---|
| [slides.md](slides.md) | Audience deck **and full spoken track in speaker notes** |
| [facilitator.md](facilitator.md) | Timed run of show, demo choreography, transitions, fallback plan |
| [handout.md](handout.md) | Participant worksheet without the answer key |
| [sources.md](sources.md) | Pinned implementation sources, claims, caveats, follow-up tests |
| [demos/README.md](demos/README.md) | Generator, exact SQL, recorded observations, answer key |

## Prepare the hands-on files

Use a CLI capable of creating storage target v2.0.0 / 69:

```sh
python3 workshop/demos/generate.py \
  --duckdb /path/to/duckdb \
  --out .cache/workshop-rehearsal --overflow
```

The destination **must not exist**. This produces nine small snapshots plus SQL,
query logs, version/settings, binary hash, and a provenance manifest. A default
CLI search is available if `--duckdb` is omitted. The optional overflow pair is
used in the 90-minute route; omit `--overflow` for the shorter route.

Start Atlas separately with `bun run dev`, and use the app URL printed by Vite.
Drop files from **`snapshots/`**, never `working/`. Before the session, open each
snapshot in the current Atlas build and check that the relevant logical/physical
views decode. Fixture generation tests SQL/persistence; it does not certify every
Atlas parser path. The slide deck deliberately has no hard-coded Atlas deployment
URL or dependency on a particular open database.

Distribute the snapshot folder and [handout.md](handout.md) ahead of time. Attendees
need a browser for the core exercises; CLI access is optional if using the supplied
query logs. No attendee needs to compile DuckDB or download extensions.

## Baseline and reproducibility

Implementation source: DuckDB
[`fb38af476a7d07408df3e1f943dd2eb3cd426ff0`](https://github.com/duckdb/duckdb/tree/fb38af476a7d07408df3e1f943dd2eb3cd426ff0).
The rehearsed local CLI reports `v2.1.0-dev84001 … fb38af476a`; the writer explicitly
requests **storage target v2.0.0**, one thread and fixed settings. Source pin,
reported binary version, and storage target are distinct facts. The generator
records them separately; an adjacent source checkout is not a build certificate.

Examples and observed codec choices are **not cross-version promises**. Older
1.x-target files differ in available writers and recorded metadata. The deck does
not claim that checkpoint always recompresses, that physical order is guaranteed,
that all deleted rows are reclaimed, or that auxiliary block capacity equals
measured payload. Future-direction slides explicitly distinguish proposals from
existing codec-local sampling and string auxiliary storage.

## Checks

```sh
bun run workshop:build
bun run workshop:test
PYTHONDONTWRITEBYTECODE=1 python3 workshop/demos/test_e2e.py \
  --duckdb /path/to/duckdb
```

Browser tests serve the **built** deck on port 5184 and check slide/notes parsing,
local-only assets, keyboard/deep-link navigation, speaker popup, print layout,
and content bounds at desktop and laptop sizes. Install Chromium first if needed:
`bunx playwright install chromium`.

No engine build, performance benchmark, PDF export, or publishing step is implicit
in these commands.
