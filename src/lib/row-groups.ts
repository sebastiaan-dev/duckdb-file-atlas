export { rowGroupColor, rowGroupShade, ROW_GROUP_SHADE_COUNT } from "./palette";
import type { FileBlock, NativeRowGroup, Segment } from "./types";

export type { RowGroupRef } from "./palette";
import type { RowGroupRef } from "./palette";

export const rowGroupKey = ({ table, rowGroup }: RowGroupRef) =>
  JSON.stringify([table, rowGroup]);

export const rowGroupLabel = ({ table, rowGroup }: RowGroupRef) =>
  `${table} · RG ${rowGroup}`;

export interface RowGroupSummary extends RowGroupRef {
  segments: number;
  /** Segments stored inline in metadata (constants); they occupy no block. */
  constantSegments: number;
  columns: number;
  /** Known segment bytes; segments without a recorded size are counted apart. */
  dataBytes: number;
  unknownSizeSegments: number;
  /** Blocks holding this row group's segments or their string overflow. */
  blockIds: number[];
  overflowBlocks: number;
  blockBytes: number;
  /** First touched byte to the end of the last touched block. */
  startOffset: number | null;
  endOffset: number | null;
  /** Maximal runs of adjacent blocks in file order; 1 means contiguous. */
  runs: number;
  /** Touched blocks that also store other row groups. */
  sharedBlocks: number;
  rows?: Pick<
    NativeRowGroup,
    "physicalRows" | "liveRows" | "deletedRows" | "rowStart"
  >;
}

/**
 * Where one row group lives on disk. `ordered` is the data blocks in file
 * order, so runs follow physical adjacency rather than block IDs.
 */
export function summarizeRowGroup(
  ref: RowGroupRef,
  segments: readonly Segment[],
  ordered: readonly FileBlock[],
  segmentsByBlock: ReadonlyMap<number, readonly Segment[]>,
  rowGroupsInfo: readonly NativeRowGroup[] = [],
): RowGroupSummary | null {
  const own = segments.filter(
    (segment) =>
      segment.table === ref.table && segment.rowGroup === ref.rowGroup,
  );
  if (!own.length) return null;
  const direct = new Set<number>();
  const overflow = new Set<number>();
  let dataBytes = 0;
  let unknownSizeSegments = 0;
  let constantSegments = 0;
  for (const segment of own) {
    if (segment.blockId >= 0) direct.add(segment.blockId);
    else constantSegments++;
    for (const id of segment.auxiliaryBlocks ?? []) overflow.add(id);
    if (segment.blockId < 0) continue;
    if (segment.byteSize == null) unknownSizeSegments++;
    else dataBytes += segment.byteSize;
  }
  const touched = new Set([...direct, ...overflow]);
  const index = new Map(ordered.map((block, i) => [block.id, i]));
  const positions = [...touched]
    .map((id) => index.get(id))
    .filter((position): position is number => position != null)
    .sort((a, b) => a - b);
  let runs = 0;
  positions.forEach((position, i) => {
    if (i === 0 || position !== positions[i - 1] + 1) runs++;
  });
  const blocks = positions.map((position) => ordered[position]);
  const key = rowGroupKey(ref);
  const sharedBlocks = blocks.filter((block) =>
    (segmentsByBlock.get(block.id) ?? []).some(
      (segment) => rowGroupKey(segment) !== key,
    ),
  ).length;
  const info = rowGroupsInfo.find(
    (row) => row.table === ref.table && row.rowGroup === ref.rowGroup,
  );
  return {
    ...ref,
    segments: own.length,
    constantSegments,
    columns: new Set(own.map((segment) => segment.column)).size,
    dataBytes,
    unknownSizeSegments,
    blockIds: blocks.map((block) => block.id),
    overflowBlocks: [...overflow].filter((id) => !direct.has(id)).length,
    blockBytes: blocks.reduce((sum, block) => sum + block.size, 0),
    startOffset: blocks.length ? blocks[0].offset : null,
    endOffset: blocks.length
      ? Math.max(...blocks.map((block) => block.offset + block.size))
      : null,
    runs,
    sharedBlocks,
    rows: info && {
      physicalRows: info.physicalRows,
      liveRows: info.liveRows,
      deletedRows: info.deletedRows,
      rowStart: info.rowStart,
    },
  };
}
