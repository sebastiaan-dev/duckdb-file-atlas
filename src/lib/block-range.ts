import { internalFreeBytes } from "./fragmentation";
import type {
  ByteRange,
  FileBlock,
  IndexInspection,
  Segment,
  StorageRole,
} from "./types";

/** What a byte inside a selected block range is used for. */
export type RangeByteKind =
  "data" | "index" | "metadata" | "unused" | "free" | "unknown";

export interface RangeOwner {
  name: string;
  /** Set for row-group owners so the UI can select the row group. */
  rowGroup?: { table: string; rowGroup: number };
  /** Measured bytes from byte ranges; never inferred from neighbours. */
  bytes: number;
  blocks: number;
}

export interface BlockRangeSummary {
  blockCount: number;
  firstId: number;
  lastId: number;
  startOffset: number;
  endOffset: number;
  totalBytes: number;
  roles: { role: StorageRole; blocks: number; bytes: number }[];
  /** Bytes by purpose across the whole selection, in display order. */
  composition: { kind: RangeByteKind; bytes: number }[];
  /** Used bytes summed over non-free blocks that record usage. */
  used: { bytes: number; ofBytes: number; blocks: number };
  /** Unused bytes inside data/index blocks with complete byte maps. */
  internalFree: { bytes: number; ofBytes: number; blocks: number };
  /** Non-free blocks whose usage is not recorded. */
  unmeasuredBlocks: number;
  freeBlocks: number;
  /** Column data (segments) per table; index bytes are listed separately. */
  tables: RangeOwner[];
  /** Keyed `table / index`. */
  indexes: RangeOwner[];
  /** Column data per row group, labelled `table · RG n`. */
  rowGroups: RangeOwner[];
  compressions: RangeOwner[];
  segmentCount: number;
}

const COMPOSITION_ORDER: RangeByteKind[] = [
  "data",
  "index",
  "metadata",
  "unused",
  "free",
  "unknown",
];
const ROLE_ORDER: StorageRole[] = [
  "data",
  "index",
  "metadata",
  "free",
  "header",
  "unknown",
];

function rangeKind(range: ByteRange): RangeByteKind {
  switch (range.kind) {
    case "segment":
    case "validity":
    case "dictionary":
      return "data";
    case "index":
      return "index";
    case "checksum":
    case "header":
    case "metadata":
      return "metadata";
    case "unused":
      return "unused";
    default:
      return "unknown";
  }
}

function addOwner(
  owners: Map<string, RangeOwner & { blockIds: Set<number> }>,
  name: string,
  bytes: number,
  blockId: number,
  rowGroup?: RangeOwner["rowGroup"],
) {
  const owner = owners.get(name) ?? {
    name,
    ...(rowGroup ? { rowGroup } : {}),
    bytes: 0,
    blocks: 0,
    blockIds: new Set<number>(),
  };
  owner.bytes += bytes;
  owner.blockIds.add(blockId);
  owners.set(name, owner);
}

function sortedOwners(
  owners: Map<string, RangeOwner & { blockIds: Set<number> }>,
): RangeOwner[] {
  return [...owners.values()]
    .map(({ blockIds, ...owner }) => ({ ...owner, blocks: blockIds.size }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

/**
 * Aggregate measured statistics for a set of physical blocks. Bytes come from
 * each block's byte ranges, so unknown regions stay unknown and owner totals
 * never estimate unrecorded segment sizes.
 */
export function summarizeBlockRange(
  blocks: readonly FileBlock[],
  segmentsById: ReadonlyMap<string, Segment>,
  indexes: readonly IndexInspection[] = [],
): BlockRangeSummary | null {
  if (!blocks.length) return null;
  const indexesById = new Map(indexes.map((index) => [index.id, index]));
  const roles = new Map<StorageRole, { blocks: number; bytes: number }>();
  const composition = new Map<RangeByteKind, number>();
  const tables = new Map<string, RangeOwner & { blockIds: Set<number> }>();
  const indexOwners = new Map<string, RangeOwner & { blockIds: Set<number> }>();
  const rowGroups = new Map<string, RangeOwner & { blockIds: Set<number> }>();
  const compressions = new Map<
    string,
    RangeOwner & { blockIds: Set<number> }
  >();
  const segments = new Set<string>();
  const used = { bytes: 0, ofBytes: 0, blocks: 0 };
  const internalFree = { bytes: 0, ofBytes: 0, blocks: 0 };
  let unmeasuredBlocks = 0;
  let startOffset = Infinity;
  let endOffset = -Infinity;
  let totalBytes = 0;
  const compose = (kind: RangeByteKind, bytes: number) => {
    if (bytes > 0) composition.set(kind, (composition.get(kind) ?? 0) + bytes);
  };

  for (const block of blocks) {
    totalBytes += block.size;
    startOffset = Math.min(startOffset, block.offset);
    endOffset = Math.max(endOffset, block.offset + block.size);
    const role = roles.get(block.role) ?? { blocks: 0, bytes: 0 };
    role.blocks++;
    role.bytes += block.size;
    roles.set(block.role, role);

    if (block.role === "free") {
      compose("free", block.size);
      continue;
    }
    if (block.usedBytes == null) unmeasuredBlocks++;
    else {
      used.bytes += block.usedBytes;
      used.ofBytes += block.size;
      used.blocks++;
    }
    let mapped = 0;
    let unused = 0;
    for (const range of block.ranges) {
      // Clip to the block so overlapping or trailing ranges never inflate totals.
      const start = Math.max(range.offset, block.offset);
      const end = Math.min(
        range.offset + range.size,
        block.offset + block.size,
      );
      const size = Math.max(0, end - start);
      if (!size) continue;
      mapped += size;
      if (range.kind === "unused") unused += size;
      compose(rangeKind(range), size);
      const segment = range.segmentId
        ? segmentsById.get(range.segmentId)
        : undefined;
      if (segment) {
        segments.add(segment.id);
        addOwner(tables, segment.table, size, block.id);
        addOwner(
          rowGroups,
          `${segment.table} · RG ${segment.rowGroup}`,
          size,
          block.id,
          { table: segment.table, rowGroup: segment.rowGroup },
        );
        if (segment.compression)
          addOwner(compressions, segment.compression, size, block.id);
      }
      if (range.indexId) {
        const index =
          indexesById.get(range.indexId) ??
          block.indexOwners?.find((owner) => owner.id === range.indexId);
        if (index) {
          addOwner(
            indexOwners,
            `${index.table} / ${index.name}`,
            size,
            block.id,
          );
        }
      }
    }
    // Same eligibility as the map's internal-free-space color, but clipped.
    if (internalFreeBytes(block) != null) {
      internalFree.bytes += unused;
      internalFree.ofBytes += block.size;
      internalFree.blocks++;
    }
    // Bytes no range describes are unknown, not free.
    compose("unknown", block.size - Math.min(block.size, mapped));
  }

  return {
    blockCount: blocks.length,
    firstId: blocks[0].id,
    lastId: blocks.at(-1)!.id,
    startOffset,
    endOffset,
    totalBytes,
    roles: ROLE_ORDER.filter((role) => roles.has(role)).map((role) => ({
      role,
      ...roles.get(role)!,
    })),
    composition: COMPOSITION_ORDER.filter((kind) => composition.has(kind)).map(
      (kind) => ({ kind, bytes: composition.get(kind)! }),
    ),
    used,
    internalFree,
    unmeasuredBlocks,
    freeBlocks: roles.get("free")?.blocks ?? 0,
    tables: sortedOwners(tables),
    indexes: sortedOwners(indexOwners),
    rowGroups: sortedOwners(rowGroups),
    compressions: sortedOwners(compressions),
    segmentCount: segments.size,
  };
}

/** Inclusive slice between two block IDs in the given (file-order) list. */
export function blocksBetween(
  ordered: readonly FileBlock[],
  anchorId: number,
  focusId: number,
): FileBlock[] {
  const anchor = ordered.findIndex((block) => block.id === anchorId);
  const focus = ordered.findIndex((block) => block.id === focusId);
  if (anchor < 0 || focus < 0) return [];
  return ordered.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1);
}
