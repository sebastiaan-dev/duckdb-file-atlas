/** Physical-map geometry: a fixed label gutter and square, unstretched tiles. */
export function heatmapLayout(width: number, requestedCellSize: number) {
  const cellSize = Number.isFinite(requestedCellSize)
    ? Math.max(4, Math.min(24, requestedCellSize))
    : 8;
  const gap = cellSize < 8 ? 1 : 2;
  const availableWidth = Math.max(
    0,
    (Number.isFinite(width) ? width : 0) - 44 - 7,
  );
  const pitch = cellSize + gap;
  const columns = Math.max(1, Math.floor((availableWidth + gap) / pitch));
  // Monospace 9px axis labels need room for '+' and every column-index digit.
  const tickWidth = (Math.max(2, String(columns - 1).length) + 1) * 6 + 6;
  return {
    cellSize,
    gap,
    columns,
    gridWidth: columns * pitch - gap,
    labelStride: Math.ceil(14 / pitch),
    tickStride: Math.ceil(tickWidth / pitch),
  };
}
