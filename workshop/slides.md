<!-- .slide: id="title" class="cover-slide" -->
<p class="eyebrow">DuckDB developers — 90-minute workshop</p>
<p class="cover-meta">Source <code>fb38af476a7d</code> · storage v2.0.0 / 69</p>

# Inside a DuckDB file

<p class="subtitle">From logical values to compressed bytes<br>— and back again.</p>
<p class="cover-motto">Predict → inspect → explain</p>

<img class="cover-art" src="asset:inspect-file" alt="">
<p class="small">Implementation details are versioned, not format promises.</p>
<img class="cover-logo" src="asset:duckdb-logo" alt="DuckDB">

Notes:
Welcome. This is a workshop about explaining a file, not memorizing a list of compression algorithms. By the end, I want you to connect a SQL workload to a persistent segment, explain its representation and allocation, and identify the code path that reads it. We will use the CLI and DuckDB File Atlas together: SQL supplies the engine's view, Atlas supplies the physical checkpoint view. The source baseline is pinned; the local demonstration binary reports v2.1.0-dev84001 with the matching abbreviated revision. We explicitly request v2.0.0 storage. Source revision, binary version, and storage version are three different things.

---

<!-- .slide: id="puzzle" -->
<p class="eyebrow">Opening prediction · 1 minute</p>

## Same rows. Same file?

<div class="columns">
<div class="card"><h3>A · ordered</h3><p>300,000 rows<br><code>value = id % 1000</code><br>Ordered by <code>value, id</code></p></div>
<div class="card"><h3>B · shuffled</h3><p>The same 300,000 rows<br>The same types<br>Ordered by <code>hash(id), id</code></p></div>
</div>

What can change: **codec, segment boundaries, block count, zonemaps?**

Notes:
Ask for a show of hands: who expects the same codec, and who expects the same file size? Do not reveal the files yet. Ask someone to explain which local properties of the data changed even though the multiset did not. The purpose is to separate global cardinality from local runs and distributions. Also ask what happens to the ID column when we sort by value: a beneficial ordering for one column may harm another. We will return to the exact same two files in the lab. There is no timing claim in this comparison.

---

<!-- .slide: id="route" class="panel-slide" -->
## Our route through the file

<p class="eyebrow">90 minutes · Opening predictions: 0–5 min</p>
<div class="agenda-grid">
<div class="agenda-item"><span class="agenda-number">01</span><strong>The shape of<br>a DuckDB file</strong><small>5–17 min · Anatomy</small></div>
<div class="agenda-item"><span class="agenda-number">02</span><strong>How bytes<br>reach disk</strong><small>17–32 min · Write lifecycle</small></div>
<div class="agenda-item"><span class="agenda-number">03</span><strong>Inside the<br>encodings</strong><small>32–55 min · Select, store, read</small></div>
<div class="agenda-item"><span class="agenda-number">04</span><strong>Inspect it<br>yourself</strong><small>55–72 min · Hands-on lab</small></div>
<div class="agenda-item"><span class="agenda-number">05</span><strong>After the first<br>checkpoint</strong><small>72–82 min · Delete and refill</small></div>
<div class="agenda-item"><span class="agenda-number">06</span><strong>What comes<br>next?</strong><small>82–90 min · Engine design</small></div>
</div>

Notes:
Explain the workshop rhythm: short model, prediction, inspection, correction. There are three main exercises: order, persistence history, and churn; overflow is a short guided comparison. Keep the source-code dive optional. In the 60-minute route we skip the deep codec byte layouts and overflow comparison, demonstrate rather than independently work through churn, and keep one design question at the end. There is no need for attendees to compile DuckDB during the session. Pre-generated, checkpointed snapshots are the fallback for every exercise.

---

<!-- .slide: id="columnar" -->
## Columnar is the starting point, not the explanation

<div class="pipeline">
<div class="stage">Similar physical types</div><div class="arrow">→</div>
<div class="stage">Local regularity</div><div class="arrow">→</div>
<div class="stage">Specialized encodings</div><div class="arrow">→</div>
<div class="stage">Selective reads</div>
</div>

- **Distribution and order** matter, not just the SQL type.
- Compression competes with decode cost and access granularity.
- Pruning can avoid reading data; encoding changes its representation.

Notes:
Keep this under one minute. We are not deriving column stores from first principles for this audience. Establish two independent benefits: we may read fewer columns or prune ranges entirely, and we may represent the values we do read more compactly. Do not attribute a future sorted-query speedup solely to compression. The engine must also locate, pin, decode, and process the representation. Transition: to reason about any of these costs, we need to stop using block, segment, row group, and vector interchangeably.

---

<!-- .slide: id="chapter-anatomy" class="chapter-slide" -->
<div class="chapter-copy"><span class="chapter-number">01</span><h2>The shape of<br>a DuckDB file</h2></div>
<img class="chapter-art" src="asset:column-file" alt="">

Notes:
Use this as a brief visual pause, not an extra lecture. Before following a write, let's agree on what its output objects are: logical spans, physical allocations, and the pointers between them.

---

<!-- .slide: id="coordinates" -->
<p class="eyebrow">Anatomy · logical versus physical</p>

## Two coordinate systems

<div class="columns">
<div class="card"><h3>Logical ownership</h3><p>Table<br>↓ Row group<br>↓ Physical column stream<br>↓ Segment: a span of values</p></div>
<div class="card"><h3>Physical allocation</h3><p>File<br>↓ Headers + blocks<br>↓ Allocation within a block<br>↓ Bytes + optional auxiliary storage</p></div>
</div>

A segment pointer connects them: **block ID + payload offset**.

<p class="small">Not one-to-one: shared blocks, zero-payload constants, auxiliary blocks.</p>

Notes:
Draw or point to the connection between the two columns. A row group is a logical horizontal range. Each physical column stream has its own segments; segment boundaries need not line up across columns. A block is an allocation and I/O unit, not a logical row range. Several small segments can occupy one block, and one codec can reference auxiliary blocks. Constants may have no data block at all. The execution vector is yet another unit. Typical defaults here are 122,880 rows per row group, 2,048 rows per execution vector, and a 256 KiB block allocation, but we should inspect configuration rather than elevate defaults to invariants.

---

<!-- .slide: id="streams" -->
## One SQL column is not always one stream

| SQL shape | Storage concepts to inspect |
|---|---|
| Scalar | Values and validity; some codecs embed nullness |
| `STRUCT` | Children + validity; not one opaque struct payload |
| `LIST` | Parent offsets/lengths + child values + validity |
| `ARRAY` | Child values + validity; no direct array codec |

**Child counts are not necessarily table-row counts.**

<p class="source">Source: <code>ColumnData::CreateColumn</code>; <code>StandardColumnData::Checkpoint</code></p>

Notes:
Point out the validity rows attendees will soon see in pragma_storage_info. If they sum every count, they will count the table several times. For lists, child values have their own coordinate system and may outnumber the parent rows. Do not describe every validity stream as a physical bitmap: it may be constant, compressed, or replaced with Empty where a codec embeds null information. DICT_FSST provides that latter example in this revision. We will focus the lab on scalar columns so that the first exercise is not also an exercise in nested decomposition.

---

<!-- .slide: id="file-map" class="panel-slide" -->
## Macro view: headers, then blocks

<div class="block" role="img" aria-label="Schematic file header pages: main header, database header A, database header B">
<span class="overhead">Main header<br>4 KiB</span><span class="second">DB header A<br>4 KiB</span><span class="third">DB header B<br>4 KiB</span>
</div>
<div class="block" role="img" aria-label="Equal allocation-sized blocks with different roles; schematic, not to scale">
<span>Data</span><span class="third">Metadata</span><span>Data</span><span class="unused">Free</span><span class="second">Auxiliary</span>
</div>

- Choose the newest **valid checkpoint header**.
- Follow roots; do not infer ownership from proximity.
- Block roles can be mixed; diagrams are schematic, not to scale.

<p class="source">Source: <code>storage_info.hpp</code>; <code>SingleFileBlockManager</code></p>

Notes:
Explain the three 4 KiB header pages and the alternating database headers. The main header is not one of the two checkpoint slots. Data-block addressing starts after those three pages. With the ordinary default, each later allocation is 256 KiB including its checksum header. Blocks used for metadata, indexes, or auxiliary values inhabit that same physical address space. A metadata object is not necessarily a whole block. If using Atlas now, take at most thirty seconds to show that its header strip is separate from its equal-sized block tiles. No detailed hex view yet.

---

<!-- .slide: id="metadata" class="panel-slide" -->
## Follow pointers from checkpoint to values

<div class="pipeline">
<div class="stage">Active checkpoint</div><div class="arrow">→</div>
<div class="stage">Catalog / table</div><div class="arrow">→</div>
<div class="stage">Row groups</div><div class="arrow">→</div>
<div class="stage">Column tree</div><div class="arrow">→</div>
<div class="stage">Segment pointers</div>
</div>

Metadata describes **row spans, statistics, codec, and allocation references**.

- Metadata streams use a sub-block allocator: 64 slots/block here.
- Separate roots/state describe allocator bookkeeping and free space.
- Unchanged metadata can be reused where supported.

<p class="source">Source: <code>CheckpointManager</code>; <code>MetadataManager</code>; <code>RowGroup::WriteToDisk</code></p>

Notes:
This is the answer to how a reader discovers a column without scanning the whole file for signatures. A checkpoint anchors a graph of serialized metadata. The diagram compresses some intermediate structures; it is an ownership/navigation model, not a complete serialization schema. Metadata streams can cross slots and blocks, and multiple objects share allocations. Keep the free-list pointer visible but defer its detailed semantics until lifecycle. Explain that statistics are useful for pruning and can also carry enough information to represent a constant without allocating a data payload. In Atlas select a row group, then its column segment, then the physical block.

---

<!-- .slide: id="shared-block" class="panel-slide" -->
## Zoom in: a block is a container

<div class="block" role="img" aria-label="Schematic shared block: checksum, segment A, alignment gap, segment B, unused tail">
<span class="overhead">Checksum</span><span>Segment A</span><span class="unused">Gap</span><span class="second">Segment B</span><span class="unused">Tail</span>
</div>

**Partial-block packing** places small segment outputs together.

- Offset is not length. Neighboring pointers do not prove an extent.
- Unused bytes inside a live block ≠ a whole reusable free block.
- Shared-block references matter when retiring an allocation.

<p class="source">Source: <code>PartialBlockManager</code>; <code>ColumnCheckpointState::FlushSegmentInternal</code></p>

Notes:
Walk through a segment that produces less than a block of bytes. The partial-block manager can place another eligible segment beside it, with alignment and delayed flushing. The default threshold considers allocations up to about eighty percent of usable block size for sharing, but do not spend the session memorizing this tuning parameter. Selection uses available space; packing and lifetime determine the outcome. Ask: if segment A is replaced, can I free the block immediately? No, B still references it. Also explain that an observed gap is not proof that the live engine can allocate a new segment into that exact hole.

---

<!-- .slide: id="accounting" -->
## “Compressed size” needs a denominator

| Measurement | Includes / excludes |
|---|---|
| Segment payload bytes | Primary segment extent; not automatically auxiliary storage |
| Codec-owned allocations | Primary + auxiliary references; sharing needs accounting |
| Allocated block capacity | Includes checksums, gaps, tails; not all useful payload |
| Database file size | Also headers, metadata, indexes, free blocks |
| Bytes per live row | Changes when rows are deleted, even without rewriting payload |

**Unknown size stays unknown.**

Notes:
This is the accounting contract for the rest of the workshop. There is no single universally correct compression ratio without defining which bytes and which rows are counted. A constant can have zero physical payload while still costing metadata. A long string's primary segment can be tiny because its bytes live elsewhere. An index is not column payload. Deleted values may remain represented in stored spans. Atlas makes these distinctions explicit, but the presenter must still state which metric is being compared. We will report file sizes as file sizes, and use recorded segment extents only where available.

---

<!-- .slide: id="chapter-lifecycle" class="chapter-slide" -->
<div class="chapter-copy"><span class="chapter-number">02</span><h2>How bytes<br>reach disk</h2></div>
<img class="chapter-art" src="asset:write-data" alt="">

Notes:
That is the snapshot. Now which operations could have put it there? Move straight into the distinction between writing a block, making a transaction durable, and publishing a checkpoint.

---

<!-- .slide: id="three-events" -->
<p class="eyebrow">Lifecycle · writes, durability, publication</p>

## Three events—not one “flush”

<div class="columns three">
<div class="card"><h3>Bytes are written</h3><p>A persistent block exists in the database file.</p></div>
<div class="card"><h3>A transaction is durable</h3><p>Recovery can reconstruct committed state.</p></div>
<div class="card"><h3>A checkpoint is published</h3><p>A new root makes a consistent persistent snapshot discoverable.</p></div>
</div>

**Physical presence does not imply committed visibility.**

Notes:
Use this as the central distinction in the write-path section. A bulk insert can write compressed data blocks before commit. A small transaction can be durable through the WAL without those values being in the published checkpoint. The selected database file alone is a checkpoint view, not necessarily the latest committed database state when a WAL exists. This is why every file we hand to the browser is explicitly checkpointed and the writer closed. We are discussing normal persistent databases; temporary, in-memory, recovery, and concurrent-checkpoint paths have their own conditions.

---

<!-- .slide: id="write-paths" -->
## SQL syntax does not uniquely determine the write path

| Situation | Typical mechanism to trace |
|---|---|
| Small append + commit | Transient values → tuple WAL → later checkpoint |
| Eligible bulk append | Optimistic compression / DB blocks → WAL references |
| Explicit / automatic checkpoint | Reuse or rewrite → metadata → publish root |
| Updates / deletes | Overlay or delete+insert; deletion metadata; later rewrite/reclaim |
| Memory-pressure spill | Temporary storage, not automatically database persistence |

<p class="source">Source: <code>LocalStorage::Flush</code>; <code>DataTable::WriteToLog</code>; <code>OptimisticDataWriter</code></p>

Notes:
Do not read this as five universal guarantees. COPY FROM feeds insertion, and CTAS chooses insertion operators based on planning conditions. Eligibility and volume matter more than spelling. In the normal small-write path the WAL contains inserted tuples. Eligible bulk writes can synchronize already-produced database blocks and log persistent row-group descriptions/references instead. Automatic checkpoint decisions can alter the ordinary commit path. The spill row is here to prevent the misconception that every disk write under memory pressure is a durable table segment. Ask which source file attendees would open to distinguish these cases.

---

<!-- .slide: id="bulk" -->
## Bulk writing: compress before commit

<div class="pipeline">
<div class="stage">Local row groups</div><div class="arrow">→</div>
<div class="stage">Buffered batch</div><div class="arrow">→</div>
<div class="stage">Analyze + compress</div><div class="arrow">→</div>
<div class="stage">DB blocks</div>
</div>

- Optimistic writing is conditional; row-group or memory thresholds trigger it.
- Commit still needs synchronization, logging, and transaction semantics.
- Buffered multi-row-group writing loops **column, then row group** here.

<p class="source">Source: <code>OptimisticDataWriter::WriteNewRowGroup</code>; <code>RowGroup::WriteToDisk</code></p>

Notes:
The interesting physical-order detail is that the multi-row-group bulk path deliberately checkpoints a column across buffered row groups before moving to the next column. This can colocate same-column data in that batch. It does not establish a file-wide column-major format. Writers may have separate batches; blocks may be packed or flushed later; allocation can reuse free IDs. The final flush can include incomplete row groups. Local deletes or updates can change which commit/logging path is legal. Point to the source navigation appendix if someone wants to inspect the exact loop later.

---

<!-- .slide: id="checkpoint" -->
## Checkpoint does not mean “recompress everything”

<div class="columns">
<div class="card"><h3>Unchanged</h3><p>Reuse persistent payload.<br>Reuse metadata when supported.<br>Retain the existing encoding.</p></div>
<div class="card"><h3>Needs rewrite</h3><p>Scan committed values.<br>Analyze candidates.<br>Compress and emit new segments.<br>Retire replaced references safely.</p></div>
</div>

A changed column checkpoint unit can span **multiple old segments**.

<p class="source">Source: <code>ColumnDataCheckpointer::Checkpoint</code>; <code>ColumnData::HasChanges</code></p>

Notes:
Ask: if I change force_compression and immediately checkpoint, must every old segment change? No. Unchanged column payload can bypass analysis and compression. Metadata reuse and payload reuse are separate decisions. If an update makes a column checkpoint unit require rewriting, the unit is the physical column stream within the row group, not necessarily one old segment or just the one modified value. The checkpoint scan incorporates committed updates. Delete vacuum/row-group merging can also trigger reconstruction. This matters when designing experiments: use fresh tables or an explicitly understood rewrite, not an assumption that CHECKPOINT is a universal transcode command.

---

<!-- .slide: id="publication" -->
## Publication protects the previous checkpoint

<div class="pipeline">
<div class="stage">Write new data + metadata</div><div class="arrow">→</div>
<div class="stage">Sync</div><div class="arrow">→</div>
<div class="stage">Publish alternate header</div><div class="arrow">→</div>
<div class="stage">Sync + release retired blocks</div>
</div>

- A block still needed by the old checkpoint cannot be reused too early.
- Shared blocks need reference accounting.
- The free-list state and metadata allocator belong to this lifecycle.

<p class="small">Simplified sequence; WAL and concurrent-checkpoint coordination remain essential.</p>

<p class="source">Source: <code>SingleFileBlockManager::WriteHeader</code>; <code>CheckpointManager</code></p>

Notes:
This is why the allocator story belongs with publication rather than just a static file diagram. Newly written blocks and blocks reachable from the previous checkpoint have different reuse constraints. WriteHeader serializes allocator state and orders synchronization around the alternate header publication; only afterward can retired checkpoint blocks become available for reuse. The diagram is not a complete recovery protocol. WAL markers and concurrent commits require additional coordination. Do not say that every checkpoint simply deletes every WAL file. We will observe the resulting free-list snapshots, not reconstruct crash history from one file.

---

<!-- .slide: id="ordering" -->
## Physical order is a result, not a guarantee

**Write scheduling + partial-block packing + parallelism + allocation history**

- Ordinary checkpoints schedule row-group work.
- Bulk batches can group writes by column.
- Free-list allocation can reuse an older physical address.
- One thread removes a confound; it does not imply contiguous ownership.

> Ask “which path and history produced this?”<br>not “is DuckDB row-group-major or column-major?”

Notes:
Contrast the column-first bulk loop with ordinary checkpoint row-group task scheduling. Neither is enough to predict every final block ID. A physical address is not a timestamp. Different files can reuse the same numeric block ID for unrelated content. Do not equate the logical insertion-order setting with a promise about disk order. If the audience is interested in parallelism, offer a post-workshop experiment with identical workload and different thread counts, recording configuration and actual resulting layout. Our main persistence-history experiment stays single-threaded to avoid that extra variable.

---

<!-- .slide: id="history-lab" -->
<p class="eyebrow">Guided exercise · 3 minutes</p>

## Same rows, different persistence history

**Open:** `02-bulk.duckdb` and `02-append.duckdb`

| Bulk | Append + checkpoint history |
|---|---|
| One CTAS, then checkpoint | Ten 30k-row transactions, checkpoint after each |
| 300k rows, one thread | Identical rows and order, one thread |

Predict: **ten transactions → ten row groups?**

Inspect row-group spans, primary pointers, and whole free blocks.

Notes:
This is a guided demonstration rather than a long independent exercise. Open the two snapshots in separate Atlas tabs. Color by row group, then select the payload column and inspect its referenced blocks. In the rehearsed run the bulk row-group spans were 122880, 122880, 54240; the append spans were 120000, 120000, 60000. Both used BitPacking for the numeric columns and DICT_FSST for the payload. Bulk had 23 total and zero free blocks; append had 27 total and three free. These are observed outputs, not expected constants. The important reveal is not ten row groups. This compares checkpoint history, not SQL syntax or ingestion speed. See demos/README.md for exact logs and provenance.

---

<!-- .slide: id="chapter-encodings" class="chapter-slide" -->
<div class="chapter-copy"><span class="chapter-number">03</span><h2>Inside the<br>encodings</h2></div>
<img class="chapter-art" src="asset:processor" alt="">

Notes:
Now follow the column rewrite into the decision that chooses its bytes. This divider adds no new material: the next slide introduces eligibility, analysis, scoring, compression, and emitted segments.

---

<!-- .slide: id="selection" class="panel-slide" -->
<p class="eyebrow">Compression · decision before representation</p>

## How does a codec win?

<div class="pipeline">
<div class="stage">Eligible candidates</div><div class="arrow">→</div>
<div class="stage">Analyze input</div><div class="arrow">→</div>
<div class="stage">Finalize scores</div><div class="arrow">→</div>
<div class="stage">Choose + rescan</div><div class="arrow">→</div>
<div class="stage">Emit segments</div>
</div>

Decision scope: **a physical column stream within a row-group rewrite**.

One winner can emit many segments and several internal modes.

<p class="source">Source: <code>ColumnDataCheckpointer::DetectBestCompressionMethod</code>, <code>WriteToDisk</code></p>

Notes:
This is the missing link between the data distribution and the bytes. Candidate enumeration depends on physical type and writing support. InitAnalyze can reject a candidate, and analyze can eliminate it as values arrive. FinalAnalyze returns a score; the lowest surviving score wins in the normal automatic case. The winning state can carry trained information into compression. The input is then scanned again for encoding. Do not teach this as choosing independently for each execution vector or each old segment. The chosen codec can emit multiple new segments, and some outputs may be converted to constants. Base and validity streams have distinct responsibilities.

---

<!-- .slide: id="scores" -->
## The score is a model—not a measured file size

- Usually size-oriented, but **estimates and preference penalties** are allowed.
- Candidate sets depend on type, storage target, and configuration.
- Forced compression still analyzes; rejection / fallback can occur.
- Constant and Empty are special paths, not ordinary competing candidates.
- Unchanged persistent data can skip this whole decision.

<p class="small">The framework visits all input here. Some codecs already sample internally.</p>

<p class="source">Source: <code>compression_config.cpp</code>; <code>compression_function.hpp</code>; codec <code>final_analyze</code> callbacks</p>

Notes:
Use a concrete example without turning heuristics into public contracts: this revision applies preference factors to some size models, and some string estimates are deliberately coarse. The score is not query latency or a promise of final file bytes; validity, metadata, auxiliary allocations, and block slack complicate that relationship. A forcing preference does not make an unsupported type compress with that codec. It also does not remove the full analysis pass. Distinguish framework-level full input traversal from codec-local sampling inside FSST, ALP, or ALPRD; this distinction will anchor the future-directions discussion.

---

<!-- .slide: id="families" -->
## A map of the encoding families

| Physical stream | Important writing families at this source revision |
|---|---|
| Integers / list offsets | Uncompressed, RLE, BitPacking |
| Floating point | Uncompressed, RLE, ALP, ALPRD |
| Strings | Uncompressed, ZSTD, DICT_FSST for newer targets |
| Validity / booleans | Bitmap / numeric paths, Roaring where supported |
| Special outputs | Constant; Empty validity |

<p class="small">Legacy Dictionary / FSST write to older targets. Chimp / Patas readers remain, but are not writing candidates here. Logical SQL types map to physical types.</p>

Notes:
This is a map, not an exhaustive enumeration of every SQL type. Boolean paths include RLE and BitPacking as well as version-gated Roaring; validity is a different physical stream. INTERVAL stays uncompressed in this baseline. Dictionary and FSST are useful conceptual building blocks, but newer targets use DICT_FSST instead of independently selecting those older writers. Do not present names in the enum as proof of an implemented writer: PFOR_DELTA is a placeholder and Chimp/Patas are decode-only in this revision. The appendix has version gates. For the next slides repeat the same questions: favorable data, stored representation, access behavior, failure case.

---

<!-- .slide: id="constant-rle" -->
## Constant and RLE: exploit repetition

<div class="columns">
<div class="card"><h3>Constant</h3><p>One value + metadata/statistics.<br><strong>No physical data block.</strong><br>A scan can return a constant vector.</p></div>
<div class="card"><h3>RLE</h3><p>Run values + run lengths.<br>Good for long local runs.<br>Random alternation destroys the advantage.</p></div>
</div>

<div class="block" role="img" aria-label="RLE segment schematic: count-array offset, run values, alignment, 16-bit run lengths">
<span class="overhead">Count-array offset</span><span>Run values</span><span class="unused">Align</span><span class="second">u16 run lengths</span>
</div>

<p class="source">Source: <code>numeric_constant.cpp</code>; <code>rle.cpp</code></p>

Notes:
A constant is an especially important accounting counterexample. DuckDB can keep enough information in statistics to avoid a payload allocation. The recorded codec size field can still retain a nonzero size in some serialized constant cases; INVALID_BLOCK is the physical allocation distinction. For RLE, show the actual separation of run values and 16-bit run counts with an offset locating the count array. Long runs must split at counter limits. Nullness normally remains in validity. A scan that stays within one run can produce a constant vector, but arbitrary point access may need to navigate runs. The favorable pattern is local repetition, not just low global distinct count.

---

<!-- .slide: id="bitpacking" -->
## BitPacking is a family of local modes

**Frame of reference:** store a base + narrow residuals.

**Delta modes:** exploit predictable differences between values.

<div class="block" role="img" aria-label="BitPacking segment schematic: metadata-end pointer, group payloads, alignment, reverse metadata entries">
<span class="overhead">Metadata end</span><span>Group payloads</span><span class="unused">Align</span><span class="second">Reverse mode / offset entries</span>
</div>

- Modes here: Constant, Constant Delta, FOR, Delta FOR.
- Group metadata supports skipping; delta access still needs reconstruction.
- An outlier can widen a local group's representation.

<p class="source">Source: <code>bitpacking.cpp</code></p>

Notes:
Use a tiny verbal example: values 1000, 1001, 1002 can be stored relative to a frame rather than as full-width integers, and a predictable sequence also has cheap deltas. The actual format has group payloads and reverse metadata entries carrying mode and payload offset. The standard metadata group here is 2048 values, while primitive packing groups use 32; do not conflate either with a segment. The slide is schematic, not to scale. Skip/fetch can jump toward a group using metadata, but the target mode determines how much reconstruction remains. A codec name alone does not reveal the per-group mode or total access cost.

---

<!-- .slide: id="dictionary-fsst" -->
## Strings: reuse values, reuse byte patterns

<div class="columns">
<div class="card"><h3>Dictionary</h3><p>Distinct strings + compact row IDs.<br>Wins on repeated whole values.<br>Cardinality is local to the encoding unit.</p></div>
<div class="card"><h3>FSST</h3><p>Symbol table + encoded string bytes.<br>Reuses short byte sequences.<br>Can help even when whole strings differ.</p></div>
</div>

Different questions: **“Have I seen this value?”** versus **“Have I seen these bytes?”**

<p class="source">Source: <code>dictionary_compression.cpp</code>; <code>fsst.cpp</code></p>

Notes:
Explain dictionary row IDs using a few city names, then FSST using repeated substrings in otherwise unique URLs. A symbol table is not the same as a dictionary of complete distinct SQL values. The older dictionary layout has bitpacked IDs, cumulative string offsets and string bytes; the older FSST layout has compressed lengths, its serialized symbol table and encoded bytes. We are not drilling into both legacy headers. Those mechanisms lead directly to the current combined codec. Also mention scan behavior: dictionary scans may return dictionary vectors, and FSST can support delayed decompression when the relevant setting/path permits it; not every consumer preserves that representation.

---

<!-- .slide: id="dict-fsst" -->
## DICT_FSST combines the string mechanisms

Modes: **Dictionary · Dictionary + FSST · FSST only**

<div class="block" role="img" aria-label="DICT_FSST segment schematic: header, string or dictionary bytes, optional symbol table, packed lengths, packed IDs">
<span class="overhead">Header</span><span>String / dictionary bytes</span><span class="third">Optional FSST table</span><span class="second">Packed lengths</span><span>Packed IDs</span>
</div>

- Optional structures depend on mode; boundaries are aligned.
- Nullness is embedded here: separate validity becomes Empty.
- Oversized strings can reject this candidate; not automatic overflow.

<p class="source">Source: <code>dict_fsst/common.hpp</code>; <code>dict_fsst/compression.cpp</code>; <code>dict_fsst/analyze.cpp</code></p>

Notes:
Stress that the outer codec name does not mean every segment uses a dictionary and FSST simultaneously. Mode and input determine the structures. In FSST-only mode the ID stream may be unnecessary. The current codec declares NO_VALIDITY_REQUIRED, which explains Empty validity in storage inspection without suggesting that nulls were lost. The sketch follows the writer's layout: header, string data, optional FSST table, bitpacked lengths and IDs. Padding details are omitted. Large strings may rule out this candidate in analysis, and FSST can be disabled while dictionary behavior remains. This is a good point to ask what would be needed to add auxiliary storage safely.

---

<!-- .slide: id="floating" -->
## Floating point: compress without losing bits

<div class="columns">
<div class="card"><h3>ALP</h3><p>Decimal scaling → integers.<br>Frame + bitpacked values.<br>Exceptions preserve exact values.</p></div>
<div class="card"><h3>ALPRD</h3><p>Split floating-point bit patterns.<br>Dictionary-code high bits.<br>Pack low bits + exceptions.</p></div>
</div>

Both use internal vectors and offset metadata for access.

**Lossless** does not mean every vector compresses well.

<p class="source">Source: <code>alp/*</code>; <code>alprd/*</code> under storage compression</p>

Notes:
Avoid saying ALP rounds the user's data. It finds a representation for decimal-like floats and uses exceptions so decoding preserves values exactly. Its internal compression vector is 1024 values in this baseline, another reason not to identify a compression unit with the execution vector. ALPRD targets redundancy in the bit patterns using dictionary-coded high parts and packed low parts. Both have per-vector offsets and exception information. Newer compatible storage targets support raw-vector fallback when a particular vector would expand. A point fetch can locate an internal vector but still decode that vector; bytes saved is only one part of the access tradeoff.

---

<!-- .slide: id="overflow" -->
## Auxiliary blocks are already part of some codecs

<div class="pipeline">
<div class="stage">Primary segment<br>offsets / markers</div><div class="arrow">→</div>
<div class="stage">Auxiliary page</div><div class="arrow">→</div>
<div class="stage">Further pages if needed</div>
</div>

- Uncompressed strings: inline data or references to overflow strings.
- ZSTD strings: vector descriptors + length data + compressed frames.
- ZSTD vector data can fit inline **or span auxiliary pages**.
- Ownership must survive serialization, reading, and reclamation.

<p class="source">Source: <code>string_uncompressed.cpp</code>; <code>write_overflow_strings_to_disk.cpp</code>; <code>zstd.cpp</code></p>

Notes:
Define overflow as an allocation/reference mechanism, not a compression algorithm. For uncompressed strings, the primary segment can hold offsets and overflow markers while string data resides elsewhere. For ZSTD, the primary segment describes vectors with page IDs, offsets, compressed sizes and uncompressed sizes; string lengths and compressed frames are vector data that may span pages. The diagram is conceptual and is not a promise that the additional_block_ids output is in chain order. Also distinguish partial-block packing: that packs several small primary segments together, whereas auxiliary pages extend a codec's ownership beyond its primary allocation.

---

<!-- .slide: id="read-path" -->
## Read path: representation affects execution

<div class="pipeline">
<div class="stage">Locate segment</div><div class="arrow">→</div>
<div class="stage">Pin / initialize</div><div class="arrow">→</div>
<div class="stage">Scan / skip / fetch</div><div class="arrow">→</div>
<div class="stage">Return vector</div>
</div>

| Operation | Codec-dependent work |
|---|---|
| Sequential scan | Reuse decoder state; sometimes retain encoded representation |
| Partial scan / fetch | Locate sub-unit, decode or reconstruct enough values |
| Skip / filter | Specialized callbacks where supported, not a universal capability |

**Smallest file ≠ cheapest query.**

Notes:
Use three contrasts: constant output can avoid materializing repeated values; a dictionary scan may return a dictionary vector; ZSTD fetch may need to restart at an internal vector and decode/discard earlier strings within it. Partial scans must satisfy flat-vector requirements here, including reads crossing segment boundaries. Bitpacking metadata helps skipping but delta modes still require local reconstruction. The codec interface has optional select/filter hooks, not a blanket guarantee of executing all expressions over compressed data. Do not imply we benchmarked query performance in the file-size labs. To evaluate a change, design separate scan, filtered scan, point fetch, memory, and write-cost measurements.

---

<!-- .slide: id="developer-contract" -->
## Adding a codec is more than writing `compress()`

1. Eligibility, analysis, scoring, trained state.
2. Segment capacity, row counts, statistics, alignment.
3. Scan, partial scan, fetch, skip; null and vector contracts.
4. Persisted state, version gates, corruption checks.
5. **Every auxiliary block accounted for across its lifetime.**

<p class="small">Internal C++ interface—not a promise of a public codec plugin ABI.</p>

<p class="source">Source: <code>compression_function.hpp</code>; <code>StandardCompressionState</code>; <code>ColumnSegment::VisitBlockIds</code></p>

Notes:
For this audience this is the bridge from learning to contribution. The hard bugs often appear outside the hot compression loop: partial vector sizes, nulls, lifetime of returned buffers, reopening an old format, and dropped auxiliary allocations. The visit_block_ids hook feeds introspection and retirement/checkpoint bookkeeping. If a new codec allocates extra pages but fails to report them, the error is not merely a missing visualizer color. Ask for a test plan: empty/all-null, constants, boundary values, segment boundaries, point fetch, update/delete/checkpoint, reopen, old storage target, and corrupted persisted state. The appendix contains source paths for follow-up.

---

<!-- .slide: id="chapter-investigation" class="chapter-slide" -->
<div class="chapter-copy"><span class="chapter-number">04</span><h2>Inspect it<br>yourself</h2></div>
<img class="chapter-art" src="asset:inspect" alt="">

Notes:
We now have enough vocabulary to investigate without guessing. Get the read-only CLI output and prepared Atlas tabs ready, then move on to the engine's storage-info view and its limits.

---

<!-- .slide: id="sql-tools" class="code-slide" -->
<p class="eyebrow">Investigation · engine view + checkpoint view</p>

## Ask the engine first

<div class="code-explanation">
<p>Start with the segment's row span, codec, and primary pointer.</p>
<p>Keep values and validity separate.</p>
<p>Then inspect the full output for <code>stats</code>, <code>column_path</code>, and <code>additional_block_ids</code> where available.</p>
</div>

```sql
SELECT row_group_id,
       column_name, segment_type,
       compression, count, persistent,
       block_id, block_offset
FROM pragma_storage_info('t')
ORDER BY row_group_id,
         column_id, segment_id;

PRAGMA database_size;
```

Notes:
Run this against the sorted snapshot read-only, or show its captured log. Keep value and validity rows separate. Explain persistent versus transient pointers, and the negative sentinel for a constant without a block. Block offset is a start inside the usable payload in the engine output, not an absolute file offset or a length. In this source revision start in the pragma is relative to the row group for ordinary scalar streams; do not assume table-global coordinates. The full SELECT star in inspect.sql keeps the available schema visible. Include_segment_info is available in the referenced implementation for optional codec details; inspect version support before using it in an older CLI.

---

<!-- .slide: id="limits" -->
## What SQL storage metadata does not establish

- `count` is values, **not bytes**.
- Distinct primary block counts omit auxiliary storage and can overlap by owner.
- No exact segment-byte-length column in this pragma at our baseline.
- A neighboring offset is **not** a reliable segment end.
- A free-list snapshot does not record historical owners.

<p class="small">Format 69 can record optional segment <code>byte_size</code> in checkpoint metadata. Older retained segments can still lack it.</p>

Notes:
This is where Atlas complements SQL rather than replaces it. The native parser follows checkpoint metadata and can read the optional recorded byte_size. It does not estimate missing sizes from adjacency. A constant with no block still has zero physical segment payload, even if a codec-size field is nonzero. Additional block IDs tell us about allocation references but not necessarily internal utilization. SQL and native inspection are answering related but different questions. Pin these details to the version: avoid saying pragma_storage_info can never expose byte sizes in the future. Our statements concern the demonstrated implementation.

---

<!-- .slide: id="atlas" -->
## The Atlas investigation loop

1. **Checkpoint + close** the writer; choose the immutable snapshot.
2. Physical map: color by table, row group, then compression.
3. Logical map: choose a column segment and follow its block pointer.
4. Inspect recorded ranges, sharing, and auxiliary references.
5. Explain unknowns before interpreting free space.

<p class="small">The browser sees the selected file—not sibling WAL files or uncommitted state.</p>

Notes:
Live navigation script: open 01-sorted, expand the summary, color by row group, click the RG label to highlight the blocks it touches, then select one value segment in the logical map. Follow the block link and identify whether other segments share it. Switch to compression colors and compare value and validity. Show a constant's lack of a data block. Return to the summary and name its coverage caveats. Keep the app in a separate tab; the slides themselves do not load DuckDB-WASM. Do not use the mutable working database produced by the generator. If browser interaction fails, use the SQL logs and recorded observations in demos/README.md; do not pretend they prove unmeasured byte extents.

---

<!-- .slide: id="order-lab" -->
<p class="eyebrow">Pair exercise · 8 minutes</p>

## Explain the sorted and shuffled files

**Open:** `01-sorted.duckdb` and `01-shuffled.duckdb`

1. Predict the favorable encoding for `value`.
2. Inspect codec and stored row spans; separate validity.
3. Follow one segment to a physical block. Is it shared?
4. Compare row-group value ranges. What could be pruned?
5. Explain file-size differences **without calling them column payload bytes**.

Deliverable: a **three-sentence explanation**, with one uncertainty.

Notes:
Give pairs five minutes to investigate and use three minutes for the reveal. Expected observations from rehearsal: value uses RLE when sorted and BitPacking when shuffled; both ID columns use BitPacking. Sorted value ranges are 0–409, 409–819, 819–999 for the three row groups. The sorted file is 1,060,864 bytes and shuffled 1,585,152 bytes in that run. These exact choices and sizes are not invariants. A good explanation names local runs, distinguishes narrower zonemaps from encoding, and acknowledges total file overhead. Ask one pair how the ID ordering changed. If participants get stuck, point them to the codec-summary query in inspect.sql, not straight to the answer table.

---

<!-- .slide: id="overflow-lab" -->
<p class="eyebrow">Guided comparison · 3 minutes</p>

## Where did the long strings go?

**Open:** `03-overflow-uncompressed.duckdb` and `03-overflow-zstd.duckdb`

Same 1,500 strings × 8,192 bytes; intentionally repetitive synthetic data.

- Compare primary segments and `additional_block_ids`.
- Follow the uncompressed string's auxiliary allocations in Atlas.
- Is a smaller primary segment enough to claim a smaller footprint?

**Allocation references do not reveal page utilization or chain order.**

Notes:
This requires generating with --overflow. It is a guided reveal, not another eight-minute lab. The input repeats an ID-derived MD5 string, so make its artificial compressibility explicit. In rehearsal the uncompressed payload referenced 47 additional blocks, while the ZSTD payload fit without additional block IDs. Do not generalize that ZSTD never overflows: its implementation supports auxiliary pages. Force settings applied to strings do not imply every other physical type in the table uses that codec. If the extra fixtures are unavailable, skip this slide rather than generating under time pressure. Show the source diagram from the overflow slide instead.

---

<!-- .slide: id="chapter-churn" class="chapter-slide" -->
<div class="chapter-copy"><span class="chapter-number">05</span><h2>After the first<br>checkpoint</h2></div>
<img class="chapter-art" src="asset:maintenance" alt="">

Notes:
A freshly loaded file is the easy case. Let's make its history visible. Use this pause to switch to the baseline churn snapshot before asking for predictions about deletion, free space, and refill.

---

<!-- .slide: id="churn-model" -->
<p class="eyebrow">Lifecycle revisited · logical deletion versus physical space</p>

## Deleting rows does not prescribe a byte layout

- Updates can use overlays; some execution paths use delete + insert.
- Delete visibility is separate from the stored value representation.
- Checkpoint can remove full groups or compact eligible groups.
- Partly deleted groups may retain stored values and tombstones.
- Trailing free blocks can be truncated; interior free blocks enable reuse.

**File shrinkage, logical deletion, and reusable space are different outcomes.**

Notes:
Avoid both extremes: checkpoint does not necessarily physically remove all deleted values, but it also does not necessarily keep every old span forever. Vacuum/merging policies, concurrent checkpoint mode, row-ID constraints and index handling affect reclamation. At this source revision it is too strong to claim indexes universally prevent compaction: supported remapping/rebuilding policies exist. We are not teaching those algorithms in detail. The baseline fixture has no indexes, so the churn exercise stays about column payload and allocation lifecycle. Physical stored counts include tombstones; SQL count(*) gives live rows. Statistics may still cover deleted values.

---

<!-- .slide: id="churn-lab" -->
<p class="eyebrow">Group exercise · 6 minutes</p>

## Predict → delete → checkpoint → refill

**Open in order:** `03-baseline` → `03-deleted` → `03-refilled`

1. Baseline: 300k rows, no indexes.
2. Delete one initial group plus scattered rows; checkpoint.
3. Append 150k new rows; checkpoint.

Inspect **live vs stored rows**, whole free blocks, and the physical map.

Will the file shrink? Will refill consume every free block before growing?

Notes:
Take predictions before opening the deleted snapshot. The SQL removes id < 122880 OR id % 4 = 0. The literal matches the intended first group on this build, not a universal row-group-size guarantee. After deletion the rehearsed output has 132840 live rows and 177120 stored ID slots; the file stays at 10,760,192 bytes while free blocks rise to 16. After refill there are 282840 live rows and 313560 stored ID slots; the file grows to 18,624,512 bytes and has 27 free blocks. Use the File list/Free list view and row-group links. Do not imply a bug or infer exact allocation chronology from these endpoint snapshots. Ask why a newly freed block might not have been reusable earlier during the same checkpoint.

---

<!-- .slide: id="churn-debrief" -->
## A defensible explanation names the lifecycle

<div class="columns">
<div class="card"><h3>What we observed</h3><p>Deletion can leave file size unchanged.<br>Stored spans can exceed live rows.<br>Refill can grow a file that has free blocks.</p></div>
<div class="card"><h3>What we must not invent</h3><p>Exact historical block owners.<br>Reclaimable payload from row counts.<br>A promise that every free block was available at every write.</p></div>
</div>

Checkpoints expose **state**, not a complete execution trace.

Notes:
Close the loop to the publication slide. Space that is free in the final checkpoint might have become reusable only after new data was allocated and published. Rewriting and compaction can also retire blocks as part of producing the new state. That explains why the simple mental model of consuming every eventually-free byte before growth is inadequate, but it does not prove a particular detailed timeline from one snapshot. To establish exact causality we would instrument allocation and write paths, not read history into colors. Keep the accounting levels separate: tombstones, gaps inside live blocks, whole free blocks, and physical EOF.

---

<!-- .slide: id="chapter-future" class="chapter-slide" -->
<div class="chapter-copy"><span class="chapter-number">06</span><h2>What comes<br>next?</h2></div>
<img class="chapter-art" src="asset:lightbulb" alt="">

Notes:
Which part of this pipeline would we redesign first? Move into the two design questions, keeping the distinction between implemented features and proposals explicit. The agenda and total discussion time are unchanged.

---

<!-- .slide: id="sampling-future" -->
<p class="eyebrow">Design discussion · proposal, not baseline behavior</p>

## Sampling the selection framework

**Already present:** codec-local samples and heuristic size models.

**Design opportunity:** avoid feeding every candidate the full input.

- What must still be checked over every value for correctness?
- How do samples handle runs, skew, rare outliers, and late distribution shifts?
- Can sampled training state feed the existing compressor?
- What fallback and cost model make a wrong choice safe?

Notes:
Give the room ninety seconds to propose one adversarial dataset. Examples: a sorted low-cardinality prefix followed by unique long strings, a rare large numeric outlier, or runs whose lengths are destroyed by random sampling. Separate correctness checks from quality estimates: a sample can miss a string that invalidates a codec's size assumptions. A robust design needs either full validation or an encoder with a safe fallback before publishing valid output. Existing codec-local sampling means the proposal is not simply add randomness; it is changing the framework's analysis cost and contracts. Ask which metric should decide success: selection CPU, end-to-end load time, regret in encoded size, query cost, or memory.

---

<!-- .slide: id="overflow-future" -->
## Generalizing auxiliary storage

**Already present:** uncompressed string overflow and ZSTD pages.

**Design opportunity:** reusable support for more encodings.

| Potential benefit | Required design work |
|---|---|
| Fewer block-size-driven rejections | Reference format and storage compatibility |
| More flexible dictionaries / payloads | Ownership, sharing, retirement, corruption checks |
| Better packing choices | Random access, prefetch, read amplification |
| Less codec-specific machinery | Accurate accounting and introspection |

Notes:
Do not present overflow as a free compression-ratio improvement. Extra references can increase random reads, pinning needs and cache pressure. A generalized API should make it difficult to forget visitation and reclamation, not merely provide allocate_page. Ask where responsibility belongs: codec, segment framework, or block allocator. Which invariants can the framework validate? Tie this back to the developer checklist and to what Atlas cannot currently measure about internal auxiliary payload utilization. If someone has a feature branch, discuss it as a proposal relative to this pinned baseline, not as a property of all released files.

---

<!-- .slide: id="takeaways" -->
## Five questions to take back to the code

1. Which **logical stream and row span** am I looking at?
2. Which **write path and history** produced it?
3. Why did this **codec and internal mode** win?
4. Which **payload, auxiliary, metadata, and free bytes** am I counting?
5. What must the engine do to **read, replace, and reclaim** them?

**Predict → inspect → explain → verify in source.**

<p class="small">Exercises + observations: <code>workshop/demos/</code><br>Source map + presenter script: <code>workshop/</code></p>

Notes:
Return to the opening puzzle and ask someone to explain it using these five questions. A good answer does not require memorizing byte offsets. It identifies the logical distribution, the persistence path, the selected representation, the allocation accounting, and the relevant read/lifecycle cost. Reserve the remaining time for questions. If time is tight, point attendees at the runnable exercises and source map instead of rushing through the appendix. For a follow-up workshop, use measurements to evaluate one proposed selection or overflow change; today's fixture sizes are observations, not a performance benchmark.

---

<!-- .slide: id="appendix-versions" -->
<p class="eyebrow">Appendix · compatibility</p>

## Engine version ≠ target format ≠ every segment's age

| Writing behavior in this baseline | Storage gate |
|---|---|
| ZSTD strings; Roaring validity | ≥ v1.2 |
| DICT_FSST replaces legacy Dictionary / FSST writers | ≥ v1.3 |
| Roaring booleans; ALP/ALPRD raw-vector fallback | ≥ v1.5 |
| Optional persisted segment `byte_size` | v2.0 / 69 |

An upgraded file can retain old segments and missing optional metadata.

Notes:
These gates describe the pinned source's writing behavior, not release-support promises from the slide deck. Newer readers retain compatibility with older codecs. Actual candidate eligibility can add more constraints: ZSTD rejects an in-memory block manager; older ALP/ALPRD formats have small-block restrictions. Upgrading the target does not automatically rewrite unchanged persistent data. Use explicit attachment STORAGE_VERSION for reproducible demos, and record settings and executable provenance. Detailed links are in sources.md.

---

<!-- .slide: id="appendix-alp" -->
<p class="eyebrow">Appendix · byte layout deep dive</p>

## One ALP vector inside a segment

```text
Segment: [metadata-end][vector payloads ...][reverse vector offsets]

Vector:  [exponent][factor][exception count][frame][bit width]
         [packed integers][raw exceptions][exception positions]
```

- Internal vectors: 1,024 values in this baseline.
- Newer compatible layouts also support a raw-vector fallback.
- Fetch finds the internal vector; decoding it is not free.

<p class="source">Source: <code>alp_compress.hpp</code>; <code>alp_scan.hpp</code>; <code>alp_fetch.hpp</code></p>

Notes:
Use this only if participants want a second precise segment example after BitPacking. Read the structure from the writer rather than relying on outdated diagrams. Exponent and factor describe the scaling choice; frame and bit width describe the integer representation; exception values and positions preserve exact recovery. Reverse vector offsets permit locating an internal vector without decoding all previous vectors. The schematic omits exact field widths and alignment; sources.md points at the actual writer. Discuss which fields need bounds validation when reading malformed data.

---

<!-- .slide: id="appendix-source" -->
<p class="eyebrow">Appendix · code navigation</p>

## Where to put the first breakpoint

| Question | Entry point |
|---|---|
| Why this candidate / score? | `ColumnDataCheckpointer::DetectBestCompressionMethod` |
| Why did these values reach disk early? | `OptimisticDataWriter::FlushToDisk` |
| Why are these segments sharing a block? | `PartialBlockManager::GetBlockAllocation` |
| Why wasn't an old segment recompressed? | `ColumnDataCheckpointer::Checkpoint` |
| Who owns auxiliary pages? | `ColumnSegment::VisitBlockIds` |
| When can a retired block be reused? | `SingleFileBlockManager::WriteHeader` |

Notes:
Offer this slide as a navigation handout rather than another lecture. The checked source map includes repository-relative paths and links pinned to the exact revision. Method names are good starting points but not complete call graphs. If the audience is debugging a newer build, re-check implementations and storage gates before applying these claims. Demos capture the executable fingerprint and reported version separately from source-reference metadata so attendees can tell what was actually run.

---

<!-- .slide: id="appendix-experiments" -->
<p class="eyebrow">Appendix · follow-up investigations</p>

## Change one thing, then explain the result

- Remove intermediate checkpoints from the append exercise.
- Change thread count; compare physical locality, not just file size.
- Add skew / outliers while keeping the physical type fixed.
- Compare null distributions and nested child streams.
- Evaluate scan, point fetch, write CPU, and memory **separately**.

For performance claims: pin inputs and build, use **Hyperfine**, retain raw results, and report uncertainty.

Notes:
This is the homework slide. Keep input generation separate from measured commands and record warmup/cache/output conditions. File creation experiments need a fresh destination for each trial, while read benchmarks need a declared cache policy. Do not label sample dispersion a confidence interval. The existing workshop fixtures intentionally make no elapsed-time or speedup claims. If a new experiment exposes an unrelated bug, record it separately rather than changing the engine while teaching this deck.
