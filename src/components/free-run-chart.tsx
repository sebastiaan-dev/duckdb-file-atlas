import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Minus, Plus } from "lucide-react";
import { InfoTip } from "@/components/detail-tooltip";
import { Button } from "@/components/ui/button";
import {
  fitRunGrouping,
  hitRunCell,
  runBarWidth,
  runCell,
  RUN_TILE_PITCH,
  RUN_TILE_SIZE,
  type FreeRun,
} from "@/lib/free-list";

const number = (value: number) => value.toLocaleString();
const bytes = (value: number) =>
  value < 1024 ** 2
    ? `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} KiB`
    : value < 1024 ** 3
      ? `${(value / 1024 ** 2).toFixed(1)} MiB`
      : `${(value / 1024 ** 3).toFixed(1)} GiB`;
const offset = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;
type Cell = NonNullable<ReturnType<typeof runCell>>;

/** File position and size comparisons keep the full inspection's scale. */
export const FreeRunChart = memo(function FreeRunChart(props: {
  runs: FreeRun[];
  largest: number;
  totalBlocks: number;
  blockSize: number;
  dataStart: number;
  matchingId: number | null;
  onPick: (id: number) => void;
}) {
  const { runs, largest, totalBlocks, blockSize, matchingId } = props;
  const [mode, setMode] = useState<"position" | "size">("position");
  const scale = Math.max(1, mode === "position" ? totalBlocks : largest);
  const axisMax = mode === "position" ? Math.max(0, totalBlocks - 1) : largest;
  const [detailStart, setDetailStart] = useState<number | null>(null);
  const [focusDetail, setFocusDetail] = useState(false);
  const overview = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<number | null>(null);
  const searchRun =
    matchingId == null
      ? undefined
      : runs.find((run) => matchingId >= run.start && matchingId <= run.end);
  useEffect(() => {
    if (searchRun) {
      setFocusDetail(false);
      setDetailStart(searchRun.start);
    }
  }, [matchingId, searchRun?.start]);
  const detail = runs.find((run) => run.start === detailStart);
  useLayoutEffect(() => {
    if (!detail && returnFocus.current != null) {
      overview.current
        ?.querySelector<HTMLButtonElement>(
          `[data-run-start="${returnFocus.current}"]`,
        )
        ?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [detail]);
  const ticks = [...new Set([0, Math.round(axisMax / 2), axisMax])];
  return (
    <div className="free-run-chart">
      {detail ? (
        <>
          <div className="free-run-detail-heading">
            <Button
              variant="ghost"
              size="sm"
              className="free-run-back"
              aria-label="Back to run overview"
              onClick={() => {
                returnFocus.current = detail.start;
                setDetailStart(null);
              }}
            >
              ← All runs
            </Button>
            <span>
              Blocks {number(detail.start)}–{number(detail.end)}
              <small>
                {number(detail.count)} blocks ·{" "}
                {bytes(detail.count * blockSize)}
              </small>
            </span>
          </div>
          <FreeRunDetail
            {...props}
            runs={[detail]}
            largest={detail.count}
            autoFocus={focusDetail}
          />
        </>
      ) : (
        <div
          ref={overview}
          className="free-run-overview"
          role="group"
          aria-label={
            mode === "position"
              ? "Free block runs by file position"
              : "Free block runs by length"
          }
          data-scale-max={scale}
          data-mode={mode}
        >
          <div className="free-run-overview-toolbar">
            <div className="free-run-overview-key">
              {runs.some((run) => run.source === "serialized") && (
                <span>
                  <i data-source="serialized" />
                  Free-list entries
                </span>
              )}
              {runs.some((run) => run.source === "implicit") && (
                <span>
                  <i data-source="implicit" />
                  Outside checkpoint
                </span>
              )}
              <InfoTip label="About free block runs">
                <p>
                  A run is a consecutive range of reusable blocks. Position
                  shows where each run sits in the file; Size compares run
                  lengths. Both scales stay fixed when searching or loading more
                  runs.
                </p>
                <p>
                  Striped runs lie outside the checkpoint extent. Blank track
                  space is context, not a measurement of other allocations.
                  Click a row to explore its blocks. Very small runs have a
                  minimum one-pixel marker.
                </p>
              </InfoTip>
            </div>
            <div
              className="index-toggle"
              role="group"
              aria-label="Free run view"
            >
              <button
                type="button"
                aria-pressed={mode === "position"}
                onClick={() => setMode("position")}
              >
                Position
              </button>
              <button
                type="button"
                aria-pressed={mode === "size"}
                onClick={() => setMode("size")}
              >
                Size
              </button>
            </div>
          </div>
          <div className="free-run-overview-axis" aria-hidden="true">
            <span>
              {mode === "position"
                ? "Block ID · full file"
                : "Run length (blocks)"}
            </span>
            <div>
              {ticks.map((tick) => (
                <i key={tick} style={{ left: `${(tick / scale) * 100}%` }}>
                  {number(tick)}
                </i>
              ))}
            </div>
          </div>
          <div className="free-run-overview-plot">
            <div className="free-run-overview-grid" aria-hidden="true">
              {ticks.map((tick) => (
                <i key={tick} style={{ left: `${(tick / scale) * 100}%` }} />
              ))}
            </div>
            {runs.map((run) => (
              <FreeRunOverviewBar
                key={run.start}
                run={run}
                scale={scale}
                position={mode === "position"}
                blockSize={blockSize}
                onDrill={() => {
                  setFocusDetail(true);
                  setDetailStart(run.start);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

const FreeRunOverviewBar = memo(function FreeRunOverviewBar({
  run,
  scale,
  position,
  blockSize,
  onDrill,
}: {
  run: FreeRun;
  scale: number;
  position: boolean;
  blockSize: number;
  onDrill: () => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const show = (hovered || focused) && !dismissed;
  const box = show ? button.current?.getBoundingClientRect() : undefined;
  const provenance =
    run.source === "implicit"
      ? "Outside checkpoint extent (implicit)"
      : "Serialized free list";
  return (
    <div className="free-run-overview-row">
      <span className="free-run-overview-label">
        {run.start === run.end
          ? `Block ${number(run.start)}`
          : `${number(run.start)}–${number(run.end)}`}
      </span>
      <button
        ref={button}
        className="free-run-overview-target"
        data-run-start={run.start}
        data-run-end={run.end}
        aria-label={`Free run ${run.start}–${run.end}, ${number(run.count)} ${run.count === 1 ? "block" : "blocks"}. ${provenance}. Enter to explore blocks.`}
        aria-describedby={show ? `${id}-hint` : undefined}
        onClick={onDrill}
        onPointerEnter={() => {
          setHovered(true);
          setDismissed(false);
        }}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDismissed(true);
        }}
      >
        <span
          className="free-run-overview-bar"
          data-source={run.source}
          style={{
            left: `${position ? (run.start / scale) * 100 : 0}%`,
            width: `${(run.count / scale) * 100}%`,
          }}
        />
      </button>
      <span className="free-run-overview-values">
        <span>
          <span className="free-run-overview-count">{number(run.count)}</span>{" "}
          {run.count === 1 ? "block" : "blocks"}
        </span>
        <small>{bytes(run.count * blockSize)}</small>
      </span>
      {show && box && (
        <div
          className="free-run-tooltip"
          role="tooltip"
          id={`${id}-hint`}
          style={{
            left: Math.max(12, Math.min(window.innerWidth - 257, box.left)),
            top: Math.max(140, box.top - 8),
          }}
        >
          <strong>
            {run.start === run.end
              ? `Block ${number(run.start)}`
              : `Blocks ${number(run.start)}–${number(run.end)}`}
          </strong>
          <span>
            {number(run.count)} {run.count === 1 ? "block" : "blocks"} ·{" "}
            {bytes(run.count * blockSize)}
          </span>
          <span>{provenance}</span>
          <small>Click or Enter to explore blocks</small>
        </div>
      )}
    </div>
  );
});

/** SVG patterns keep individual-block zoom cheap even for a 100,000-block run. */
const FreeRunDetail = memo(function FreeRunDetail({
  runs,
  largest,
  blockSize,
  dataStart,
  matchingId,
  onPick,
  autoFocus,
}: {
  runs: FreeRun[];
  largest: number;
  blockSize: number;
  dataStart: number;
  matchingId: number | null;
  onPick: (id: number) => void;
  autoFocus: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pendingLeft = useRef<number | null>(null);
  const didFocus = useRef(false);
  const [width, setWidth] = useState(0);
  const [manualGrouping, setManualGrouping] = useState<number | null>(null);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Wait for the measured scale before revealing a keyboard tile. Searches
    // retain input focus; explicit drills transfer focus even with a query.
    if (!autoFocus || width <= 0 || didFocus.current) return;
    didFocus.current = true;
    scroller.current
      ?.querySelector<SVGSVGElement>(".free-run-bar")
      ?.focus({ preventScroll: true });
  }, [autoFocus, width]);
  const available = Math.max(40, width || 960);
  const fit = fitRunGrouping(largest, available);
  const grouping = manualGrouping ?? fit;
  const plotWidth = Math.max(available, runBarWidth(largest, grouping));
  const maxGrouping = 2 ** Math.ceil(Math.log2(Math.max(1, largest)));
  const changeGrouping = (next: number | null) => {
    pendingLeft.current =
      ((scroller.current?.scrollLeft ?? 0) * grouping) / (next ?? fit);
    setManualGrouping(next);
  };
  const expand = useCallback((_run: FreeRun, blockOffset: number) => {
    pendingLeft.current = blockOffset * RUN_TILE_PITCH;
    setManualGrouping(1);
  }, []);
  useLayoutEffect(() => {
    if (pendingLeft.current == null || !scroller.current) return;
    scroller.current.scrollLeft = pendingLeft.current;
    pendingLeft.current = null;
  }, [grouping, plotWidth]);
  const reveal = useCallback((x: number) => {
    const node = scroller.current;
    if (!node) return;
    const visible = node.clientWidth;
    if (x < node.scrollLeft) node.scrollLeft = x;
    else if (x + RUN_TILE_SIZE > node.scrollLeft + visible)
      node.scrollLeft = x - visible + RUN_TILE_PITCH;
  }, []);
  const searchRunStart =
    matchingId == null
      ? undefined
      : runs.find((run) => matchingId >= run.start && matchingId <= run.end)
          ?.start;
  useLayoutEffect(() => {
    if (matchingId == null || searchRunStart == null) return;
    // Search reveals individual blocks while leaving keyboard focus in the input.
    const left = (matchingId - searchRunStart) * RUN_TILE_PITCH;
    pendingLeft.current = left;
    setManualGrouping(1);
    const frame = requestAnimationFrame(() => {
      if (scroller.current) scroller.current.scrollLeft = left;
      pendingLeft.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [matchingId, searchRunStart]);
  return (
    <div className="free-run-chart">
      <div className="free-run-chart-tools">
        <span className="free-run-unit">
          <i
            style={{
              background:
                runs[0]?.source === "implicit"
                  ? "var(--run-implicit)"
                  : "var(--run-serialized)",
            }}
          />
          {grouping === 1
            ? `1 tile = 1 block · ${bytes(blockSize)}`
            : `1 tile = up to ${number(grouping)} blocks · click to expand`}
        </span>
        <div className="free-run-zoom" aria-label="Free-run chart zoom">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom out free runs"
            disabled={grouping >= maxGrouping}
            onClick={() => changeGrouping(Math.min(maxGrouping, grouping * 2))}
          >
            <Minus size={12} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => changeGrouping(null)}
            disabled={manualGrouping === null}
          >
            Fit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom in free runs"
            disabled={grouping === 1}
            onClick={() => changeGrouping(Math.max(1, grouping / 2))}
          >
            <Plus size={12} />
          </Button>
        </div>
      </div>
      <div className="free-run-chart-scroll" ref={scroller}>
        <div
          className="free-run-chart-table"
          role="group"
          aria-label="Blocks within selected free run"
          style={{ width: plotWidth }}
        >
          {runs.map((run) => (
            <FreeRunBar
              key={run.start}
              run={run}
              grouping={grouping}
              blockSize={blockSize}
              dataStart={dataStart}
              matchingId={matchingId}
              onPick={onPick}
              onExpand={expand}
              onReveal={reveal}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

const FreeRunBar = memo(function FreeRunBar({
  run,
  grouping,
  blockSize,
  dataStart,
  matchingId,
  onPick,
  onExpand,
  onReveal,
}: {
  run: FreeRun;
  grouping: number;
  blockSize: number;
  dataStart: number;
  matchingId: number | null;
  onPick: (id: number) => void;
  onExpand: (run: FreeRun, offset: number) => void;
  onReveal: (x: number) => void;
}) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const pointerFocus = useRef(false);
  const [activeOffset, setActiveOffset] = useState(0);
  const [focused, setFocused] = useState(false);
  const [hint, setHint] = useState<{ cell: Cell; x: number; y: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (matchingId != null && matchingId >= run.start && matchingId <= run.end)
      setActiveOffset(matchingId - run.start);
  }, [matchingId, run.start, run.end]);
  const active = runCell(run, grouping, Math.floor(activeOffset / grouping))!;
  const match =
    matchingId != null && matchingId >= run.start && matchingId <= run.end
      ? runCell(run, grouping, Math.floor((matchingId - run.start) / grouping))
      : null;
  const hintCell = hint
    ? runCell(
        run,
        grouping,
        Math.floor((hint.cell.first - run.start) / grouping),
      )
    : null;
  const highlight = hintCell ?? (focused ? active : match);
  const showHint = (
    cell: Cell,
    pointer?: { clientX: number; clientY: number },
  ) => {
    const box = svg.current!.getBoundingClientRect();
    setHint({
      cell,
      x: Math.max(
        12,
        Math.min(
          window.innerWidth - 250,
          pointer?.clientX ?? box.left + cell.index * RUN_TILE_PITCH,
        ),
      ),
      y: Math.max(90, (pointer?.clientY ?? box.top) - 12),
    });
  };
  const activate = (cell: Cell) => {
    if (cell.count === 1) onPick(cell.first);
    else {
      setActiveOffset(cell.first - run.start);
      setHint(null);
      svg.current?.focus({ preventScroll: true });
      onExpand(run, cell.first - run.start);
    }
  };
  return (
    <div className="free-run-chart-row" data-source={run.source}>
      <div className="free-run-bar-cell">
        <svg
          ref={svg}
          width={runBarWidth(run.count, grouping)}
          height="14"
          className="free-run-bar"
          role="button"
          tabIndex={0}
          data-run-start={run.start}
          data-run-end={run.end}
          data-blocks-per-tile={grouping}
          aria-label={`Free run ${run.start}–${run.end}, ${number(run.count)} ${run.count === 1 ? "block" : "blocks"}. ${active.count === 1 ? `Block ${active.first}` : `Blocks ${active.first}–${active.last}`}. Use arrow keys to move, Enter to ${active.count === 1 ? "inspect" : "expand"}.`}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onPointerDown={(event) => {
            // Pointer focus must not reveal the old keyboard tile: that moves
            // the SVG between pointerdown and click and changes the hit target.
            pointerFocus.current = true;
            const cell = hitRunCell(
              run,
              grouping,
              event.clientX - event.currentTarget.getBoundingClientRect().left,
            );
            if (cell) {
              setActiveOffset(cell.first - run.start);
              showHint(cell, event);
            }
          }}
          onPointerUp={() => {
            pointerFocus.current = false;
          }}
          onPointerCancel={() => {
            pointerFocus.current = false;
          }}
          onPointerMove={(event) => {
            const cell = hitRunCell(
              run,
              grouping,
              event.clientX - event.currentTarget.getBoundingClientRect().left,
            );
            if (cell) showHint(cell, event);
            else setHint(null);
          }}
          onPointerLeave={() => (focused ? showHint(active) : setHint(null))}
          onFocus={() => {
            setFocused(true);
            if (!pointerFocus.current) {
              onReveal(active.index * RUN_TILE_PITCH);
              showHint(active);
            }
            pointerFocus.current = false;
          }}
          onBlur={() => {
            pointerFocus.current = false;
            setFocused(false);
            setHint(null);
          }}
          onClick={(event) => {
            const cell =
              event.detail === 0
                ? active
                : hitRunCell(
                    run,
                    grouping,
                    event.clientX -
                      event.currentTarget.getBoundingClientRect().left,
                  );
            if (cell) activate(cell);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activate(active);
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const last = Math.ceil(run.count / grouping) - 1;
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? last
                  : Math.max(
                      0,
                      Math.min(
                        last,
                        active.index + (event.key === "ArrowRight" ? 1 : -1),
                      ),
                    );
            const cell = runCell(run, grouping, index)!;
            setActiveOffset(cell.first - run.start);
            onReveal(index * RUN_TILE_PITCH);
            showHint(cell);
          }}
        >
          <defs>
            <pattern
              id={`${id}-tile`}
              width={RUN_TILE_PITCH}
              height="14"
              patternUnits="userSpaceOnUse"
            >
              <rect
                y="3"
                width={RUN_TILE_SIZE}
                height={RUN_TILE_SIZE}
                rx="2"
                fill={
                  run.source === "implicit"
                    ? "var(--run-implicit)"
                    : "var(--run-serialized)"
                }
              />
            </pattern>
          </defs>
          <rect
            y="0"
            width={runBarWidth(run.count, grouping)}
            height="14"
            fill={`url(#${id}-tile)`}
          />
          {highlight && (
            <rect
              x={highlight.index * RUN_TILE_PITCH}
              y="3"
              width={Math.max(2, (highlight.count / grouping) * RUN_TILE_SIZE)}
              height={RUN_TILE_SIZE}
              rx="2"
              fill="var(--chart-primary)"
              stroke="var(--chart-primary)"
              strokeWidth="2"
            />
          )}
        </svg>
        {hint && hintCell && (
          <div
            className="free-run-tooltip"
            id={`${id}-hint`}
            role="tooltip"
            style={{ left: hint.x, top: hint.y }}
          >
            <strong>
              {hintCell.count === 1
                ? `Block ${hintCell.first}`
                : `Blocks ${hintCell.first}–${hintCell.last}`}
            </strong>
            <span>
              {bytes(hintCell.count * blockSize)} ·{" "}
              {offset(dataStart + hintCell.first * blockSize)}
            </span>
            <small>
              {hintCell.count === 1
                ? "Click to inspect block"
                : `${number(hintCell.count)} blocks · click to expand`}
            </small>
          </div>
        )}
      </div>
    </div>
  );
});
