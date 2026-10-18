import type { Segment } from "./types";

export interface RowGroupUnit {
  table: string;
  rowGroup: number;
  segments: Segment[];
}

export function buildRowGroupUnits(segments: Segment[]): RowGroupUnit[] {
  const groups = new Map<string, RowGroupUnit>();
  for (const segment of segments) {
    const key = `${segment.table}\u0000${segment.rowGroup}`;
    const group = groups.get(key) ?? {
      table: segment.table,
      rowGroup: segment.rowGroup,
      segments: [],
    };
    group.segments.push(segment);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      segments: group.segments
        .slice()
        .sort(
          (a, b) =>
            a.column.localeCompare(b.column) ||
            a.rowStart - b.rowStart ||
            a.id.localeCompare(b.id),
        ),
    }))
    .sort((a, b) => a.table.localeCompare(b.table) || a.rowGroup - b.rowGroup);
}

// Render ordinary files in full. Progressive loading is reserved for very large maps:
// 50,000 default-sized blocks occupy over 12 GiB on disk.
export const LARGE_BLOCK_COUNT = 50_000;
export const LARGE_SEGMENT_COUNT = 50_000;

export function continuousLayoutCount(
  total: number,
  large: boolean,
  requested: number,
  batchSize: number,
  revealIndex = -1,
): number {
  if (!large) return total;
  const required = Math.ceil((revealIndex + 1) / batchSize) * batchSize;
  return Math.min(total, Math.max(batchSize, requested, required));
}

export function rowCoverage(
  segments: Segment[],
): { start: number; end: number; count: number } | null {
  const native = segments.find(
    (segment) =>
      segment.rowGroupRowStart != null && segment.rowGroupRowCount != null,
  );
  if (native)
    return {
      start: native.rowGroupRowStart!,
      end: native.rowGroupRowStart! + native.rowGroupRowCount!,
      count: native.rowGroupRowCount!,
    };
  const ranges = segments
    .filter((segment) => segment.rowCount > 0)
    .map((segment) => ({
      start: segment.rowStart,
      end: segment.rowStart + segment.rowCount,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (ranges.length === 0) return null;

  let start = ranges[0].start;
  let end = ranges[0].end;
  let count = 0;
  let unionStart = start;
  let unionEnd = end;
  for (const range of ranges.slice(1)) {
    if (range.start <= unionEnd) {
      unionEnd = Math.max(unionEnd, range.end);
    } else {
      count += unionEnd - unionStart;
      unionStart = range.start;
      unionEnd = range.end;
    }
    start = Math.min(start, range.start);
    end = Math.max(end, range.end);
  }
  count += unionEnd - unionStart;
  return { start, end, count };
}

export function aggregateByteSize(segments: Segment[]): number | null {
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.byteSize == null)
  )
    return null;
  const total = segments.reduce(
    (sum, segment) => sum + (segment.byteSize ?? 0),
    0,
  );
  return Number.isSafeInteger(total) ? total : null;
}

export interface LogicalRowModel {
  group: RowGroupUnit;
  cells: Map<string, Segment[]>;
  blockIds: Set<number>;
  segmentIds: Set<string>;
  coverage: ReturnType<typeof rowCoverage>;
}
export interface LogicalTableModel {
  name: string;
  columns: { name: string; type: string }[];
  rows: LogicalRowModel[];
  segmentCount: number;
}

export interface LogicalLayoutIndex {
  columns: Map<string, { name: string; type: string }[]>;
  rows: WeakMap<RowGroupUnit, LogicalRowModel>;
}

export function createLogicalLayoutIndex(
  segments: Segment[],
): LogicalLayoutIndex {
  const byTable = new Map<string, Map<string, string>>();
  for (const segment of segments) {
    let columns = byTable.get(segment.table);
    if (!columns) byTable.set(segment.table, (columns = new Map()));
    if (!columns.has(segment.column))
      columns.set(segment.column, segment.columnType);
  }
  return {
    columns: new Map(
      [...byTable].map(([table, columns]) => [
        table,
        [...columns].map(([name, type]) => ({ name, type })),
      ]),
    ),
    rows: new WeakMap(),
  };
}

/** Cache cells per immutable row group, including when a large map appends more groups. */
export function buildLogicalTables(
  segments: Segment[],
  groups: RowGroupUnit[],
  index = createLogicalLayoutIndex(segments),
): LogicalTableModel[] {
  const tables = new Map<string, LogicalTableModel>();
  for (const group of groups) {
    let table = tables.get(group.table);
    if (!table)
      tables.set(
        group.table,
        (table = {
          name: group.table,
          columns: index.columns.get(group.table) ?? [],
          rows: [],
          segmentCount: 0,
        }),
      );
    let row = index.rows.get(group);
    if (!row) {
      const cells = new Map<string, Segment[]>(),
        blockIds = new Set<number>(),
        segmentIds = new Set<string>();
      for (const segment of group.segments) {
        let cell = cells.get(segment.column);
        if (!cell) cells.set(segment.column, (cell = []));
        cell.push(segment);
        segmentIds.add(segment.id);
        if (segment.blockId >= 0) blockIds.add(segment.blockId);
      }
      row = {
        group,
        cells,
        blockIds,
        segmentIds,
        coverage: rowCoverage(group.segments),
      };
      index.rows.set(group, row);
    }
    table.segmentCount += group.segments.length;
    table.rows.push(row);
  }
  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}
