import type { FileBlock, Segment } from "./types";

const physicalBlockId = (id: number) => Number.isSafeInteger(id) && id >= 0;

/** Recorded direct/auxiliary ownership only; never follows payload chains. */
export function segmentBlockIds(segment: Segment): number[] {
  return [
    ...new Set([segment.blockId, ...(segment.auxiliaryBlocks ?? [])]),
  ].filter(physicalBlockId);
}

// Inspections are immutable. Cache by the allocation-array identity so coloring
// every referenced block does not rescan a long allocation list per tile.
const memberships = new WeakMap<readonly number[], ReadonlySet<number>>();
function auxiliaryMembership(ids: readonly number[]): ReadonlySet<number> {
  let membership = memberships.get(ids);
  if (!membership) {
    membership = new Set(ids);
    memberships.set(ids, membership);
  }
  return membership;
}

export function segmentTouchesBlock(segment: Segment, id: number): boolean {
  return (
    physicalBlockId(id) &&
    (segment.blockId === id ||
      (segment.auxiliaryBlocks != null &&
        auxiliaryMembership(segment.auxiliaryBlocks).has(id)))
  );
}

/** Linear in the recorded references, not the file's block count. */
export function indexSegmentsByBlock(
  segments: readonly Segment[],
): Map<number, Segment[]> {
  const index = new Map<number, Segment[]>();
  for (const segment of segments) {
    for (const id of segmentBlockIds(segment)) {
      const owners = index.get(id);
      if (owners) owners.push(segment);
      else index.set(id, [segment]);
    }
  }
  return index;
}

/** A file-contiguous stretch of a segment's overflow allocations. */
export interface OverflowRun {
  first: FileBlock;
  last: FileBlock;
  blocks: number;
  bytes: number;
}

/**
 * Groups a segment's resolvable overflow allocations into file-contiguous runs,
 * in file order. Adjacent means consecutive IDs whose extents touch, so a run
 * maps exactly onto a block range on the physical map.
 */
export function overflowRuns(
  segment: Segment,
  blocksById: ReadonlyMap<number, FileBlock>,
): OverflowRun[] {
  const blocks = [...new Set(segment.auxiliaryBlocks ?? [])]
    .map((id) => blocksById.get(id))
    .filter((block): block is FileBlock => !!block)
    .sort((a, b) => a.offset - b.offset);
  const runs: OverflowRun[] = [];
  for (const block of blocks) {
    const run = runs.at(-1);
    if (
      run &&
      block.id === run.last.id + 1 &&
      block.offset === run.last.offset + run.last.size
    ) {
      run.last = block;
      run.blocks++;
      run.bytes += block.size;
    } else
      runs.push({ first: block, last: block, blocks: 1, bytes: block.size });
  }
  return runs;
}
