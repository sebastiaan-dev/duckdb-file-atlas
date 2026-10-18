import { internalFreeBytes } from "@/lib/fragmentation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { blockCellColors, blockOwners } from "@/lib/palette";
import type { ColorMode, FileBlock, Segment } from "@/lib/types";
import "./block-heatmap.css";

export interface BlockHeatmapProps {
  blocks: FileBlock[];
  segmentsByBlock: Map<number, Segment[]>;
  colorMode: ColorMode;
  selectedBlockId: number | null;
  hoveredBlockId: number | null;
  matchingBlockIds: Set<number> | null;
  onSelect: (block: FileBlock) => void;
  onHover: (id: number | null) => void;
  density: 0 | 1 | 2;
  linkedBlockIds?: Set<number>;
}

const bytes = (value: number) =>
  value < 1024
    ? `${value.toLocaleString()} B`
    : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
const offset = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;

function HeatmapTooltip({
  block,
  segments,
}: {
  block: FileBlock;
  segments: Segment[];
}) {
  const owners = [
    ...new Set(segments.map((segment) => `${segment.table}.${segment.column}`)),
  ];
  return (
    <Tooltip.Portal>
      <Tooltip.Content
        className="block-heatmap-tooltip"
        side="top"
        sideOffset={10}
        collisionPadding={16}
        avoidCollisions
      >
        <div className="heatmap-tooltip-title">
          <strong>Block {block.id}</strong>
          <span>{block.role}</span>
        </div>
        <div className="heatmap-tooltip-offset">{offset(block.offset)}</div>
        <dl>
          <div>
            <dt>Size</dt>
            <dd>{bytes(block.size)}</dd>
          </div>
          <div>
            <dt>Space used</dt>
            <dd>
              {block.usedBytes == null || block.size <= 0
                ? "Unknown"
                : `${bytes(block.usedBytes)} · ${((block.usedBytes / block.size) * 100).toFixed(1)}%`}
            </dd>
          </div>
          <div>
            <dt>Internal free</dt>
            <dd>
              {internalFreeBytes(block) == null
                ? "Unmeasured"
                : bytes(internalFreeBytes(block)!)}
            </dd>
          </div>
          <div>
            <dt>Owners</dt>
            <dd>
              {owners.length
                ? owners.slice(0, 3).join(", ") +
                  (owners.length > 3 ? ` +${owners.length - 3} more` : "")
                : block.role === "free"
                  ? "Unallocated"
                  : "Unknown"}
            </dd>
          </div>
          <div>
            <dt>Links to</dt>
            <dd>
              {block.links.length
                ? block.links
                    .slice(0, 6)
                    .map((id) => `#${id}`)
                    .join(", ") +
                  (block.links.length > 6
                    ? ` +${block.links.length - 6} more`
                    : "")
                : "None recorded"}
            </dd>
          </div>
        </dl>
        <div className="heatmap-tooltip-hint">
          Click to inspect · Arrow keys to explore
        </div>
        <Tooltip.Arrow className="block-heatmap-tooltip-arrow" />
      </Tooltip.Content>
    </Tooltip.Portal>
  );
}

/** Physical blocks run left to right in byte-offset order; there are no calendar bins or padded blocks. */
export function BlockHeatmap({
  blocks,
  segmentsByBlock,
  colorMode,
  selectedBlockId,
  hoveredBlockId,
  matchingBlockIds,
  onSelect,
  onHover,
  density,
  linkedBlockIds,
}: BlockHeatmapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<number, HTMLButtonElement>());
  const [width, setWidth] = useState(800);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const helpId = useId();
  const ordered = useMemo(
    () => blocks.slice().sort((a, b) => a.offset - b.offset || a.id - b.id),
    [blocks],
  );
  const preferredColumns = [32, 24, 16][density];
  const columns = Math.max(
    4,
    Math.min(preferredColumns, Math.floor((width - 48) / 18)),
  );
  const rows = useMemo(
    () =>
      Array.from({ length: Math.ceil(ordered.length / columns) }, (_, i) =>
        ordered.slice(i * columns, (i + 1) * columns),
      ),
    [ordered, columns],
  );
  const activeId = hoveredBlockId ?? selectedBlockId;
  const linkedIds = useMemo(
    () =>
      linkedBlockIds ??
      new Set(ordered.find((block) => block.id === activeId)?.links ?? []),
    [ordered, activeId, linkedBlockIds],
  );
  const tabbableId = ordered.some((block) => block.id === focusedId)
    ? focusedId
    : ordered.some((block) => block.id === selectedBlockId)
      ? selectedBlockId
      : ordered[0]?.id;

  useEffect(() => {
    if (!hostRef.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next += 1;
    else if (event.key === "ArrowLeft") next -= 1;
    else if (event.key === "ArrowDown") next += columns;
    else if (event.key === "ArrowUp") next -= columns;
    else if (event.key === "Home")
      next =
        event.ctrlKey || event.metaKey
          ? 0
          : Math.floor(index / columns) * columns;
    else if (event.key === "End")
      next =
        event.ctrlKey || event.metaKey
          ? ordered.length - 1
          : Math.min(
              ordered.length - 1,
              Math.floor(index / columns) * columns + columns - 1,
            );
    else return;
    event.preventDefault();
    next = Math.max(0, Math.min(ordered.length - 1, next));
    const block = ordered[next];
    if (block) {
      setFocusedId(block.id);
      cellRefs.current.get(block.id)?.focus();
    }
  }

  return (
    <Tooltip.Provider delayDuration={80} skipDelayDuration={150}>
      <div
        ref={hostRef}
        className="block-heatmap"
        style={{ "--heatmap-columns": columns } as CSSProperties}
      >
        <p id={helpId} className="heatmap-sr-only">
          Blocks in ascending file offset order. Use arrow keys to move, Enter
          or Space to inspect. Row labels show the first block ID in each row.
        </p>
        {ordered.length ? (
          <>
            <div className="heatmap-axis" aria-hidden="true">
              <span>BLOCK</span>
              <div>
                {Array.from({ length: columns }, (_, index) => (
                  <span key={index}>
                    {index % 8 === 0
                      ? `+${index.toString().padStart(2, "0")}`
                      : ""}
                  </span>
                ))}
              </div>
            </div>
            <div
              className="heatmap-matrix"
              role="grid"
              aria-label="Database block map"
              aria-describedby={helpId}
              aria-rowcount={rows.length}
              aria-colcount={columns}
            >
              {rows.map((row, rowIndex) => (
                <div
                  className="heatmap-row"
                  role="row"
                  aria-rowindex={rowIndex + 1}
                  key={row[0].id}
                >
                  <span className="heatmap-row-label" aria-hidden="true">
                    {row[0].id.toString().padStart(4, "0")}
                  </span>
                  <div className="heatmap-row-cells" role="presentation">
                    {row.map((block, columnIndex) => {
                      const segments = segmentsByBlock.get(block.id) ?? [];
                      const colors = blockCellColors(
                        block,
                        colorMode,
                        segments,
                      );
                      const owners = blockOwners(block, colorMode, segments);
                      const unknown =
                        block.role === "unknown" ||
                        (block.role !== "free" &&
                          (colorMode === "utilization"
                            ? block.usedBytes == null || block.size <= 0
                            : colorMode === "fragmentation"
                              ? internalFreeBytes(block) == null
                              : colorMode !== "role" && owners.length === 0));
                      const selected = selectedBlockId === block.id;
                      const hovered = hoveredBlockId === block.id;
                      const linked = linkedIds.has(block.id);
                      const dimmed =
                        matchingBlockIds != null &&
                        !matchingBlockIds.has(block.id);
                      const background =
                        colors.length > 1
                          ? `linear-gradient(135deg, ${colors.flatMap((color, i) => [`${color} ${(i / colors.length) * 100}%`, `${color} ${((i + 1) / colors.length) * 100}%`]).join(", ")})`
                          : colors[0];
                      return (
                        <Tooltip.Root key={block.id}>
                          <Tooltip.Trigger asChild>
                            <button
                              ref={(element) => {
                                if (element)
                                  cellRefs.current.set(block.id, element);
                                else cellRefs.current.delete(block.id);
                              }}
                              type="button"
                              role="gridcell"
                              data-block-id={block.id}
                              className={`heatmap-cell${selected ? " is-selected" : ""}${hovered ? " is-hovered" : ""}${linked ? " is-linked" : ""}${dimmed ? " is-dimmed" : ""}${unknown ? " is-unknown" : ""}${block.role === "free" ? " is-free" : ""}`}
                              style={
                                { "--cell-fill": background } as CSSProperties
                              }
                              tabIndex={tabbableId === block.id ? 0 : -1}
                              aria-colindex={columnIndex + 1}
                              aria-selected={selected}
                              aria-label={`Block ${block.id}, ${block.role}, offset ${offset(block.offset)}, ${bytes(block.size)}${owners.length ? `, ${owners.join(", ")}` : ""}${linked ? ", linked from active block" : ""}`}
                              onClick={() => onSelect(block)}
                              onPointerEnter={() => onHover(block.id)}
                              onPointerLeave={() => onHover(null)}
                              onFocus={() => {
                                setFocusedId(block.id);
                                onHover(block.id);
                              }}
                              onBlur={() => onHover(null)}
                              onKeyDown={(event) =>
                                navigate(
                                  event,
                                  rowIndex * columns + columnIndex,
                                )
                              }
                            >
                              <span
                                className="heatmap-cell-marker"
                                aria-hidden="true"
                              />
                            </button>
                          </Tooltip.Trigger>
                          <HeatmapTooltip block={block} segments={segments} />
                        </Tooltip.Root>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="heatmap-offset-caption">
              <span>{offset(ordered[0].offset)}</span>
              <span>Increasing file offset →</span>
              <span>
                {offset(
                  ordered[ordered.length - 1].offset +
                    ordered[ordered.length - 1].size,
                )}
              </span>
            </div>
          </>
        ) : (
          <div className="heatmap-empty">No database blocks in this file.</div>
        )}
      </div>
    </Tooltip.Provider>
  );
}
