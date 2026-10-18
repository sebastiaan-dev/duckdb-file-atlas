import { internalFreeBytes } from "@/lib/fragmentation";
import {
  memo,
  useCallback,
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
  tooltipId,
}: {
  block: FileBlock;
  segments: Segment[];
  tooltipId: string;
}) {
  const owners = [
    ...new Set(segments.map((segment) => `${segment.table}.${segment.column}`)),
  ];
  return (
    <Tooltip.Portal>
      <Tooltip.Content
        id={tooltipId}
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
        <Tooltip.Arrow className="block-heatmap-tooltip-arrow" />
      </Tooltip.Content>
    </Tooltip.Portal>
  );
}

interface CellModel {
  block: FileBlock;
  fill: string;
  unknown: boolean;
  label: string;
}
const EMPTY_SEGMENTS: Segment[] = [];

const HeatmapCell = memo(function HeatmapCell({
  model,
  column,
  selected,
  active,
  linked,
  dimmed,
  tabbable,
  register,
  tooltipId,
}: {
  model: CellModel;
  tooltipId: string;
  column: number;
  selected: boolean;
  active: boolean;
  linked: boolean;
  dimmed: boolean;
  tabbable: boolean;
  register: (id: number, element: HTMLButtonElement | null) => void;
}) {
  const { block } = model;
  return (
    <button
      ref={(element) => register(block.id, element)}
      type="button"
      role="gridcell"
      data-block-id={block.id}
      className={`heatmap-cell${selected ? " is-selected" : ""}${active ? " is-hovered" : ""}${linked ? " is-linked" : ""}${dimmed ? " is-dimmed" : ""}${model.unknown ? " is-unknown" : ""}${block.role === "free" ? " is-free" : ""}`}
      style={{ "--cell-fill": model.fill } as CSSProperties}
      tabIndex={tabbable ? 0 : -1}
      aria-colindex={column + 1}
      aria-selected={selected}
      aria-describedby={active ? tooltipId : undefined}
      aria-label={`${model.label}${linked ? ", linked from active block" : ""}`}
    >
      <span className="heatmap-cell-marker" aria-hidden="true" />
    </button>
  );
});

/** One tooltip and local hover state keep pointer movement independent of the application. */
export const BlockHeatmap = memo(function BlockHeatmap({
  blocks,
  segmentsByBlock,
  colorMode,
  selectedBlockId,
  hoveredBlockId,
  matchingBlockIds,
  onSelect,
  density,
  linkedBlockIds,
}: BlockHeatmapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<number, HTMLButtonElement>());
  const [width, setWidth] = useState(800);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [hover, setHover] = useState<{
    id: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const helpId = useId();
  const tooltipId = useId();
  const ordered = useMemo(
    () => blocks.slice().sort((a, b) => a.offset - b.offset || a.id - b.id),
    [blocks],
  );
  const indices = useMemo(
    () => new Map(ordered.map((block, index) => [block.id, index])),
    [ordered],
  );
  const columns = Math.max(
    4,
    Math.min([32, 24, 16][density], Math.floor((width - 48) / 18)),
  );
  const models = useMemo(
    () =>
      ordered.map((block): CellModel => {
        const segments = segmentsByBlock.get(block.id) ?? EMPTY_SEGMENTS;
        const colors = blockCellColors(block, colorMode, segments);
        const owners = blockOwners(block, colorMode, segments);
        return {
          block,
          fill:
            colors.length > 1
              ? `linear-gradient(135deg, ${colors.flatMap((color, i) => [`${color} ${(i / colors.length) * 100}%`, `${color} ${((i + 1) / colors.length) * 100}%`]).join(", ")})`
              : colors[0],
          unknown:
            block.role === "unknown" ||
            (block.role !== "free" &&
              (colorMode === "utilization"
                ? block.usedBytes == null
                : colorMode === "fragmentation"
                  ? internalFreeBytes(block) == null
                  : colorMode !== "role" && owners.length === 0)),
          label: `Block ${block.id}, ${block.role}, offset ${offset(block.offset)}, ${bytes(block.size)}${owners.length ? `, ${owners.join(", ")}` : ""}`,
        };
      }),
    [ordered, segmentsByBlock, colorMode],
  );
  const rows = useMemo(
    () =>
      Array.from({ length: Math.ceil(models.length / columns) }, (_, i) =>
        models.slice(i * columns, (i + 1) * columns),
      ),
    [models, columns],
  );
  const activeId = hover?.id ?? hoveredBlockId ?? selectedBlockId;
  const linkedIds = useMemo(
    () =>
      hover
        ? new Set(ordered[indices.get(hover.id) ?? -1]?.links ?? [])
        : (linkedBlockIds ??
          new Set(ordered[indices.get(activeId ?? NaN) ?? -1]?.links ?? [])),
    [ordered, indices, hover?.id, activeId, linkedBlockIds],
  );
  const activeBlock = hover ? ordered[indices.get(hover.id) ?? -1] : undefined;
  const tabbableId =
    focusedId != null && indices.has(focusedId)
      ? focusedId
      : selectedBlockId != null && indices.has(selectedBlockId)
        ? selectedBlockId
        : ordered[0]?.id;
  const register = useCallback(
    (id: number, element: HTMLButtonElement | null) => {
      if (element) cellRefs.current.set(id, element);
      else cellRefs.current.delete(id);
    },
    [],
  );
  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  function targetCell(target: EventTarget | null) {
    return target instanceof Element
      ? target.closest<HTMLButtonElement>("[data-block-id]")
      : null;
  }
  function showCell(cell: HTMLButtonElement | null) {
    if (!cell || !hostRef.current) return;
    const id = Number(cell.dataset.blockId);
    const rect = cell.getBoundingClientRect(),
      host = hostRef.current.getBoundingClientRect();
    setHover((previous) =>
      previous?.id === id
        ? previous
        : {
            id,
            left: rect.left - host.left,
            top: rect.top - host.top,
            width: rect.width,
            height: rect.height,
          },
    );
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const cell = targetCell(event.target);
    if (!cell) return;
    const index = indices.get(Number(cell.dataset.blockId));
    if (index == null) return;
    let next = index;
    if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowLeft") next--;
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
    else if (event.key === "Escape") {
      setHover(null);
      return;
    } else return;
    event.preventDefault();
    next = Math.max(0, Math.min(ordered.length - 1, next));
    cellRefs.current.get(ordered[next].id)?.focus();
  }
  useEffect(() => {
    if (selectedBlockId != null)
      cellRefs.current
        .get(selectedBlockId)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedBlockId, columns]);
  return (
    <Tooltip.Provider>
      <Tooltip.Root
        open={!!activeBlock}
        onOpenChange={(open) => {
          if (!open) setHover(null);
        }}
      >
        <div
          ref={hostRef}
          className="block-heatmap"
          style={{ "--heatmap-columns": columns } as CSSProperties}
          onPointerOver={(event) => {
            const cell = targetCell(event.target);
            if (cell) showCell(cell);
            else setHover(null);
          }}
          onPointerLeave={() => setHover(null)}
          onFocus={(event) => {
            const cell = targetCell(event.target);
            if (cell) {
              setFocusedId(Number(cell.dataset.blockId));
              showCell(cell);
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setHover(null);
          }}
          onClick={(event) => {
            const cell = targetCell(event.target);
            if (cell) {
              const block =
                ordered[indices.get(Number(cell.dataset.blockId)) ?? -1];
              if (block) onSelect(block);
            }
          }}
          onKeyDown={navigate}
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
                  {Array.from({ length: columns }, (_, i) => (
                    <span key={i}>
                      {i % 8 === 0 ? `+${i.toString().padStart(2, "0")}` : ""}
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
                    key={row[0].block.id}
                  >
                    <span className="heatmap-row-label" aria-hidden="true">
                      {row[0].block.id.toString().padStart(4, "0")}
                    </span>
                    <div className="heatmap-row-cells" role="presentation">
                      {row.map((model, col) => (
                        <HeatmapCell
                          key={model.block.id}
                          model={model}
                          tooltipId={tooltipId}
                          column={col}
                          register={register}
                          selected={selectedBlockId === model.block.id}
                          active={hover?.id === model.block.id}
                          linked={linkedIds.has(model.block.id)}
                          dimmed={
                            matchingBlockIds != null &&
                            !matchingBlockIds.has(model.block.id)
                          }
                          tabbable={tabbableId === model.block.id}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="heatmap-offset-caption">
                <span>{offset(ordered[0].offset)}</span>
                <span>File offset →</span>
                <span>
                  {offset(ordered.at(-1)!.offset + ordered.at(-1)!.size)}
                </span>
              </div>
            </>
          ) : (
            <div className="heatmap-empty">
              No database blocks in this file.
            </div>
          )}
          <Tooltip.Trigger asChild>
            <span
              aria-hidden="true"
              className="heatmap-tooltip-anchor"
              style={
                hover
                  ? {
                      left: hover.left,
                      top: hover.top,
                      width: hover.width,
                      height: hover.height,
                    }
                  : undefined
              }
            />
          </Tooltip.Trigger>
          {activeBlock && (
            <HeatmapTooltip
              block={activeBlock}
              tooltipId={tooltipId}
              segments={segmentsByBlock.get(activeBlock.id) ?? EMPTY_SEGMENTS}
            />
          )}
        </div>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
});
