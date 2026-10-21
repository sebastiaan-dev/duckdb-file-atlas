# Keynote artwork provenance

These eight PNGs were extracted unchanged from the user-supplied
`260617_DuckDB-Keynote.pptx` to restyle this workshop according to that reference.
The original presentation and reference thumbnails are **not** included in the
repository or build. Artwork retains its original ownership; this file does not
assign a new license to the DuckDB logo or illustrations.

| Workshop file | PPTX entry | Reference slide |
|---|---|---|
| `duckdb-logo.png` | `ppt/media/image1.png` | 1 (cover) |
| `column-file.png` | `ppt/media/image48.png` | 31 (row 2, column 1) |
| `write-data.png` | `ppt/media/image73.png` | 32 (row 1, column 1) |
| `processor.png` | `ppt/media/image56.png` | 31 (row 3, column 1) |
| `inspect.png` | `ppt/media/image47.png` | 30 (row 2, column 4) |
| `maintenance.png` | `ppt/media/image70.png` | 32 (row 1, column 2) |
| `lightbulb.png` | `ppt/media/image40.png` | 30 (row 3, column 3) |
| `inspect-file.png` | `ppt/media/image9.png` | 31 (row 3, column 2) |

## Design translation

- **Canvas:** 16:9, white content slides with near-black text (`#0D0D0D`, `#232323`).
- **Geometry:** the keynote's 1920×1080 pt positions and sizes scaled ×0.833 to the
  1600×900 deck: 53 px titles, 40 px body copy, 64 px margins, 25 px card corners.
- **Covers / chapter breaks:** DuckDB yellow at the top fading to pale yellow at the
  bottom (`#FFF100` → `#FFFA99` in the layout; the rendered `#FCF150` → `#FEFAA4` is used).
  Cover: small header line (left/right), 107 px title, illustration, logo bottom-left
  (reference slides 1–3). Chapters: regular-weight number above a bold 80 px title,
  bottom-left, with line art on the right (reference slide 10).
- **Architecture / contents:** rounded white inset canvas on yellow, adapted from
  reference slides 5 and 22; the contents grid follows slide 5. Most teaching slides
  remain plain white.
- **Cards and steps:** rounded cards with a yellow-gradient head over a `#F5F5F5`
  body, and rounded yellow step tiles (reference slides 23–24). Tables are unboxed
  with hairline rules.
- **Code:** 50/50 white explanation / near-black code pane (slide 14) with the
  DuckDB CLI Dark palette; inline code blocks use DuckDB CLI Light on `#F9F9F9`
  (slides 15, 20).
- **Chrome:** no Reveal arrows or progress bar. The footer follows the keynote layout
  (three small labels and a bare page number) and lives inside each slide so it
  also prints. It uses this workshop's identity, not the reference presenter's name or date.
- **Type:** local `Suisse Intl`, then `Helvetica Neue`, Helvetica, Arial. The
  reference material slide lists Suisse Intl, but the supplied file has no embedded
  fonts and its actual theme uses Helvetica variants. No commercial font is
  downloaded or redistributed. Code uses the bundled open-source JetBrains Mono
  Regular font, then system monospace. The sans-serif fallback can vary by platform.

`main.js` explicitly resolves `asset:name` references in `slides.md` to Vite asset
URLs. The resulting deck loads no image or font from an external service. The
illustrations are decorative; technical segment/block diagrams remain labelled
HTML rather than images, with no fabricated byte proportions.

## Open-source code font

`fonts/JetBrainsMono-Regular.woff2` is from **JetBrains Mono v2.304**:

- Source: https://github.com/JetBrains/JetBrainsMono/tree/v2.304
- Upstream file: `fonts/webfonts/JetBrainsMono-Regular.woff2`
- SHA-256: `a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2`
- License: SIL Open Font License 1.1, retained in `fonts/OFL.txt` and linked from
  the built deck. This license applies to the font, not to the keynote artwork.

The font is bundled locally; there is no font-service request at presentation time.
