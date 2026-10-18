import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Minus, Plus } from "lucide-react";
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

const LABEL_WIDTH = 140;
const VALUE_WIDTH = 110;
const columnsForWidth = (width: number) =>
  width > 0 && width < 600
    ? { label: 100, values: 80 }
    : { label: LABEL_WIDTH, values: VALUE_WIDTH };
const GAPS = 24;
const number = (value: number) => value.toLocaleString();
const bytes = (value: number) =>
  value < 1024 ** 2
    ? `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} KiB`
    : value < 1024 ** 3
      ? `${(value / 1024 ** 2).toFixed(1)} MiB`
      : `${(value / 1024 ** 3).toFixed(1)} GiB`;
const offset = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;
type Cell = NonNullable<ReturnType<typeof runCell>>;

/** SVG patterns keep individual-block zoom cheap even for a 100,000-block run. */
export const FreeRunChart = memo(function FreeRunChart({
  runs,
  largest,
  blockSize,
  dataStart,
  matchingId,
  onPick,
}: {
  runs: FreeRun[];
  largest: number;
  blockSize: number;
  dataStart: number;
  matchingId: number | null;
  onPick: (id: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pendingLeft = useRef<number | null>(null);
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
  const columns = columnsForWidth(width);
  const available = Math.max(
    40,
    (width || 960) - columns.label - columns.values - GAPS,
  );
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
    const columns = columnsForWidth(node.clientWidth);
    const visible = node.clientWidth - columns.label - columns.values - GAPS;
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
  const ticks = useMemo(
    () =>
      runBarWidth(largest, grouping) < 32
        ? [largest]
        : [
            ...new Set([
              0,
              Math.round(largest / 4),
              Math.round(largest / 2),
              Math.round((largest * 3) / 4),
              largest,
            ]),
          ],
    [largest, grouping],
  );
  return (
    <div className="free-run-chart">
      <div className="free-run-chart-tools">
        <span className="free-run-unit">
          <i />
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
          role="table"
          aria-label="Free block runs by length"
          style={
            {
              "--run-plot-width": `${plotWidth}px`,
              "--run-label-width": `${columns.label}px`,
              "--run-value-width": `${columns.values}px`,
            } as CSSProperties
          }
        >
          <div className="free-run-chart-axis" role="row">
            <span className="free-run-label" role="columnheader">
              Block range
            </span>
            <div
              className="free-run-scale"
              role="columnheader"
              aria-label="Run length in blocks"
            >
              <span>Run length (blocks)</span>
              <div>
                {ticks.map((tick) => (
                  <i key={tick} style={{ left: runBarWidth(tick, grouping) }}>
                    {number(tick)}
                  </i>
                ))}
              </div>
            </div>
            <span className="free-run-values" role="columnheader">
              Blocks / size
            </span>
          </div>
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
  const highlight = hint?.cell ?? (focused ? active : match);
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
    <div className="free-run-chart-row" role="row">
      <span className="free-run-label" role="rowheader">
        {run.start === run.end
          ? `Block ${run.start}`
          : `Blocks ${run.start}–${run.end}`}
        {run.source === "implicit" && <small>Outside checkpoint extent</small>}
      </span>
      <div className="free-run-bar-cell" role="cell">
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
            onReveal(active.index * RUN_TILE_PITCH);
            showHint(active);
          }}
          onBlur={() => {
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
                fill="var(--chart-unknown)"
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
        {hint && (
          <div
            className="free-run-tooltip"
            id={`${id}-hint`}
            role="tooltip"
            style={{ left: hint.x, top: hint.y }}
          >
            <strong>
              {hint.cell.count === 1
                ? `Block ${hint.cell.first}`
                : `Blocks ${hint.cell.first}–${hint.cell.last}`}
            </strong>
            <span>
              {bytes(hint.cell.count * blockSize)} ·{" "}
              {offset(dataStart + hint.cell.first * blockSize)}
            </span>
            <small>
              {hint.cell.count === 1
                ? "Click to inspect block"
                : `${number(hint.cell.count)} blocks · click to expand`}
            </small>
          </div>
        )}
      </div>
      <span className="free-run-values" role="cell">
        <strong>
          {number(run.count)} {run.count === 1 ? "block" : "blocks"}
        </strong>
        <small>{bytes(run.count * blockSize)}</small>
      </span>
    </div>
  );
});
