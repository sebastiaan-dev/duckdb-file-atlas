import {
  BinaryReader,
  readMetaPointer,
  safeInteger,
  type MetaPointer,
} from "./binary-reader";
import { decodeCatalog } from "./checkpoint-catalog";
import { readColumn, readTableStatistics } from "./checkpoint-column";
import type { ByteRange, FileBlock, FileInspection, Segment } from "./types";

const INVALID = 0xffffffffffffffffn;
const BLOCK_MASK = (1n << 56n) - 1n;
const HEADER = 12288;
const MAX_METADATA_BYTES = 128 * 1024 * 1024;

/** Metadata views retain only verified metadata blocks, never the database's data payload. */
class MetadataStore {
  readonly blocks = new Map<number, Uint8Array>();
  readonly visited = new Map<number, Set<number>>();
  readonly links = new Map<number, Set<number>>();
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
  async open(pointer: MetaPointer): Promise<BinaryReader> {
    let raw = pointer.blockPointer;
    let offset = Math.max(8, pointer.offset);
    if (offset > this.slotSize)
      throw new Error("Corrupt checkpoint metadata offset.");
    const seen = new Set<bigint>();
    const chunks: Uint8Array[] = [];
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
      previousBlock = blockId;
      raw = next;
      offset = 8;
    }
    return new BinaryReader(chunks);
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
  const segments: Segment[] = [];
  const auxiliary = new Set<number>();
  const indexBlocks = new Set<number>();
  let rowGroups = 0;
  const catalogSummary: NonNullable<FileInspection["native"]>["catalog"] = [];
  for (const table of tables) {
    const reader = await store.open(table.pointer);
    readTableStatistics(
      reader,
      table.columns.map((column) => column.type),
    );
    const count = safeInteger(reader.fixedU64());
    catalogSummary.push({
      name: table.name,
      rows: table.totalRows,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type.name,
      })),
      rowGroups: count,
    });
    if (count > 100_000)
      throw new Error("Checkpoint row-group count exceeds the browser limit.");
    for (let group = 0; group < count; group++) {
      const row = readRowGroup(reader);
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
        const decoded = readColumn(columnReader, column.type, {
          table: table.name,
          column: column.name,
          rowGroup: group,
          rowStart: row.start,
          rowCount: row.count,
        });
        for (const segment of decoded) {
          segment.rowGroupRowStart = row.start;
          segment.rowGroupRowCount = row.count;
          for (const blockId of segment.auxiliaryBlocks ?? []) {
            if (!Number.isSafeInteger(blockId) || blockId < 0)
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
      for (const pointer of row.deletes) await store.open(pointer);
    }
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
  const blocks = physical.blocks.map((block) => ({
    ...block,
    ranges: block.ranges.map((range) => ({ ...range })),
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
  for (const id of new Set([...auxiliary, ...indexBlocks])) {
    const block = blocks[id + 3];
    if (
      !block ||
      block.id !== id ||
      block.role === "free" ||
      block.role === "metadata"
    )
      throw new Error("Corrupt checkpoint auxiliary block pointer.");
    block.role = indexBlocks.has(id) ? "index" : "data";
    block.label = indexBlocks.has(id)
      ? "Index allocation"
      : "String overflow allocation";
  }
  attachNativeSegments(blocks, segments, auxiliary, indexBlocks);
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
  if (auxiliary.size || indexBlocks.size)
    warnings.push(
      "Index and overflow allocations are identified, but their internal free bytes are not measured.",
    );
  return {
    ...physical,
    blocks,
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
      !auxiliary.has(id) &&
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
    for (const segment of items)
      block.links.push(...(segment.auxiliaryBlocks ?? []));
    block.links = [...new Set(block.links)];
  }
}
