import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DetailBody,
  InfoTip,
  TipContent,
} from "@/components/detail-tooltip";
import {
  BUFFER_TILE_LIMIT,
  initialBufferCount,
  bufferFill,
  bufferOccupancy,
  formatIndexBytes as bytes,
  formatPercent,
  moveBufferFocus,
  nodeTypeColor,
  type BufferTile,
} from "@/lib/index-layout";
import type { IndexAllocator } from "@/lib/types";

const hex = (value: number) => `0x${value.toString(16)}`;

function describe(tile: BufferTile) {
  const { allocator, buffer } = tile;
  return `${allocator.nodeType} buffer ${buffer.bufferId}, ${formatPercent(bufferOccupancy(buffer))} occupied, block ${buffer.blockId}`;
}

function BufferDetails({ tile }: { tile: BufferTile }) {
  const { allocator, buffer } = tile;
  return (
    <DetailBody
      title={`${allocator.nodeType} · buffer ${buffer.bufferId}`}
      swatch={nodeTypeColor(allocator)}
      rows={[
        [
          "Occupancy",
          `${formatPercent(bufferOccupancy(buffer))} · ${buffer.segmentCount.toLocaleString()} / ${buffer.storedSlots.toLocaleString()} slots`,
        ],
        ["Occupied", bytes(buffer.occupiedBytes)],
        ["Free holes", bytes(buffer.freeBytes)],
        ["Mask", bytes(allocator.maskBytes)],
        ["Envelope", bytes(buffer.allocationSize)],
        ["Location", `block ${buffer.blockId} · ${hex(buffer.absoluteOffset)}`],
      ]}
      hint="Click to open the physical block"
    />
  );
}

interface Anchor {
  tile: BufferTile;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function IndexBufferMap({
  tiles,
  totalBuffers,
  filter,
  onClearFilter,
  selectedBlockId,
  onPick,
}: {
  tiles: BufferTile[];
  totalBuffers: number;
  filter?: IndexAllocator;
  onClearFilter: () => void;
  selectedBlockId?: number | null;
  onPick: (id: number) => void;
}) {
  const [visible, setVisible] = useState(() =>
    initialBufferCount(tiles.length),
  );
  const [focus, setFocus] = useState(0);
  const [active, setActive] = useState<Anchor | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const tooltipId = useId();
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
  const styles = useMemo(
    () =>
      shown.map(
        (tile): CSSProperties =>
          ({
            "--tile-color": nodeTypeColor(tile.allocator),
            "--tile-fill": bufferFill(bufferOccupancy(tile.buffer)),
          }) as CSSProperties,
      ),
    [shown],
  );
  const activate = (tile: BufferTile, element: HTMLElement) =>
    setActive({
      tile,
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
  return (
    <section
      className="index-graph index-buffer-graph"
      aria-label="Buffer occupancy"
    >
      <div className="index-graph-heading">
        <div className="index-heading-title">
          <h4>Buffers</h4>
          <InfoTip label="About buffers">
            <p>
              One tile per allocator buffer, in file-offset order. Tile color is
              the node type; fill height is occupied / stored slots (slot
              occupancy, not node-child fullness), on a fixed 0–100% scale.
            </p>
            <p>
              Hover or focus a tile for counters and offsets. Arrow keys move;
              Enter or Space opens the physical block.
            </p>
          </InfoTip>
          {filter && (
            <button
              type="button"
              className="index-filter-chip"
              aria-label={`Clear ${filter.nodeType} filter`}
              onClick={onClearFilter}
            >
              <i
                className="index-swatch"
                style={{ background: nodeTypeColor(filter) }}
              />
              {filter.nodeType}
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        <span>
          {filter
            ? `${tiles.length.toLocaleString()} of ${totalBuffers.toLocaleString()} buffers`
            : `${totalBuffers.toLocaleString()} buffers`}
        </span>
      </div>
      {!tiles.length ? (
        <p className="section-caption">
          No persisted buffers. Empty or inlined roots need no allocator
          storage.
        </p>
      ) : (
        // Visibility follows hover/focus only: Radix would otherwise close on
        // the scroll that focusing an off-screen tile triggers.
        <Tooltip.Root open={!!active}>
          <p id={helpId} className="sr-only">
            Buffers in file-offset order. Arrow keys navigate; Enter or Space
            opens the physical block.
          </p>
          <div
            className="index-buffer-grid"
            ref={grid}
            role="group"
            aria-label="Buffers in file-offset order"
            aria-describedby={helpId}
            onPointerLeave={() => setActive(null)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setActive(null);
            }}
          >
            {shown.map((tile, position) => (
              <button
                type="button"
                className="index-buffer-tile"
                key={tile.key}
                tabIndex={position === focus ? 0 : -1}
                aria-label={describe(tile)}
                aria-describedby={
                  active?.tile === tile ? tooltipId : undefined
                }
                aria-pressed={
                  selectedKey === tile.key ||
                  (selectedKey == null &&
                    selectedBlockId === tile.buffer.blockId)
                }
                data-offset={tile.buffer.absoluteOffset}
                data-allocator={tile.allocator.ordinal}
                data-node-type={tile.allocator.nodeType}
                style={styles[position]}
                onPointerEnter={(event) =>
                  activate(tile, event.currentTarget)
                }
                onFocus={(event) => {
                  setFocus(position);
                  activate(tile, event.currentTarget);
                }}
                onClick={(event) => {
                  setFocus(position);
                  setPicked(tile.key);
                  activate(tile, event.currentTarget);
                  onPick(tile.buffer.blockId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setActive(null);
                    return;
                  }
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
            <Tooltip.Trigger asChild>
              <span
                aria-hidden="true"
                className="index-tooltip-anchor"
                style={
                  active
                    ? {
                        left: active.left,
                        top: active.top,
                        width: active.width,
                        height: active.height,
                      }
                    : undefined
                }
              />
            </Tooltip.Trigger>
          </div>
          {active && (
            <TipContent id={tooltipId} onEscapeKeyDown={() => setActive(null)}>
              <BufferDetails tile={active.tile} />
            </TipContent>
          )}
          {visible < tiles.length && (
            <div className="index-progress">
              <span>
                {shown.length.toLocaleString()} of{" "}
                {tiles.length.toLocaleString()} shown
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVisible(visible + BUFFER_TILE_LIMIT)}
              >
                Load more buffers
              </Button>
            </div>
          )}
        </Tooltip.Root>
      )}
    </section>
  );
}
