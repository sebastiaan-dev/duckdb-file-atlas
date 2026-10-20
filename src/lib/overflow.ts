import type { Segment } from "./types";

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
