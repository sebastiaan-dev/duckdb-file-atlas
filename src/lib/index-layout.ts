import type { IndexAllocator, IndexBuffer, IndexInspection } from "./types";

export const INDEX_ROW_LIMIT = 32;
export const BUFFER_TILE_LIMIT = 256;
export const BUFFER_FULL_LIMIT = 1024;
export const initialBufferCount = (count: number) =>
  count <= BUFFER_FULL_LIMIT ? count : BUFFER_TILE_LIMIT;
export const RAW_LINK_LIMIT = 32;

export const formatIndexBytes = (value: number | null) =>
  value == null
    ? "Unknown"
    : value < 1024
      ? `${value.toLocaleString()} B`
      : value < 1024 ** 2
        ? `${(value / 1024).toFixed(1)} KiB`
        : value < 1024 ** 3
          ? `${(value / 1024 ** 2).toFixed(1)} MiB`
          : `${(value / 1024 ** 3).toFixed(1)} GiB`;

/** Catalog counters from a partial scan are not occupancy measurements. */
export function isMeasuredIndex(index: IndexInspection): boolean {
  return (
    index.complete &&
    [
      index.occupiedBytes,
      index.freeBytes,
      index.maskOverheadBytes,
      index.allocationBytes,
    ].every((value) => value != null && Number.isFinite(value) && value >= 0)
  );
}

export function indexMeasurements(indexes: IndexInspection[]) {
  const measured = indexes.filter(isMeasuredIndex);
  const totals = measured.reduce(
    (total, index) => ({
      occupiedBytes: total.occupiedBytes + index.occupiedBytes!,
      freeBytes: total.freeBytes + index.freeBytes!,
      maskOverheadBytes: total.maskOverheadBytes + index.maskOverheadBytes!,
      allocationBytes: total.allocationBytes + index.allocationBytes!,
    }),
    {
      occupiedBytes: 0,
      freeBytes: 0,
      maskOverheadBytes: 0,
      allocationBytes: 0,
    },
  );
  return {
    measuredCount: measured.length,
    totals,
    // This baseline always includes the full inspection, never search results.
    axisMax: measured.reduce(
      (max, index) => Math.max(max, index.allocationBytes!),
      0,
    ),
  };
}

export type AllocatorMetric = "bytes" | "slots";
export function rankAllocators(
  index: IndexInspection,
  metric: AllocatorMetric,
): IndexAllocator[] {
  if (!isMeasuredIndex(index)) return [];
  return index.allocators
    .filter((allocator) => allocator.buffers.length > 0)
    .slice()
    .sort(
      (a, b) =>
        allocatorValue(b, metric) - allocatorValue(a, metric) ||
        a.ordinal - b.ordinal,
    );
}
export function allocatorValue(
  allocator: IndexAllocator,
  metric: AllocatorMetric,
): number {
  return metric === "bytes" ? allocator.occupiedBytes : allocator.occupiedSlots;
}
export interface BufferTile {
  key: string;
  allocator: IndexAllocator;
  buffer: IndexBuffer;
}
export function sortedIndexBuffers(index: IndexInspection): BufferTile[] {
  if (!isMeasuredIndex(index)) return [];
  return index.allocators
    .flatMap((allocator) =>
      allocator.buffers.map((buffer) => ({
        key: `${allocator.ordinal}:${buffer.bufferId}`,
        allocator,
        buffer,
      })),
    )
    .sort(
      (a, b) =>
        a.buffer.absoluteOffset - b.buffer.absoluteOffset ||
        a.allocator.ordinal - b.allocator.ordinal ||
        a.buffer.bufferId - b.buffer.bufferId,
    );
}
export function bufferOccupancy(buffer: IndexBuffer): number | null {
  return buffer.storedSlots > 0
    ? Math.max(0, Math.min(1, buffer.segmentCount / buffer.storedSlots))
    : null;
}
/** Fixed ramp, independent of index, allocator filter, pagination, or search. */
export function occupancyColor(ratio: number | null): string {
  return ratio == null
    ? "var(--chart-unknown)"
    : `color-mix(in srgb, var(--index-occupied) ${ratio * 100}%, var(--index-empty))`;
}
export function moveBufferFocus(
  position: number,
  key: string,
  columns: number,
  length: number,
): number {
  const delta =
    key === "ArrowRight"
      ? 1
      : key === "ArrowLeft"
        ? -1
        : key === "ArrowDown"
          ? columns
          : key === "ArrowUp"
            ? -columns
            : 0;
  return key === "Home"
    ? 0
    : key === "End"
      ? Math.max(0, length - 1)
      : Math.max(0, Math.min(length - 1, position + delta));
}
