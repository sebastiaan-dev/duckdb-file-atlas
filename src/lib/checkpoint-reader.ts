import {
  BinaryReader,
  readMetaPointer,
  safeInteger,
  type MetaPointer,
} from "./binary-reader";
import { decodeCatalog } from "./checkpoint-catalog";
import { readColumn, readTableStatistics } from "./checkpoint-column";
import { decodeCheckpointDeletes } from "./checkpoint-delete";
import { inspectIndexes, attachIndexRanges } from "./checkpoint-index";
import {
  mapMetadataSpan,
  refineMetadataRanges,
  type MetadataRange,
  type PhysicalChunk,
} from "./checkpoint-ranges";
import type {
  ByteRange,
  FileBlock,
  FileInspection,
  NativeRowGroup,
  Segment,
} from "./types";

const INVALID = 0xffffffffffffffffn;
const BLOCK_MASK = (1n << 56n) - 1n;
const HEADER = 12288;
const MAX_METADATA_BYTES = 128 * 1024 * 1024;

/** Metadata views retain only verified metadata blocks, never the database's data payload. */
class MetadataStore {
  readonly blocks = new Map<number, Uint8Array>();
  readonly visited = new Map<number, Set<number>>();
  readonly links = new Map<number, Set<number>>();
  readonly spans: MetadataRange[] = [];
  private readonly sources = new WeakMap<BinaryReader, PhysicalChunk[]>();
  private slots = 0;
  private traversals = 0;
  private readonly slotSize: number;
  private readonly activeCount: number;
  constructor(
    private file: File,
    private inspection: FileInspection,
    private checksum: (bytes: Uint8Array) => bigint,
  ) {
    this.slotSize = Math.floor((inspection.blockSize - 8) / 64 / 8) * 8;
    this.activeCount = inspection.headers.find(
      (header) => header.slot === inspection.activeHeader,
    )!.blockCount;
  }
  decode(raw: bigint, allowFree = false) {
    const blockId = safeInteger(raw & BLOCK_MASK),
      slot = Number(raw >> 56n);
    if (raw === INVALID || slot >= 64 || blockId >= this.activeCount)
      throw new Error("Corrupt checkpoint metadata pointer.");
    const block = this.inspection.blocks[blockId + 3];
    if (!block || (!allowFree && block.role === "free"))
      throw new Error("Corrupt checkpoint pointer references a free block.");
    return { blockId, slot };
  }
  record(reader: BinaryReader, start: number, label: string, id: string) {
    const chunks = this.sources.get(reader);
    if (!chunks) throw new Error("Corrupt checkpoint metadata provenance.");
    const spans = mapMetadataSpan(chunks, start, reader.offset, label, id);
    if (this.spans.length + spans.length > 100_000)
      throw new Error("Checkpoint metadata range work limit exceeded.");
    this.spans.push(...spans);
  }
  async open(pointer: MetaPointer): Promise<BinaryReader> {
    let raw = pointer.blockPointer;
    let offset = Math.max(8, pointer.offset);
    if (offset > this.slotSize)
      throw new Error("Corrupt checkpoint metadata offset.");
    const seen = new Set<bigint>();
    const chunks: Uint8Array[] = [];
    const sources: PhysicalChunk[] = [];
    let previousBlock: number | undefined;
    while (raw !== INVALID) {
      if (seen.has(raw) || seen.size >= 4096)
        throw new Error("Corrupt or oversized checkpoint metadata chain.");
      if (++this.traversals > 1_000_000)
        throw new Error("Checkpoint traversal work limit exceeded.");
      seen.add(raw);
      const { blockId, slot } = this.decode(raw, seen.size > 1);
      const block = this.inspection.blocks[blockId + 3];
      const slotStart = block.offset + 8 + slot * this.slotSize;
      const free =
        block.role === "free" ||
        block.ranges.some(
          (range) =>
            range.kind === "unused" &&
            range.offset <= slotStart &&
            range.offset + range.size > slotStart,
        );
      // Unchanged column streams can retain links into released checkpoint tails.
      // Limit the reader to the allocated prefix; consuming beyond it is truncation.
      if (free) {
        if (seen.size === 1)
          throw new Error(
            "Corrupt checkpoint pointer references a free metadata slot.",
          );
        break;
      }
      if (previousBlock != null) {
        let links = this.links.get(previousBlock);
        if (!links) this.links.set(previousBlock, (links = new Set()));
        links.add(blockId);
      }
      let bytes = this.blocks.get(blockId);
      if (!bytes) {
        if (
          (this.blocks.size + 1) * this.inspection.blockSize >
          MAX_METADATA_BYTES
        )
          throw new Error(
            "Checkpoint metadata exceeds the 128 MiB browser limit.",
          );
        const start = HEADER + blockId * this.inspection.blockSize;
        bytes = new Uint8Array(
          await this.file
            .slice(start, start + this.inspection.blockSize)
            .arrayBuffer(),
        );
        if (bytes.length !== this.inspection.blockSize)
          throw new Error("Truncated checkpoint metadata block.");
        const stored = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          8,
        ).getBigUint64(0, true);
        if (stored !== this.checksum(bytes.subarray(8)))
          throw new Error(
            `Corrupt checkpoint block ${blockId}: checksum mismatch.`,
          );
        this.blocks.set(blockId, bytes);
      }
      let slots = this.visited.get(blockId);
      if (!slots) this.visited.set(blockId, (slots = new Set()));
      if (!slots.has(slot) && ++this.slots > 32768)
        throw new Error("Checkpoint metadata slot limit exceeded.");
      slots.add(slot);
      const start = 8 + slot * this.slotSize;
      const next = new DataView(
        bytes.buffer,
        bytes.byteOffset + start,
        8,
      ).getBigUint64(0, true);
      chunks.push(bytes.subarray(start + offset, start + this.slotSize));
      sources.push({
        offset: block.offset + start + offset,
        length: this.slotSize - offset,
      });
      previousBlock = blockId;
      raw = next;
      offset = 8;
    }
    const reader = new BinaryReader(chunks);
    this.sources.set(reader, sources);
    return reader;
  }
}

interface RowGroup {
  start: number;
  count: number;
  columns: MetaPointer[];
  deletes: MetaPointer[];
}
function readRowGroup(reader: BinaryReader): RowGroup {
  return reader.object(() => {
    reader.field(100);
    const start = reader.uint();
    reader.field(101);
    const count = reader.uint();
    reader.field(102);
    const columns = reader.list(() => readMetaPointer(reader));
    reader.field(103);
    const deletes = reader.list(() => readMetaPointer(reader));
    if (reader.optional(104)) reader.bool();
    if (reader.optional(105)) reader.list(() => reader.unsigned());
    if (reader.optional(106)) reader.bool();
    if (reader.optional(107)) reader.list(() => reader.unsigned());
    if (!Number.isSafeInteger(start + count))
      throw new Error("Corrupt checkpoint row range.");
    return { start, count, columns, deletes };
  });
}

export async function inspectCheckpoint(
  file: File,
  physical: FileInspection,
  checksum: (bytes: Uint8Array) => bigint,
): Promise<FileInspection> {
  const active = physical.headers.find(
    (header) => header.slot === physical.activeHeader,
  )!;
  if (BigInt(active.metaBlock) === INVALID)
    return {
      ...physical,
      warnings: physical.warnings.filter(
        (w) =>
          !w.startsWith("Catalog objects") &&
          !w.startsWith("Catalog metadata chain exceeded"),
      ),
      capabilities: {
        ...physical.capabilities,
        semantic: true,
        exactSizes: true,
      },
      native: { tables: 0, rowGroups: 0, complete: true, catalog: [] },
    };
  const store = new MetadataStore(file, physical, checksum);
  const catalog = await store.open({
    blockPointer: BigInt(active.metaBlock),
    offset: 0,
  });
  const tables = decodeCatalog(catalog);
  store.record(catalog, 0, "Checkpoint catalog", "catalog");
  const rowGroupsInfo: NativeRowGroup[] = [];
  let deleteRangeCount = 0;
  const segments: Segment[] = [];
  const auxiliary = new Set<number>();
  const indexBlocks = new Set<number>();
  let rowGroups = 0;
  const catalogSummary: NonNullable<FileInspection["native"]>["catalog"] = [];
  for (const table of tables) {
    const reader = await store.open(table.pointer);
    const statsStart = reader.offset;
    readTableStatistics(
      reader,
      table.columns.map((column) => column.type),
    );
    store.record(
      reader,
      statsStart,
      `${table.name}: table statistics`,
      `stats:${table.name}`,
    );
    const countStart = reader.offset;
    const count = safeInteger(reader.fixedU64());
    store.record(
      reader,
      countStart,
      `${table.name}: row-group count`,
      `group-count:${table.name}`,
    );
    const tableSummary = {
      name: table.name,
      rows: table.totalRows,
      deletedRows: 0,
      liveRows: 0,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type.name,
      })),
      rowGroups: count,
    };
    catalogSummary.push(tableSummary);
    let physicalRows = 0;
    if (count > 100_000)
      throw new Error("Checkpoint row-group count exceeds the browser limit.");
    for (let group = 0; group < count; group++) {
      const rowStart = reader.offset;
      const row = readRowGroup(reader);
      store.record(
        reader,
        rowStart,
        `${table.name}: row group ${group}`,
        `row-group:${table.name}:${group}`,
      );
      physicalRows += row.count;
      if (!Number.isSafeInteger(physicalRows))
        throw new Error("Corrupt checkpoint row count.");
      rowGroups++;
      if (row.columns.length !== table.columns.length)
        throw new Error("Unsupported checkpoint column layout.");
      for (
        let columnIndex = 0;
        columnIndex < row.columns.length;
        columnIndex++
      ) {
        const column = table.columns[columnIndex];
        const columnReader = await store.open(row.columns[columnIndex]);
        const columnStart = columnReader.offset;
        const decoded = readColumn(columnReader, column.type, {
          table: table.name,
          column: column.name,
          rowGroup: group,
          rowStart: row.start,
          rowCount: row.count,
        });
        store.record(
          columnReader,
          columnStart,
          `${table.name}.${column.name}: column metadata (row group ${group})`,
          `column:${table.name}:${columnIndex}:${group}`,
        );
        for (const segment of decoded) {
          segment.rowGroupRowStart = row.start;
          segment.rowGroupRowCount = row.count;
          for (const blockId of segment.auxiliaryBlocks ?? []) {
            if (
              !Number.isSafeInteger(blockId) ||
              blockId < 0 ||
              blockId >= active.blockCount
            )
              throw new Error("Corrupt checkpoint overflow block pointer.");
            auxiliary.add(blockId);
          }
          segments.push(segment);
        }
        if (segments.length > 1_000_000)
          throw new Error(
            "Checkpoint segment count exceeds the browser limit.",
          );
      }
      const deleteReader = row.deletes.length
        ? await store.open(row.deletes[0])
        : null;
      const deletes = deleteReader
        ? decodeCheckpointDeletes(deleteReader, physical.vectorSize, row.count)
        : { deletedRows: 0, vectors: [] };
      if (deleteReader)
        store.record(
          deleteReader,
          0,
          `${table.name}: deletion masks (row group ${group})`,
          `deletes:${table.name}:${group}`,
        );
      deleteRangeCount += deletes.vectors.reduce(
        (sum, vector) => sum + vector.deletedRanges.length,
        0,
      );
      if (deleteRangeCount > 262_144)
        throw new Error("Checkpoint deletion range work limit exceeded.");
      tableSummary.deletedRows += deletes.deletedRows;
      tableSummary.liveRows += row.count - deletes.deletedRows;
      rowGroupsInfo.push({
        table: table.name,
        rowGroup: group,
        rowStart: row.start,
        physicalRows: row.count,
        deletedRows: deletes.deletedRows,
        liveRows: row.count - deletes.deletedRows,
        deleteVectors: deletes.vectors,
      });
    }
    if (physicalRows !== table.totalRows)
      throw new Error(
        `Corrupt checkpoint: ${table.name} row-group counts disagree with its catalog.`,
      );
    for (const index of table.indexes) {
      for (const allocator of index.allocatorInfos) {
        for (const pointer of allocator.blockPointers) {
          if (pointer.blockId < -1)
            throw new Error("Corrupt checkpoint index block pointer.");
          if (pointer.blockId >= 0) indexBlocks.add(pointer.blockId);
        }
      }
    }
  }
  let blocks = physical.blocks.map((block) => ({
    ...block,
    ranges: block.ranges.map((range) => ({ ...range })),
    ...(block.overflowSegmentIds
      ? { overflowSegmentIds: [...block.overflowSegmentIds] }
      : {}),
    segmentIds: [...block.segmentIds],
    links: [...block.links],
  }));
  for (const [id, bytes] of store.blocks) {
    const block = blocks[id + 3];
    if (!block || block.role === "free")
      throw new Error("Corrupt checkpoint metadata allocation.");
    block.role = "metadata";
    block.label = `Verified checkpoint metadata block ${id}`;
    block.checksum = `0x${new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true).toString(16).padStart(16, "0")}`;
    block.links = [
      ...new Set([...block.links, ...(store.links.get(id) ?? [])]),
    ];
    // The allocator's slot masks are authoritative; traversed slots cannot be declared free.
    for (const slot of store.visited.get(id) ?? []) {
      const start =
        block.offset +
        8 +
        slot * Math.floor((physical.blockSize - 8) / 64 / 8) * 8;
      if (
        block.ranges.some(
          (range) =>
            range.kind === "unused" &&
            range.offset <= start &&
            range.offset + range.size > start,
        )
      )
        throw new Error("Corrupt checkpoint: reachable metadata slot is free.");
    }
    if (block.ranges.every((range) => range.kind !== "unknown"))
      block.usedBytes = block.ranges
        .filter((range) => range.kind !== "unused")
        .reduce((sum, range) => sum + range.size, 0);
  }
  for (const id of indexBlocks) {
    const block = blocks[id + 3];
    if (
      !block ||
      block.id !== id ||
      block.role === "free" ||
      block.role === "metadata"
    )
      throw new Error("Corrupt checkpoint auxiliary block pointer.");
    block.role = "index";
    block.label = "Index allocation";
  }
  attachNativeSegments(blocks, segments, auxiliary, indexBlocks);
  blocks = refineMetadataRanges(blocks, store.spans);
  const indexes = await inspectIndexes(
    file,
    { ...physical, blocks },
    tables.flatMap((table) =>
      table.indexes.map((index) => ({ table: table.name, index })),
    ),
    checksum,
  );
  attachIndexRanges(blocks, indexes);
  const warnings = physical.warnings.filter(
    (w) =>
      !w.startsWith("Catalog objects") &&
      !w.startsWith("Catalog metadata chain exceeded"),
  );
  warnings.push(
    "Catalog, row groups, compression, segment statistics, and recorded segment byte sizes were read directly from the checkpoint. Compressed values are not decoded.",
  );
  if (segments.some((segment) => segment.byteSize == null))
    warnings.push(
      "Some segment byte sizes are absent in the checkpoint; affected block gaps remain unknown.",
    );
  if (indexes.length)
    warnings.push(
      "Index ownership and supported allocator masks were inspected; occupied slots are measured, but ART node contents and key values are not decoded.",
    );
  if (indexes.some((index) => !index.complete))
    warnings.push(
      "Some index layouts are unsupported or exceed bounded inspection; their occupancy remains unknown.",
    );
  if (auxiliary.size)
    warnings.push(
      "Overflow allocations are identified, but their internal free bytes are not measured.",
    );
  return {
    ...physical,
    blocks,
    indexes,
    segments,
    warnings,
    capabilities: {
      ...physical.capabilities,
      semantic: true,
      exactSizes: segments.every((segment) => segment.byteSize != null),
    },
    native: {
      tables: tables.length,
      rowGroups,
      complete: true,
      rowGroupsInfo,
      catalog: catalogSummary,
    },
  };
}

export function attachNativeSegments(
  blocks: FileBlock[],
  segments: Segment[],
  auxiliary: Set<number> = new Set(),
  indexBlocks: Set<number> = new Set(),
) {
  const byBlock = new Map<number, Segment[]>();
  const overflowOwners = new Map<number, Set<string>>();
  // Validate every recorded auxiliary pointer, even for sentinel segments.
  // Do not mutate the caller's set or infer links from ownership records.
  const overflowBlocks = new Set(auxiliary);
  for (const segment of segments) {
    for (const id of segment.auxiliaryBlocks ?? []) {
      overflowBlocks.add(id);
      const owners = overflowOwners.get(id) ?? new Set<string>();
      owners.add(segment.id);
      overflowOwners.set(id, owners);
    }
  }
  for (const id of overflowBlocks) {
    const block = blocks[id + 3];
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !block ||
      block.id !== id ||
      block.size <= 8 ||
      block.role === "free" ||
      block.role === "metadata" ||
      block.role === "header" ||
      block.role === "index" ||
      indexBlocks.has(id)
    )
      throw new Error("Corrupt checkpoint overflow block pointer.");
  }
  for (const segment of segments) {
    if (segment.blockId === -1) {
      if (
        !["Constant", "Empty Validity"].includes(segment.compression) ||
        segment.offset !== 8
      )
        throw new Error("Corrupt checkpoint constant sentinel pointer.");
      if (segment.byteSize != null && segment.byteSize !== 0)
        throw new Error(
          `Corrupt checkpoint constant segment size: ${segment.id} ${segment.compression} ${segment.byteSize}.`,
        );
      continue;
    }
    if (
      !Number.isSafeInteger(segment.blockId) ||
      segment.blockId < 0 ||
      !Number.isSafeInteger(segment.offset) ||
      (segment.byteSize != null && !Number.isSafeInteger(segment.byteSize))
    )
      throw new Error("Corrupt checkpoint segment pointer.");
    const block = blocks[segment.blockId + 3];
    if (
      !block ||
      block.id !== segment.blockId ||
      block.role === "free" ||
      block.role === "metadata" ||
      segment.offset < 8 ||
      segment.offset >= block.size ||
      (segment.byteSize != null &&
        (segment.byteSize < 0 ||
          segment.offset + segment.byteSize > block.size))
    )
      throw new Error("Corrupt checkpoint segment bounds.");
    const items = byBlock.get(block.id) ?? [];
    items.push(segment);
    byBlock.set(block.id, items);
  }
  for (const id of overflowBlocks) {
    const block = blocks[id + 3];
    block.overflowSegmentIds = [...(overflowOwners.get(id) ?? [])];
    if (byBlock.has(id)) continue;
    block.role = "overflow";
    block.label = "String overflow allocation";
    block.segmentIds = [];
    block.usedBytes = null;
    block.ranges = [
      {
        id: `native:${id}:checksum`,
        label: block.checksum ? "Verified checksum" : "Checksum (unverified)",
        offset: block.offset,
        size: 8,
        kind: "checksum",
      },
      {
        id: `native:${id}:overflow`,
        label: "Unclassified overflow bytes",
        offset: block.offset + 8,
        size: block.size - 8,
        kind: "unknown",
      },
    ];
  }
  for (const [id, items] of byBlock) {
    const block = blocks[id + 3];
    block.role = "data";
    block.label = `Table data · ${items.length} segment${items.length === 1 ? "" : "s"}`;
    block.segmentIds = items.map((segment) => segment.id);
    const known = items
      .filter((segment) => segment.byteSize != null && segment.byteSize > 0)
      .sort((a, b) => a.offset - b.offset);
    let end = 8;
    for (const segment of known) {
      if (segment.offset < end)
        throw new Error("Corrupt checkpoint: overlapping segment extents.");
      end = segment.offset + segment.byteSize!;
    }
    const complete =
      items.every((segment) => segment.byteSize != null) &&
      !overflowBlocks.has(id) &&
      !indexBlocks.has(id);
    const ranges: ByteRange[] = [
      {
        id: `native:${id}:checksum`,
        label: block.checksum ? "Verified checksum" : "Checksum (unverified)",
        offset: block.offset,
        size: 8,
        kind: "checksum",
      },
    ];
    let cursor = 8;
    for (const segment of known) {
      if (segment.offset > cursor)
        ranges.push({
          id: `native:${id}:gap:${cursor}`,
          label: complete
            ? "Gap between segment allocations"
            : "Unclassified bytes",
          offset: block.offset + cursor,
          size: segment.offset - cursor,
          kind: complete ? "unused" : "unknown",
        });
      ranges.push({
        id: `native:${segment.id}`,
        label: `${segment.table}.${segment.column} · ${segment.compression}`,
        offset: block.offset + segment.offset,
        size: segment.byteSize!,
        kind: segment.columnType === "VALIDITY" ? "validity" : "segment",
        segmentId: segment.id,
      });
      cursor = segment.offset + segment.byteSize!;
    }
    if (cursor < block.size)
      ranges.push({
        id: `native:${id}:tail`,
        label: complete ? "Unallocated block tail" : "Unclassified bytes",
        offset: block.offset + cursor,
        size: block.size - cursor,
        kind: complete ? "unused" : "unknown",
      });
    block.ranges = ranges;
    block.usedBytes = complete
      ? 8 + known.reduce((sum, segment) => sum + segment.byteSize!, 0)
      : null;
  }
}
