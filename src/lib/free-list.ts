import type { FreeListState } from "./types";

export interface FreeRun {
  start: number;
  end: number;
  count: number;
  source: "serialized" | "implicit";
}
export function buildFreeRuns(state: FreeListState): FreeRun[] {
  const entries = [
    ...state.blockIds.map((id) => ({ id, source: "serialized" as const })),
    ...state.implicitBlockIds.map((id) => ({
      id,
      source: "implicit" as const,
    })),
  ].sort((a, b) => a.id - b.id);
  const runs: FreeRun[] = [];
  for (const entry of entries) {
    const previous = runs.at(-1);
    if (
      previous &&
      previous.end + 1 === entry.id &&
      previous.source === entry.source
    ) {
      previous.end = entry.id;
      previous.count++;
    } else
      runs.push({
        start: entry.id,
        end: entry.id,
        count: 1,
        source: entry.source,
      });
  }
  return runs;
}
export function filterFreeRuns(runs: FreeRun[], query: string): FreeRun[] {
  const term = query.trim().toLowerCase();
  if (!term) return runs;
  const id = /^\d+$/.test(term) ? Number(term) : null;
  return runs.filter((run) =>
    id != null
      ? id >= run.start && id <= run.end
      : `${run.source} blocks ${run.start}–${run.end}`.includes(term),
  );
}
export function metadataSlotSize(blockSize: number) {
  return Math.floor((blockSize - 8) / 64 / 8) * 8;
}

export const RUN_TILE_SIZE = 8;
export const RUN_TILE_PITCH = 10;

export function fitRunGrouping(largest: number, plotWidth: number): number {
  const capacity = Math.max(1, Math.floor((plotWidth + 2) / RUN_TILE_PITCH));
  const needed = Math.max(1, Math.ceil(largest / capacity));
  return 2 ** Math.ceil(Math.log2(needed));
}
export function runBarWidth(blocks: number, grouping: number): number {
  if (blocks <= 0) return 0;
  const cells = Math.ceil(blocks / grouping);
  const lastCount = blocks - (cells - 1) * grouping;
  return (
    (cells - 1) * RUN_TILE_PITCH +
    Math.max(2, (lastCount / grouping) * RUN_TILE_SIZE)
  );
}
export function runCell(run: FreeRun, grouping: number, index: number) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= Math.ceil(run.count / grouping)
  )
    return null;
  const first = run.start + index * grouping;
  const last = Math.min(run.end, first + grouping - 1);
  return { index, first, last, count: last - first + 1 };
}
export function hitRunCell(run: FreeRun, grouping: number, x: number) {
  if (
    !Number.isFinite(x) ||
    x < 0 ||
    x >= runBarWidth(run.count, grouping) ||
    x % RUN_TILE_PITCH >= RUN_TILE_SIZE
  )
    return null;
  return runCell(run, grouping, Math.floor(x / RUN_TILE_PITCH));
}
