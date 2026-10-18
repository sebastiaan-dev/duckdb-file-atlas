import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  BUFFER_TILE_LIMIT,
  initialBufferCount,
  bufferOccupancy,
  formatIndexBytes as bytes,
  moveBufferFocus,
  occupancyColor,
  type BufferTile,
} from "@/lib/index-layout";

function describe(tile: BufferTile) {
  const { allocator, buffer } = tile;
  const ratio = bufferOccupancy(buffer);
  return `${allocator.nodeType} · buffer ${buffer.bufferId} · ${buffer.segmentCount.toLocaleString()} occupied / ${buffer.storedSlots.toLocaleString()} stored slots · ${ratio == null ? "no stored slots" : `${(ratio * 100).toFixed(1)}% occupied`} · ${bytes(buffer.occupiedBytes)} occupied · ${bytes(buffer.freeBytes)} free holes · ${bytes(allocator.maskBytes)} mask · ${bytes(buffer.allocationSize)} envelope · block ${buffer.blockId} · offset 0x${buffer.absoluteOffset.toString(16)}`;
}

export function IndexBufferMap({
  tiles,
  totalBuffers,
  selectedBlockId,
  onPick,
}: {
  tiles: BufferTile[];
  totalBuffers: number;
  selectedBlockId?: number | null;
  onPick: (id: number) => void;
}) {
  const [visible, setVisible] = useState(() =>
    initialBufferCount(tiles.length),
  );
  const [focus, setFocus] = useState(0);
  const [active, setActive] = useState<BufferTile | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setVisible(initialBufferCount(tiles.length));
    setFocus(0);
    setActive(null);
    setPicked(null);
  }, [tiles]);
  const pickedBlock = useMemo(
    () => tiles.find((tile) => tile.key === picked)?.buffer.blockId,
    [tiles, picked],
  );
  // A specific tile stays selected while drilling its block. An external block
  // selection supersedes it; all matching visible buffers then indicate ownership.
  const selectedKey =
    selectedBlockId === undefined || pickedBlock === selectedBlockId
      ? picked
      : null;
  const shown = useMemo(() => tiles.slice(0, visible), [tiles, visible]);
  const descriptions = useMemo(() => shown.map(describe), [shown]);
  const fills = useMemo(
    () => shown.map((tile) => occupancyColor(bufferOccupancy(tile.buffer))),
    [shown],
  );
  return (
    <section
      className="index-graph index-buffer-graph"
      aria-label="Buffer occupancy"
    >
      <div className="index-graph-heading">
        <h4>3 · Buffer occupancy</h4>
        <span>
          {tiles.length.toLocaleString()} of {totalBuffers.toLocaleString()}{" "}
          buffers
        </span>
      </div>
      <p className="section-caption">
        One tile per buffer · file-offset order. Color is occupied / stored
        slots, not node-child fullness.
      </p>
      <div className="index-occupancy-legend">
        <span>0%</span>
        <i />
        <span>100%</span>
        <span>Fixed occupancy scale</span>
      </div>
      {!tiles.length ? (
        <p className="section-caption">
          No persisted buffers in this selection. Empty or inlined roots need no
          allocator storage.
        </p>
      ) : (
        <>
          <div
            className="index-buffer-grid"
            ref={grid}
            role="group"
            aria-label="Buffers in file-offset order"
          >
            {shown.map((tile, position) => (
              <button
                type="button"
                className="index-buffer-tile"
                key={tile.key}
                tabIndex={position === focus ? 0 : -1}
                aria-label={descriptions[position]}
                aria-pressed={
                  selectedKey === tile.key ||
                  (selectedKey == null &&
                    selectedBlockId === tile.buffer.blockId)
                }
                data-offset={tile.buffer.absoluteOffset}
                data-allocator={tile.allocator.ordinal}
                style={{
                  background: fills[position],
                }}
                onPointerEnter={() => setActive(tile)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => {
                  setFocus(position);
                  setActive(tile);
                }}
                onBlur={() => setActive(null)}
                onClick={() => {
                  setFocus(position);
                  setPicked(tile.key);
                  setActive(tile);
                  onPick(tile.buffer.blockId);
                }}
                onKeyDown={(event) => {
                  if (
                    ![
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      "Home",
                      "End",
                    ].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  const columns = grid.current
                    ? getComputedStyle(grid.current).gridTemplateColumns.split(
                        " ",
                      ).length
                    : 1;
                  const next = moveBufferFocus(
                    position,
                    event.key,
                    columns,
                    shown.length,
                  );
                  setFocus(next);
                  (
                    grid.current?.children[next] as
                      HTMLButtonElement | undefined
                  )?.focus();
                }}
              />
            ))}
          </div>
          <div className="index-buffer-hint" aria-live="polite">
            {active ? (
              <span role="tooltip">{describe(active)}</span>
            ) : (
              <span>
                Hover or focus a buffer for counters and offsets. Arrow keys
                navigate; Enter / Space opens its physical block.
              </span>
            )}
          </div>
          <div className="index-progress">
            <span>
              {shown.length.toLocaleString()} of {tiles.length.toLocaleString()}{" "}
              tiles shown; counts and colors cover the full selection.
            </span>
            {visible < tiles.length && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVisible(visible + BUFFER_TILE_LIMIT)}
              >
                Load more buffers
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
