import type { ByteRange, FileBlock } from "./types";

/** A reader payload chunk; excludes the slot link header and block checksum. */
export interface PhysicalChunk {
  offset: number;
  length: number;
}

export interface MetadataOwner {
  id: string;
  label: string;
}

/** Optional provenance survives repeated/shared stream consumption. */
export interface MetadataRange extends ByteRange {
  metadataOwners?: readonly MetadataOwner[];
}

function corrupt(message: string): never {
  throw new Error(`Corrupt checkpoint metadata ranges: ${message}`);
}

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) corrupt(`invalid ${label}`);
}

function end(offset: number, size: number, label: string): number {
  integer(offset, `${label} offset`);
  integer(size, `${label} size`);
  const result = offset + size;
  integer(result, `${label} end`);
  return result;
}

/** Map only a successfully consumed logical [start, end) span, not stream capacity. */
export function mapMetadataSpan(
  chunks: readonly PhysicalChunk[],
  logicalStart: number,
  logicalEnd: number,
  label: string,
  id: string,
): MetadataRange[] {
  integer(logicalStart, "logical start");
  integer(logicalEnd, "logical end");
  if (logicalEnd < logicalStart) corrupt("reversed logical span");
  let total = 0;
  const physical = chunks
    .map((chunk) => {
      const chunkEnd = end(chunk.offset, chunk.length, "chunk");
      total = end(total, chunk.length, "logical stream");
      return { offset: chunk.offset, end: chunkEnd };
    })
    .filter((chunk) => chunk.end > chunk.offset);
  physical.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < physical.length; i++) {
    if (physical[i].offset < physical[i - 1].end)
      corrupt("overlapping physical chunks");
  }
  if (logicalEnd > total) corrupt("logical span exceeds available payload");
  const result: MetadataRange[] = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length && cursor < logicalEnd; i++) {
    const chunk = chunks[i];
    const start = Math.max(logicalStart, cursor);
    const stop = Math.min(logicalEnd, cursor + chunk.length);
    if (stop > start) {
      result.push({
        id: `${id}:chunk-${i}:${start}`,
        label,
        offset: chunk.offset + start - cursor,
        size: stop - start,
        kind: "metadata",
        metadataOwners: [{ id, label }],
      });
    }
    cursor += chunk.length;
  }
  return result;
}

interface SpanUnion {
  offset: number;
  end: number;
  id: string;
  label: string;
  metadataOwners: readonly MetadataOwner[];
}

function ownersOf(span: MetadataRange): readonly MetadataOwner[] {
  return span.metadataOwners?.length
    ? span.metadataOwners
    : [{ id: span.id, label: span.label }];
}

/** Collapse connected overlaps, not adjacency. No arbitrary nested-span priority. */
function unionSpans(spans: readonly MetadataRange[]): SpanUnion[] {
  const result: SpanUnion[] = [];
  let index = 0;
  while (index < spans.length) {
    const first = spans[index++];
    let stop = first.offset + first.size;
    let shared = false;
    const owners = new Map<string, MetadataOwner>();
    const addOwners = (span: MetadataRange) => {
      for (const owner of ownersOf(span)) {
        owners.set(JSON.stringify([owner.id, owner.label]), { ...owner });
      }
    };
    addOwners(first);
    while (index < spans.length && spans[index].offset < stop) {
      const span = spans[index++];
      if (
        span.offset !== first.offset ||
        span.size !== first.size ||
        span.label !== first.label
      )
        shared = true;
      stop = Math.max(stop, span.offset + span.size);
      addOwners(span);
    }
    result.push({
      offset: first.offset,
      end: stop,
      id: first.id,
      label: shared ? "Shared checkpoint metadata" : first.label,
      metadataOwners: Array.from(owners.values()),
    });
  }
  return result;
}

/**
 * Return refined blocks without mutating the input. Existing ranges must form
 * complete partitions. Only checksum-verified metadata blocks can be refined;
 * checksum, free/unused, data and header bytes are never reclassified.
 * Allocator usedBytes and all unconsumed classifications remain unchanged.
 * Throws on invalid spans rather than silently hiding corrupt provenance.
 * Work is O(B log B + R log R + S log S + output), with linear sweep joins.
 */
export function refineMetadataRanges(
  blocks: readonly FileBlock[],
  spans: readonly MetadataRange[],
): FileBlock[] {
  const orderedBlocks = blocks
    .map((block, index) => ({
      block,
      index,
      end: end(block.offset, block.size, "block"),
      ranges: [...block.ranges].sort((a, b) => a.offset - b.offset),
      spans: [] as MetadataRange[],
    }))
    .sort((a, b) => a.block.offset - b.block.offset);
  for (let i = 0; i < orderedBlocks.length; i++) {
    const item = orderedBlocks[i];
    if (i && item.block.offset < orderedBlocks[i - 1].end)
      corrupt("overlapping blocks");
    let cursor = item.block.offset;
    for (const range of item.ranges) {
      const stop = end(range.offset, range.size, "existing range");
      if (!range.size || range.offset !== cursor || stop > item.end)
        corrupt("existing ranges are not a complete disjoint partition");
      cursor = stop;
    }
    if (cursor !== item.end) corrupt("existing ranges do not cover block");
  }
  const orderedSpans = [...spans];
  for (const span of orderedSpans) {
    end(span.offset, span.size, "span");
    if (!span.size || span.kind !== "metadata")
      corrupt("expected nonempty metadata span");
  }
  orderedSpans.sort(
    (a, b) =>
      a.offset - b.offset ||
      a.size - b.size ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
  let blockIndex = 0;
  for (const span of orderedSpans) {
    while (
      blockIndex < orderedBlocks.length &&
      orderedBlocks[blockIndex].end <= span.offset
    )
      blockIndex++;
    const item = orderedBlocks[blockIndex];
    if (
      !item ||
      span.offset < item.block.offset ||
      span.offset + span.size > item.end
    )
      corrupt("span outside a single physical block");
    if (item.block.role !== "metadata" || item.block.checksum === undefined)
      corrupt("span in unverified or non-metadata block");
    item.spans.push(span);
  }
  const result = [...blocks];
  for (const item of orderedBlocks) {
    if (!item.spans.length) continue;
    const unions = unionSpans(item.spans);
    const ranges: MetadataRange[] = [];
    let unionIndex = 0;
    for (const base of item.ranges) {
      const baseEnd = base.offset + base.size;
      let cursor = base.offset;
      while (
        unionIndex < unions.length &&
        unions[unionIndex].offset < baseEnd
      ) {
        const span = unions[unionIndex];
        if (span.end <= cursor) {
          unionIndex++;
          continue;
        }
        if (base.kind !== "metadata" && base.kind !== "unknown")
          corrupt(`span overlaps protected ${base.kind} bytes`);
        const start = Math.max(cursor, span.offset);
        const stop = Math.min(baseEnd, span.end);
        if (start > cursor)
          ranges.push({
            ...base,
            id: `${base.id}:remainder-${cursor}`,
            offset: cursor,
            size: start - cursor,
          });
        ranges.push({
          id: `${span.id}:physical-${start}`,
          label: span.label,
          offset: start,
          size: stop - start,
          kind: "metadata",
          metadataOwners: span.metadataOwners,
        });
        cursor = stop;
        if (span.end <= baseEnd) unionIndex++;
        else break;
      }
      if (cursor < baseEnd)
        ranges.push(
          cursor === base.offset
            ? base
            : {
                ...base,
                id: `${base.id}:remainder-${cursor}`,
                offset: cursor,
                size: baseEnd - cursor,
              },
        );
    }
    result[item.index] = { ...item.block, ranges };
  }
  return result;
}
