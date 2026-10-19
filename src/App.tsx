import { IndexView } from "@/components/index-view";
import { Landing } from "@/components/landing";
import { AppSidebar } from "@/components/app-sidebar";
import { DatabaseSummary } from "@/components/database-summary";
import { StorageCompatibilityWarning } from "@/components/storage-compatibility-warning";
import { checkpointStatus, commonSchemaPrefix } from "@/lib/checkpoint-status";
import { useMediaQuery, usePersistentFlag } from "@/hooks/use-persistent-state";
import { DenseByteStrip } from "@/components/dense-byte-strip";
import { BlockRangeDetails } from "@/components/block-range-details";
import { blocksBetween, summarizeBlockRange } from "@/lib/block-range";
import { FreeListView } from "@/components/free-list-view";
import { LogicalColorLegend } from "@/components/logical-color-legend";
import {
  buildLogicalMetrics,
  columnKey,
  logicalAppearance,
  logicalColorOptions,
  nullFraction,
  type LogicalColorMode,
  type SegmentAppearance,
} from "@/lib/logical-colors";
import { fragmentationSummary, internalFreeBytes } from "@/lib/fragmentation";
import { byteRangeAppearance } from "@/lib/byte-range-colors";
import {
  memo,
  useDeferredValue,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  Grid2X2,
  FileCode2,
  FileText,
  HardDrive,
  Layers3,
  LoaderCircle,
  ListTree,
  Search,
  Sparkles,
  Table2,
  Upload,
  X,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useContinuousLayout } from "@/hooks/use-continuous-layout";
import { BlockHeatmap } from "@/components/block-heatmap";
import { DetailTip, InfoTip } from "@/components/detail-tooltip";
import { PhysicalLegend } from "@/components/physical-legend";
import {
  roleColors,
  tablePalette,
  compressionPalette,
  stableColor,
} from "@/lib/palette";
import { formatBytes, formatNumber } from "@/lib/format";
import { decodeMetaPointer } from "@/lib/meta-pointer";
import { describeStatistics } from "@/lib/segment-stats";
import { readBytes } from "@/lib/reader";
import { inspectDatabase } from "@/lib/open-database";
import { applyManifest } from "@/lib/semantic";
import {
  buildRowGroupUnits,
  buildLogicalTables,
  createLogicalLayoutIndex,
  type LogicalRowModel,
  LARGE_BLOCK_COUNT,
  LARGE_SEGMENT_COUNT,
  type RowGroupUnit,
} from "@/lib/layout";
import type {
  CheckpointHeader,
  ColorMode,
  FileBlock,
  FileInspection,
  IndexInspection,
  NativeRowGroup,
  Segment,
  StorageRole,
} from "@/lib/types";

type ViewMode = "physical" | "logical" | "free-list" | "indexes";
type ByteView = { blockId: number; offset: number; bytes: Uint8Array } | null;

function shortName(value: string, max = 20) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function plural(count: number, noun: string) {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function formatOffset(value: number) {
  return `0x${Math.max(0, value).toString(16).padStart(8, "0")}`;
}

function HeaderIcon({ mode }: { mode: ViewMode }) {
  return mode === "physical" ? (
    <HardDrive size={15} />
  ) : mode === "free-list" ? (
    <ListTree size={15} />
  ) : mode === "indexes" ? (
    <ListTree size={15} />
  ) : (
    <Layers3 size={15} />
  );
}

function InspectorEmptyState({ view }: { view: ViewMode }) {
  return (
    <div className="detail-content inspector-empty">
      <p>
        {view === "logical"
          ? "Select a segment to see its column, statistics and physical block."
          : view === "indexes"
            ? "Select an index buffer to inspect the block that stores it."
            : view === "free-list"
              ? "Select a free block or allocator block to inspect it."
              : "Select a block to see its owners, byte layout and raw bytes. Drag across blocks to aggregate them."}
      </p>
      <dl>
        <div>
          <dt>
            <kbd>←</kbd>
            <kbd>→</kbd>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
          </dt>
          <dd>Move between blocks</dd>
        </div>
        <div>
          <dt>
            <kbd>Enter</kbd>
          </dt>
          <dd>Inspect</dd>
        </div>
        {view === "physical" && (
          <div>
            <dt>
              <kbd>⇧</kbd>
              <kbd>Drag</kbd>
            </dt>
            <dd>Select a range</dd>
          </div>
        )}
        <div>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>Clear selection</dd>
        </div>
        <div>
          <dt>
            <kbd>⌘ K</kbd>
          </dt>
          <dd>Search</dd>
        </div>
      </dl>
    </div>
  );
}

function DetailPair({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="detail-pair">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

export interface SidebarChrome {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Below 1080 px the sidebar is a slide-in drawer. */
  narrow: boolean;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  drawerRef: React.RefObject<HTMLElement | null>;
}

interface WorkspaceProps {
  inspection: FileInspection;
  setInspection: (inspection: FileInspection) => void;
  activeFile: File | null;
  loadingFile: boolean;
  dragging: boolean;
  /** Load errors from the shell; the workspace reports manifest errors too. */
  error: string;
  setError: (error: string) => void;
  sidebar: SidebarChrome;
}

/** Everything shown for one loaded database; remounted for each new file. */
function Workspace({
  inspection,
  setInspection,
  activeFile,
  loadingFile,
  dragging,
  error,
  setError,
  sidebar,
}: WorkspaceProps) {
  const {
    collapsed: sidebarCollapsed,
    setCollapsed: setSidebarCollapsed,
    narrow,
    drawerOpen,
    setDrawerOpen,
    drawerRef,
  } = sidebar;
  const [view, setView] = useState<ViewMode>("physical");
  const [colorMode, setColorMode] = useState<ColorMode>("role");
  const [logicalColorMode, setLogicalColorMode] =
    useState<LogicalColorMode>("compression");
  const [valueColumnKey, setValueColumnKey] = useState("");
  const [cellSize, setCellSize] = useState(24);
  const [showValidity, setShowValidity] = useState(true);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selectedBlockId, setSelectedBlockId] = useState<number | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const [selectedHeaderSlot, setSelectedHeaderSlot] = useState<1 | 2 | null>(
    null,
  );
  const [hoveredBlockId, setHoveredBlockId] = useState<number | null>(null);
  // Multi-block selection on the physical map, as two block IDs in file order.
  const [blockRange, setBlockRange] = useState<{
    anchor: number;
    focus: number;
  } | null>(null);
  const [pendingTableScroll, setPendingTableScroll] = useState<string | null>(
    null,
  );
  // Collapsed by default so the data views start near the top.
  const [summaryExpanded, setSummaryExpanded] = usePersistentFlag(
    "atlas-summary-expanded",
    false,
  );
  const [byteView, setByteView] = useState<ByteView>(null);
  const [loadingBytes, setLoadingBytes] = useState(false);
  const [manifestMessage, setManifestMessage] = useState("");
  const manifestInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const manifestImportRequestRef = useRef(0);

  const semanticReady = inspection.capabilities.semantic;
  const blocksById = useMemo(
    () => new Map(inspection.blocks.map((block) => [block.id, block])),
    [inspection.blocks],
  );
  const segmentsById = useMemo(
    () => new Map(inspection.segments.map((segment) => [segment.id, segment])),
    [inspection.segments],
  );
  const selectedBlock = blocksById.get(selectedBlockId ?? NaN) ?? null;
  const selectedSegment =
    selectedSegmentId == null
      ? null
      : (segmentsById.get(selectedSegmentId) ?? null);
  const selectedHeader = useMemo(
    () =>
      inspection.headers.find((header) => header.slot === selectedHeaderSlot) ??
      null,
    [inspection.headers, selectedHeaderSlot],
  );
  const effectiveHoverBlock =
    hoveredBlockId ??
    selectedBlockId ??
    (selectedSegment && selectedSegment.blockId >= 0
      ? selectedSegment.blockId
      : null);
  const linkedBlockIds = useMemo(
    () => new Set(blocksById.get(effectiveHoverBlock ?? NaN)?.links ?? []),
    [blocksById, effectiveHoverBlock],
  );
  const segmentSearch = useMemo(
    () =>
      inspection.segments.map((segment) => ({
        segment,
        text: `${segment.table} ${segment.column} ${segment.columnType} ${segment.compression} ${segment.id} ${segment.rowGroup}`.toLocaleLowerCase(),
      })),
    [inspection.segments],
  );
  const blockSearch = useMemo(
    () =>
      inspection.blocks.map((block) => ({
        block,
        text: `${block.id} ${block.label} ${block.role} ${(block.indexOwners ?? []).map((index) => `${index.table} ${index.name}`).join(" ")}`.toLocaleLowerCase(),
      })),
    [inspection.blocks],
  );
  // An exact table name (e.g. from the sidebar) selects only that table, so
  // `main.part` does not also match `main.partsupp`.
  const exactTable = useMemo(() => {
    const term = deferredQuery.trim().toLocaleLowerCase();
    const names = new Set(
      [
        ...(inspection.native?.catalog ?? []).map((table) => table.name),
        ...inspection.segments.map((segment) => segment.table),
      ].map((name) => name.toLocaleLowerCase()),
    );
    return names.has(term) ? term : null;
  }, [deferredQuery, inspection.native, inspection.segments]);
  const segmentMatches = useCallback(
    (entry: { segment: Segment; text: string }, term: string) =>
      exactTable
        ? entry.segment.table.toLocaleLowerCase() === exactTable
        : entry.text.includes(term),
    [exactTable],
  );
  const matchingBlocks = useMemo(() => {
    const term = deferredQuery.trim().toLocaleLowerCase();
    if (!term) return inspection.blocks;
    const matchingSegmentBlocks = new Set(
      segmentSearch
        .filter(
          (entry) => entry.segment.blockId >= 0 && segmentMatches(entry, term),
        )
        .map((entry) => entry.segment.blockId),
    );
    return blockSearch
      .filter(
        (entry) =>
          (exactTable
            ? (entry.block.indexOwners ?? []).some(
                (index) => index.table.toLocaleLowerCase() === exactTable,
              )
            : entry.text.includes(term)) ||
          matchingSegmentBlocks.has(entry.block.id),
      )
      .map((entry) => entry.block);
  }, [
    inspection.blocks,
    segmentSearch,
    blockSearch,
    deferredQuery,
    exactTable,
    segmentMatches,
  ]);
  const matchingBlockIds = useMemo(
    () => new Set(matchingBlocks.map((block) => block.id)),
    [matchingBlocks],
  );
  const segmentsByBlock = useMemo(() => {
    const byBlock = new Map<number, Segment[]>();
    for (const segment of inspection.segments) {
      if (segment.blockId < 0) continue;
      const blockSegments = byBlock.get(segment.blockId) ?? [];
      blockSegments.push(segment);
      byBlock.set(segment.blockId, blockSegments);
    }
    return byBlock;
  }, [inspection.segments]);
  const filteredSegments = useMemo(() => {
    const term = deferredQuery.trim().toLocaleLowerCase();
    return term
      ? segmentSearch
          .filter((entry) => segmentMatches(entry, term))
          .map((entry) => entry.segment)
      : inspection.segments;
  }, [inspection.segments, segmentSearch, deferredQuery, segmentMatches]);
  const dataBlocks = useMemo(
    () =>
      inspection.blocks
        .filter((block) => block.role !== "header")
        .slice()
        .sort((a, b) => a.offset - b.offset),
    [inspection.blocks],
  );
  const headerBlocks = useMemo(
    () => inspection.blocks.filter((block) => block.role === "header"),
    [inspection.blocks],
  );
  const logicalSegments = useMemo(
    () =>
      showValidity
        ? filteredSegments
        : filteredSegments.filter(
            (segment) => segment.columnType !== "VALIDITY",
          ),
    [filteredSegments, showValidity],
  );
  const hasValidity = useMemo(
    () => inspection.segments.some((s) => s.columnType === "VALIDITY"),
    [inspection.segments],
  );
  const logicalUnits = useMemo(
    () => buildRowGroupUnits(logicalSegments),
    [logicalSegments],
  );
  const firstMatchingBlockId = deferredQuery.trim()
    ? matchingBlocks.find((block) => block.role !== "header")?.id
    : undefined;
  const revealBlockIndex = Math.max(
    dataBlocks.findIndex((block) => block.id === firstMatchingBlockId),
    dataBlocks.findIndex((block) => block.id === selectedBlockId),
  );
  const physicalLayout = useContinuousLayout(
    dataBlocks,
    dataBlocks.length > LARGE_BLOCK_COUNT,
    4096,
    revealBlockIndex,
  );
  const logicalLayout = useContinuousLayout(
    logicalUnits,
    logicalSegments.length > LARGE_SEGMENT_COUNT,
    64,
    selectedSegment
      ? logicalUnits.findIndex(
          (group) =>
            group.table === selectedSegment.table &&
            group.rowGroup === selectedSegment.rowGroup,
        )
      : -1,
  );
  const visibleDataBlocks = useMemo(
    () => dataBlocks.slice(0, physicalLayout.visibleCount),
    [dataBlocks, physicalLayout.visibleCount],
  );
  const visibleLogicalUnits = useMemo(
    () => logicalUnits.slice(0, logicalLayout.visibleCount),
    [logicalUnits, logicalLayout.visibleCount],
  );
  const logicalMetrics = useMemo(
    () => buildLogicalMetrics(inspection.segments),
    [inspection.segments],
  );
  const valueColumn =
    logicalMetrics.valueColumns.find(
      (column) => column.key === valueColumnKey,
    ) ?? logicalMetrics.valueColumns[0];
  const logicalColors = useMemo(
    () =>
      new Map(
        inspection.segments.map((segment) => [
          segment.id,
          logicalAppearance(
            segment,
            logicalColorMode,
            logicalMetrics,
            valueColumn,
          ),
        ]),
      ),
    [inspection.segments, logicalColorMode, logicalMetrics, valueColumn],
  );

  const clearSelection = useCallback(() => {
    setBlockRange(null);
    setSelectedBlockId(null);
    setSelectedSegmentId(null);
    setSelectedHeaderSlot(null);
    setByteView(null);
  }, []);

  const importManifest = useCallback(
    async (file: File) => {
      const requestId = ++manifestImportRequestRef.current;
      const baseInspection = inspection;
      const baseFile = activeFile;
      setError("");
      setManifestMessage("");
      try {
        if (file.size > 128 * 1024 * 1024)
          throw new Error(
            "Semantic manifest files must be 128 MiB or smaller.",
          );
        const parsed: unknown = JSON.parse(await file.text());
        if (
          requestId !== manifestImportRequestRef.current ||
          baseInspection !== inspection ||
          baseFile !== activeFile
        )
          return;
        const updated = applyManifest(baseInspection, parsed);
        setInspection(updated);
        setSelectedSegmentId(null);
        setSelectedBlockId(null);
        setSelectedHeaderSlot(null);
        setByteView(null);

        setLogicalColorMode("compression");
        setView("logical");
        setManifestMessage(`Semantic map added from ${file.name}`);
      } catch (caught) {
        if (
          requestId === manifestImportRequestRef.current &&
          baseInspection === inspection &&
          baseFile === activeFile
        ) {
          setError(
            caught instanceof Error
              ? caught.message
              : "The semantic manifest could not be imported.",
          );
        }
      }
    },
    [activeFile, inspection],
  );

  const chooseSegment = useCallback((segment: Segment) => {
    setSelectedSegmentId(segment.id);
    setSelectedBlockId(segment.blockId >= 0 ? segment.blockId : null);
    setSelectedHeaderSlot(null);
  }, []);

  const chooseBlock = useCallback((block: FileBlock) => {
    setBlockRange(null);
    setSelectedBlockId(block.id);
    setView("physical");
    setSelectedSegmentId(null);
    setSelectedHeaderSlot(null);
  }, []);

  // Any single selection (block, segment, checkpoint) supersedes a range.
  const rangeBlocks = useMemo(() => {
    if (
      !blockRange ||
      selectedBlockId != null ||
      selectedSegmentId != null ||
      selectedHeaderSlot != null
    )
      return null;
    const blocks = blocksBetween(
      dataBlocks,
      blockRange.anchor,
      blockRange.focus,
    );
    return blocks.length > 1 ? blocks : null;
  }, [
    blockRange,
    dataBlocks,
    selectedBlockId,
    selectedSegmentId,
    selectedHeaderSlot,
  ]);
  const rangeBlockIds = useMemo(
    () => (rangeBlocks ? new Set(rangeBlocks.map((block) => block.id)) : null),
    [rangeBlocks],
  );
  const rangeSummary = useMemo(
    () =>
      rangeBlocks
        ? summarizeBlockRange(rangeBlocks, segmentsById, inspection.indexes)
        : null,
    [rangeBlocks, segmentsById, inspection.indexes],
  );
  const selectBlockRange = useCallback(
    (anchorId: number, focusId: number) => {
      const focus = blocksById.get(focusId);
      if (!focus) return;
      // A range needs two distinct data blocks; otherwise select the target.
      if (
        anchorId === focusId ||
        blocksBetween(dataBlocks, anchorId, focusId).length < 2
      ) {
        chooseBlock(focus);
        return;
      }
      setBlockRange({ anchor: anchorId, focus: focusId });
      setSelectedBlockId(null);
      setSelectedSegmentId(null);
      setSelectedHeaderSlot(null);
    },
    [blocksById, dataBlocks, chooseBlock],
  );

  const loadBlockBytes = useCallback(
    async (block: FileBlock, requestedOffset = block.offset) => {
      const requestId = ++requestIdRef.current;
      if (!activeFile) {
        setByteView(null);
        return;
      }
      setLoadingBytes(true);
      try {
        const blockEnd = block.offset + Math.max(0, block.size);
        const start = Math.max(
          block.offset,
          Math.min(requestedOffset, Math.max(block.offset, blockEnd - 1)),
        );
        const length = Math.max(
          0,
          Math.min(64, blockEnd - start, inspection.fileSize - start),
        );
        const bytes = await readBytes(activeFile, start, length);
        if (requestId === requestIdRef.current)
          setByteView({ blockId: block.id, offset: start, bytes });
      } catch {
        if (requestId === requestIdRef.current)
          setByteView({
            blockId: block.id,
            offset: requestedOffset,
            bytes: new Uint8Array(),
          });
      } finally {
        if (requestId === requestIdRef.current) setLoadingBytes(false);
      }
    },
    [activeFile, inspection.fileSize],
  );

  useEffect(() => {
    // The byte target, not the selection gesture, owns the preview lifecycle.
    // Re-selecting it (including checkpoint -> raw header) preserves paging.
    setByteView(null);
    setLoadingBytes(false);
    if (selectedBlock && !loadingFile) {
      const selectedOffset =
        selectedSegment?.blockId === selectedBlock.id
          ? selectedBlock.offset + selectedSegment.offset
          : selectedBlock.offset;
      void loadBlockBytes(selectedBlock, selectedOffset);
    }
    // Invalidate initial reads and page reads on target changes, deselection,
    // file replacement and unmount, even when no replacement read is started.
    return () => {
      requestIdRef.current += 1;
    };
  }, [selectedBlock, selectedSegment, loadBlockBytes, loadingFile]);

  useEffect(() => {
    if (pendingTableScroll == null || view !== "logical") return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-logical-table="${CSS.escape(pendingTableScroll)}"]`,
        )
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
      setPendingTableScroll(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingTableScroll, view, logicalSegments]);

  useEffect(() => {
    if (view !== "physical" || firstMatchingBlockId == null) return;
    document
      .querySelector<HTMLButtonElement>(
        `[data-block-id="${firstMatchingBlockId}"]`,
      )
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [view, firstMatchingBlockId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [role=tooltip], [role=dialog]")
      )
        return;
      // Tooltips close first; a second Escape clears the selection.
      if (document.querySelector("[role=tooltip]")) return;
      clearSelection();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [clearSelection]);

  const selectCheckpoint = (slot: 1 | 2) => {
    setSelectedHeaderSlot(slot);
    setSelectedBlockId(slot === 1 ? -2 : -1);
    setSelectedSegmentId(null);
  };

  const tables = useMemo(() => {
    const names = new Map<string, number>(
      (inspection.native?.catalog ?? []).map((table) => [table.name, 0]),
    );
    for (const segment of inspection.segments)
      names.set(segment.table, (names.get(segment.table) ?? 0) + 1);
    return [...names]
      .map(([name, segments]) => ({ name, segments }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [inspection.segments, inspection.native]);
  const tableSchema = useMemo(
    () => commonSchemaPrefix(tables.map((table) => table.name)),
    [tables],
  );
  const pickTable = (name: string) => {
    const next = query === name ? "" : name;
    setQuery(next);
    if (next && view === "logical") setPendingTableScroll(next);
  };
  const sidebarProps = {
    tables,
    schemaPrefix: tableSchema,
    emptyMessage: inspection.native
      ? "No tables in this checkpoint."
      : "Logical metadata is not available for this file.",
    activeTable: query,
    onPickTable: pickTable,
    headers: inspection.headers,
    activeSlot: inspection.activeHeader,
    selectedSlot: selectedHeaderSlot,
    onSelectCheckpoint: selectCheckpoint,
  };
  const hasHeadingActions = !inspection.native;
  const roleLabels: Record<StorageRole, string> = {
    header: "Headers",
    metadata: "Metadata",
    data: "Table data",
    index: "Indexes",
    free: "Free space",
    unknown: "Unknown",
  };
  const roleSummary = useMemo(
    () =>
      (Object.keys(roleColors) as StorageRole[]).map((role) => ({
        role,
        label: roleLabels[role],
        bytes: inspection.blocks
          .filter((block) => block.role === role)
          .reduce((sum, block) => sum + block.size, 0),
      })),
    [inspection.blocks],
  );
  const fragmentation = useMemo(
    () => fragmentationSummary(inspection),
    [inspection],
  );
  const freeBlockCount = useMemo(
    () =>
      inspection.freeList?.complete !== false
        ? dataBlocks.filter((block) => block.role === "free").length
        : null,
    [dataBlocks, inspection.freeList],
  );
  return (
    <>
      <input
        ref={manifestInputRef}
        className="sr-only"
        type="file"
        accept=".json,application/json"
        aria-label="Choose a semantic manifest JSON file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importManifest(file);
          event.target.value = "";
        }}
      />
      <div
        className={`app-layout${!narrow && sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      >
        {!narrow && (
          <aside
            className={`sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}
            aria-label="Sidebar"
          >
            <AppSidebar
              {...sidebarProps}
              variant={sidebarCollapsed ? "rail" : "full"}
              onExpand={() => setSidebarCollapsed(false)}
            />
          </aside>
        )}
        {narrow && drawerOpen && (
          <>
            <div
              className="sidebar-backdrop"
              aria-hidden="true"
              onClick={() => setDrawerOpen(false)}
            />
            <aside
              className="sidebar sidebar-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Sidebar"
              ref={drawerRef}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDrawerOpen(false);
                }
              }}
            >
              <AppSidebar
                {...sidebarProps}
                variant="full"
                onPickTable={(name) => {
                  sidebarProps.onPickTable(name);
                  setDrawerOpen(false);
                }}
                onSelectCheckpoint={(slot) => {
                  sidebarProps.onSelectCheckpoint(slot);
                  setDrawerOpen(false);
                }}
              />
            </aside>
          </>
        )}
        <main className="main-area">
          <DatabaseSummary
            inspection={inspection}
            blockCount={dataBlocks.length}
            freeBlockCount={freeBlockCount}
            semanticReady={semanticReady}
            tableCount={tables.length}
            fragmentation={fragmentation}
            roles={roleSummary}
            expanded={summaryExpanded}
            onExpandedChange={setSummaryExpanded}
            actions={
              hasHeadingActions ? (
                <>
                  {!inspection.native && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => manifestInputRef.current?.click()}
                      title="Import a duckdb-file-layout/v1 semantic JSON map"
                    >
                      <FileCode2 size={14} />
                      Import metadata
                    </Button>
                  )}
                  {!inspection.native && semanticReady && (
                    <Badge variant="neutral">Imported metadata</Badge>
                  )}
                </>
              ) : undefined
            }
          />
          <StorageCompatibilityWarning version={inspection.storageVersion} />
          {(error || manifestMessage) && (
            <div className="message-stack">
              {error && (
                <div className="message error-message" role="alert">
                  <AlertCircle size={15} />
                  <span>{error}</span>
                  <button
                    type="button"
                    aria-label="Dismiss error"
                    onClick={() => setError("")}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {!error && manifestMessage && (
                <div className="message notice-message" role="status">
                  <CircleHelp size={15} />
                  <span>{manifestMessage}</span>
                  <button
                    type="button"
                    aria-label="Dismiss message"
                    onClick={() => {
                      setManifestMessage("");
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="workspace-tools">
            <Tabs
              value={view}
              onValueChange={(value) => {
                setView(value as ViewMode);
              }}
            >
              <TabsList aria-label="Choose file map view" className="view-tabs">
                <TabsTrigger value="physical">
                  <Grid2X2 size={14} />
                  Physical map
                </TabsTrigger>
                <TabsTrigger value="logical">
                  <Layers3 size={14} />
                  Logical map
                </TabsTrigger>
                <TabsTrigger value="indexes">
                  <ListTree size={14} />
                  Indexes
                </TabsTrigger>
                <TabsTrigger value="free-list">
                  <ListTree size={14} />
                  Free list
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="tools-right">
              <label className="search-box">
                <Search size={14} />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder={
                    view === "indexes"
                      ? "Find an index or table…"
                      : view === "free-list"
                        ? "Find a free block ID…"
                        : "Find a block, table, column…"
                  }
                  aria-label={
                    view === "indexes"
                      ? "Search indexes or tables"
                      : view === "free-list"
                        ? "Search free block IDs"
                        : "Search blocks, tables, or columns"
                  }
                />
                {query ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery("");
                    }}
                  >
                    <X size={12} />
                  </button>
                ) : (
                  <kbd>⌘ K</kbd>
                )}
              </label>
              {(view === "physical" || view === "logical") && (
                <label className="color-select-label">
                  <span>Color</span>
                  <select
                    value={view === "physical" ? colorMode : logicalColorMode}
                    aria-label={
                      view === "physical"
                        ? "Color blocks by"
                        : "Color segments by"
                    }
                    onChange={(event) =>
                      view === "physical"
                        ? setColorMode(event.target.value as ColorMode)
                        : setLogicalColorMode(
                            event.target.value as LogicalColorMode,
                          )
                    }
                  >
                    {view === "logical" ? (
                      logicalColorOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="role">Storage role</option>
                        <option value="table" disabled={!semanticReady}>
                          Table
                        </option>
                        <option value="column" disabled={!semanticReady}>
                          Column
                        </option>
                        <option value="compression" disabled={!semanticReady}>
                          Compression
                        </option>
                        {view === "physical" && (
                          <option value="fragmentation">
                            Internal free space
                          </option>
                        )}
                        <option value="utilization">Space used</option>
                      </>
                    )}
                  </select>
                  <ChevronDown size={12} />
                </label>
              )}
              {view === "logical" && logicalColorMode === "value-range" && (
                <label className="color-select-label value-column-select">
                  <span>Column</span>
                  <select
                    aria-label="Value range column"
                    value={valueColumn?.key ?? ""}
                    disabled={!logicalMetrics.valueColumns.length}
                    onChange={(event) => setValueColumnKey(event.target.value)}
                  >
                    {!logicalMetrics.valueColumns.length && (
                      <option value="">No numeric or date zonemaps</option>
                    )}
                    {logicalMetrics.valueColumns.map((column) => (
                      <option key={column.key} value={column.key}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </label>
              )}
            </div>
          </div>
          <div
            className="content-grid has-selection"
            aria-busy={query !== deferredQuery}
          >
            <section className="map-column" aria-label="File map">
              <div className="map-card">
                <div className="map-card-header">
                  <div>
                    <div className="section-title-row">
                      <HeaderIcon mode={view} />
                      <h2>
                        {view === "physical"
                          ? "Disk blocks"
                          : view === "indexes"
                            ? "Indexes"
                            : view === "free-list"
                              ? "Free list"
                              : "Row groups & columns"}
                      </h2>
                      <span className="count-label">
                        {formatNumber(
                          view === "physical"
                            ? dataBlocks.length
                            : view === "indexes"
                              ? (inspection.indexes?.length ?? 0)
                              : view === "free-list"
                                ? inspection.freeList?.complete
                                  ? inspection.freeList.blockIds.length +
                                    inspection.freeList.implicitBlockIds.length
                                  : null
                                : filteredSegments.length,
                        )}
                      </span>
                    </div>
                  </div>
                  {view === "physical" && (
                    <label
                      className="tile-size-control"
                      style={
                        {
                          "--tile-fill": (cellSize - 4) / (24 - 4),
                        } as React.CSSProperties
                      }
                    >
                      <span>Tile size</span>
                      <input
                        type="range"
                        aria-label="Block tile size"
                        aria-valuetext={`${cellSize} pixel tiles`}
                        min={4}
                        max={24}
                        step={1}
                        value={cellSize}
                        onChange={(event) =>
                          setCellSize(Number(event.target.value))
                        }
                      />
                      <output>{cellSize} px</output>
                    </label>
                  )}
                </div>
                {view === "physical" ? (
                  <div className="map-body">
                    <div
                      className="header-chips"
                      role="group"
                      aria-label="File headers"
                    >
                      <span className="header-chips-label">File headers</span>
                      {headerBlocks.map((block) => {
                        const pressed =
                          selectedBlockId === block.id ||
                          (selectedHeaderSlot === 1 && block.id === -2) ||
                          (selectedHeaderSlot === 2 && block.id === -1);
                        const name =
                          block.id === -3
                            ? "Main header"
                            : `Checkpoint ${block.id === -2 ? 1 : 2}`;
                        return (
                          <DetailTip
                            key={block.id}
                            title={name}
                            rows={[
                              ["Size", formatBytes(block.size)],
                              ["Offset", formatOffset(block.offset)],
                            ]}
                            hint={
                              block.id === -3
                                ? "Precedes block 0 · click to inspect"
                                : "Click to inspect this checkpoint"
                            }
                          >
                            <button
                              type="button"
                              className={`header-chip ${pressed ? "selected" : ""}`}
                              onClick={() =>
                                block.id === -3
                                  ? chooseBlock(block)
                                  : selectCheckpoint(block.id === -2 ? 1 : 2)
                              }
                              onMouseEnter={() => setHoveredBlockId(block.id)}
                              onMouseLeave={() => setHoveredBlockId(null)}
                              aria-pressed={pressed}
                              aria-label={`${block.label}, ${formatBytes(block.size)}`}
                            >
                              <FileText size={12} aria-hidden="true" />
                              {name}
                            </button>
                          </DetailTip>
                        );
                      })}
                    </div>
                    <PhysicalLegend
                      mode={colorMode}
                      semanticReady={semanticReady}
                      blocks={dataBlocks}
                      segmentsByBlock={segmentsByBlock}
                      indexes={inspection.indexes}
                      segments={inspection.segments}
                      matches={
                        query
                          ? matchingBlocks.filter(
                              (block) => block.role !== "header",
                            ).length
                          : null
                      }
                    />
                    <BlockHeatmap
                      blocks={visibleDataBlocks}
                      segmentsByBlock={segmentsByBlock}
                      colorMode={colorMode}
                      selectedBlockId={selectedBlockId}
                      hoveredBlockId={effectiveHoverBlock}
                      matchingBlockIds={query ? matchingBlockIds : null}
                      onSelect={chooseBlock}
                      rangeBlockIds={rangeBlockIds}
                      rangeAnchorId={rangeBlocks ? blockRange!.anchor : null}
                      onSelectRange={selectBlockRange}
                      cellSize={cellSize}
                      linkedBlockIds={linkedBlockIds}
                    />
                    {physicalLayout.hasMore && (
                      <div
                        className="continuous-load"
                        ref={physicalLayout.sentinelRef}
                      >
                        <span>
                          {formatNumber(physicalLayout.visibleCount)} of{" "}
                          {formatNumber(dataBlocks.length)} blocks · more load
                          as you scroll
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={physicalLayout.loadMore}
                        >
                          Load more blocks
                        </Button>
                      </div>
                    )}
                  </div>
                ) : view === "indexes" ? (
                  <IndexView
                    key={inspection.headerFingerprint ?? inspection.name}
                    inspection={inspection}
                    selectedBlockId={selectedBlockId}
                    query={deferredQuery}
                    onPick={(id) => {
                      if (!blocksById.has(id)) return;
                      setSelectedBlockId(id);
                      setSelectedSegmentId(null);
                      setSelectedHeaderSlot(null);
                    }}
                  />
                ) : view === "free-list" ? (
                  <FreeListView
                    inspection={inspection}
                    query={deferredQuery}
                    onPick={(id) => {
                      const block = blocksById.get(id);
                      if (block) chooseBlock(block);
                    }}
                    onCheckpoint={() => {
                      clearSelection();
                      setSelectedHeaderSlot(inspection.activeHeader);
                    }}
                  />
                ) : semanticReady ? (
                  <div className="logical-body">
                    <div className="logical-toolbar">
                      <LogicalColorLegend
                        mode={logicalColorMode}
                        metrics={logicalMetrics}
                        column={valueColumn}
                      />
                      {hasValidity && (
                        <label className="logical-toggle">
                          <input
                            type="checkbox"
                            checked={showValidity}
                            onChange={(event) =>
                              setShowValidity(event.target.checked)
                            }
                          />
                          Validity columns
                        </label>
                      )}
                    </div>
                    {filteredSegments.length === 0 ? (
                      <div className="empty-search">
                        <Search size={16} />
                        {query
                          ? `No segments match “${query}”.`
                          : inspection.native?.catalog?.length
                            ? `${inspection.native.catalog.map((table) => `${table.name} (${table.columns.length} columns, ${table.liveRows == null ? `${table.rows} physical rows, live rows unknown` : `${table.liveRows} live / ${table.rows} physical rows`})`).join(" · ")} · No stored segments.`
                            : "The database contains no tables or stored segments."}
                      </div>
                    ) : (
                      <>
                        <LogicalGroups
                          rowGroupsInfo={inspection.native?.rowGroupsInfo}
                          segments={logicalSegments}
                          groups={visibleLogicalUnits}
                          selectedId={selectedSegmentId}
                          selectedBlockId={selectedBlockId}
                          colors={logicalColors}
                          valueColumnKey={
                            logicalColorMode === "value-range"
                              ? valueColumn?.key
                              : undefined
                          }
                          onPick={chooseSegment}
                        />
                        {logicalLayout.hasMore && (
                          <div
                            className="continuous-load"
                            ref={logicalLayout.sentinelRef}
                          >
                            <span>
                              {formatNumber(logicalLayout.visibleCount)} of{" "}
                              {formatNumber(logicalUnits.length)} row groups ·
                              more load as you scroll
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={logicalLayout.loadMore}
                            >
                              Load more row groups
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="logical-empty-state">
                    <div className="empty-art">
                      <Layers3 size={24} />
                      <span />
                      <span />
                      <span />
                    </div>
                    <Badge variant="warning">
                      <FileCode2 size={12} />
                      Checkpoint decoding unavailable
                    </Badge>
                    <h3>Logical ownership is not available yet</h3>
                    <p>
                      This file’s physical blocks are readable. Import a
                      semantic manifest as a fallback to connect blocks with
                      tables, columns, row groups, and compression.
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => manifestInputRef.current?.click()}
                    >
                      <FileCode2 size={14} />
                      Import semantic map
                    </Button>
                    <small>Manifest format: duckdb-file-layout/v1</small>
                  </div>
                )}
                {dragging && (
                  <div className="drop-overlay">
                    <div>
                      <Upload size={28} />
                      <strong>Drop a database to explore</strong>
                    </div>
                  </div>
                )}
              </div>
            </section>
            {
              <aside
                className={`details-panel${selectedBlock || selectedSegment || selectedHeader || rangeSummary ? "" : " is-empty"}`}
                aria-label="Selection details"
              >
                <div className="details-header">
                  <div>
                    <h2>
                      {selectedHeader
                        ? `Checkpoint ${selectedHeader.slot}`
                        : rangeSummary
                          ? `Blocks ${rangeSummary.firstId}–${rangeSummary.lastId}`
                          : selectedSegment
                            ? selectedSegment.column
                            : selectedBlock
                              ? selectedBlock.role === "header"
                                ? selectedBlock.label
                                : `Block ${selectedBlock.id}`
                              : "Inspector"}
                    </h2>
                    {selectedSegment && !selectedHeader && (
                      <p className="details-subtitle">
                        {selectedSegment.table} · row group{" "}
                        {selectedSegment.rowGroup}
                      </p>
                    )}
                  </div>
                  {(selectedBlock ||
                    selectedSegment ||
                    selectedHeader ||
                    rangeSummary) && (
                    <button
                      type="button"
                      className="details-close"
                      aria-label="Clear selection"
                      title="Clear selection (Esc)"
                      onClick={clearSelection}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
                {selectedHeader ? (
                  <CheckpointDetails
                    checkpoint={selectedHeader}
                    activeSlot={inspection.activeHeader}
                    blocksById={blocksById}
                    onBlockClick={(id) => {
                      const block = blocksById.get(id);
                      if (block) chooseBlock(block);
                    }}
                    onShowFreeList={
                      selectedHeader.slot === inspection.activeHeader
                        ? () => {
                            clearSelection();
                            setView("free-list");
                          }
                        : undefined
                    }
                    onInspectBytes={() => {
                      const block = headerBlocks.find(
                        (item) =>
                          item.id === (selectedHeader.slot === 1 ? -2 : -1),
                      );
                      if (block) chooseBlock(block);
                    }}
                  />
                ) : selectedSegment ? (
                  <SegmentDetails
                    colorMetric={
                      view === "logical"
                        ? {
                            label: logicalColorOptions.find(
                              (option) => option.value === logicalColorMode,
                            )!.label,
                            description: logicalColors.get(selectedSegment.id)!
                              .description,
                          }
                        : undefined
                    }
                    segment={selectedSegment}
                    inspection={inspection}
                    block={selectedBlock}
                    blocksById={blocksById}
                    onBlockClick={chooseBlock}
                  />
                ) : selectedBlock ? (
                  <BlockDetails
                    colorMode={colorMode}
                    onShowFreeList={
                      inspection.freeList &&
                      (selectedBlock.role === "free" ||
                        inspection.freeList.chain.some(
                          (node) => node.blockId === selectedBlock.id,
                        ))
                        ? () => {
                            setQuery(
                              selectedBlock.role === "free"
                                ? String(selectedBlock.id)
                                : "",
                            );
                            clearSelection();
                            setView("free-list");
                          }
                        : undefined
                    }
                    block={selectedBlock}
                    inspection={inspection}
                    segments={segmentsByBlock.get(selectedBlock.id) ?? []}
                    segmentsById={segmentsById}
                    blocksById={blocksById}
                    byteView={
                      byteView?.blockId === selectedBlock.id ? byteView : null
                    }
                    loadingBytes={loadingBytes}
                    onSegmentClick={chooseSegment}
                    onBlockClick={(id) => {
                      const block = blocksById.get(id);
                      if (block) chooseBlock(block);
                    }}
                    onBytePage={(offset) =>
                      void loadBlockBytes(selectedBlock, offset)
                    }
                  />
                ) : rangeSummary ? (
                  <BlockRangeDetails summary={rangeSummary} />
                ) : (
                  <InspectorEmptyState view={view} />
                )}
              </aside>
            }
          </div>
        </main>
      </div>
    </>
  );
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("atlas-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("atlas-theme", theme);
    } catch {
      /* Storage is optional. */
    }
  }, [theme]);

  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [activeFile, setActiveFile] = useState<File | null>(null);
  // Bumped per successful load so the workspace starts fresh for each file.
  const [loadKey, setLoadKey] = useState(0);
  const [loadingFile, setLoadingFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileLoadRequestRef = useRef(0);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => inspectionAbortRef.current?.abort(), []);

  const loadDatabase = useCallback(async (file: File) => {
    const requestId = ++fileLoadRequestRef.current;
    inspectionAbortRef.current?.abort();
    const controller = new AbortController();
    inspectionAbortRef.current = controller;
    setLoadingFile(true);
    setError("");
    try {
      const result = await inspectDatabase(file, controller.signal);
      if (requestId !== fileLoadRequestRef.current) return;
      setInspection(result);
      setActiveFile(file);
      setLoadKey((key) => key + 1);
    } catch (caught) {
      if (requestId === fileLoadRequestRef.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "This file could not be inspected.",
        );
    } finally {
      if (requestId === fileLoadRequestRef.current) {
        setLoadingFile(false);
        setDragging(false);
      }
    }
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentFlag(
    "atlas-sidebar-collapsed",
    false,
  );
  const narrow = useMediaQuery("(max-width: 1080px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    // Move focus into the drawer, and back to its toggle when it closes.
    if (drawerOpen) drawerRef.current?.focus();
    else if (drawerWasOpen.current) sidebarToggleRef.current?.focus();
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);
  const sidebarOpen = narrow ? drawerOpen : !sidebarCollapsed;
  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(max-width: 1080px)").matches)
      setDrawerOpen((open) => !open);
    else setSidebarCollapsed((collapsed) => !collapsed);
  }, [setSidebarCollapsed]);
  useEffect(() => {
    if (!inspection) return;
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.key !== "[" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [inspection, toggleSidebar]);
  const sidebar: SidebarChrome = {
    collapsed: sidebarCollapsed,
    setCollapsed: setSidebarCollapsed,
    narrow,
    drawerOpen,
    setDrawerOpen,
    drawerRef,
  };

  return (
    <div
      className={`app-shell${inspection ? "" : " is-landing"}`}
      data-theme={theme}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (
          !event.relatedTarget ||
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void loadDatabase(file);
      }}
    >
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept=".duckdb,.db,.ddb,application/octet-stream"
        aria-label="Choose a DuckDB database file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void loadDatabase(file);
          event.target.value = "";
        }}
      />
      <header className="topbar">
        <div className="brand-lockup">
          {inspection && (
            <button
              ref={sidebarToggleRef}
              type="button"
              className="sidebar-toggle"
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              aria-expanded={sidebarOpen}
              title={`${sidebarOpen ? "Hide" : "Show"} sidebar ( [ )`}
              onClick={toggleSidebar}
            >
              {sidebarOpen ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
            </button>
          )}
          <span className="brand-mark">
            <Database size={20} strokeWidth={1.6} />
          </span>
          <strong>File Atlas</strong>
          <span className="brand-divider" />
          <span className="brand-subtitle">DuckDB</span>
        </div>
        <div className="topbar-actions">
          <button
            className="theme-toggle"
            type="button"
            aria-label={
              theme === "light"
                ? "Switch to dark theme"
                : "Switch to light theme"
            }
            onClick={() =>
              setTheme((value) => (value === "light" ? "dark" : "light"))
            }
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          {inspection && (
            <Button
              className="open-file-button"
              variant="primary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={loadingFile}
            >
              {loadingFile ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Plus size={16} />
              )}
              {loadingFile ? "Reading file…" : "Open database"}
            </Button>
          )}
        </div>
      </header>
      {inspection ? (
        <Workspace
          key={loadKey}
          inspection={inspection}
          setInspection={setInspection}
          activeFile={activeFile}
          loadingFile={loadingFile}
          dragging={dragging}
          error={error}
          setError={setError}
          sidebar={sidebar}
        />
      ) : (
        <Landing
          loading={loadingFile}
          dragging={dragging}
          error={error}
          onDismissError={() => setError("")}
          onChooseFile={() => fileInputRef.current?.click()}
          onGenerated={loadDatabase}
        />
      )}
    </div>
  );
}

/** Column width grows with its busiest cell so segment strips stay clickable. */
function logicalColumnWidth(maxSegments: number) {
  return Math.round(Math.min(320, Math.max(96, maxSegments * 5 + 20)));
}

const LogicalGroups = memo(function LogicalGroups({
  rowGroupsInfo,
  segments,
  groups,
  selectedId,
  selectedBlockId,
  colors,
  valueColumnKey,
  onPick,
}: {
  rowGroupsInfo?: NativeRowGroup[];
  segments: Segment[];
  groups: RowGroupUnit[];
  selectedId: string | null;
  selectedBlockId: number | null;
  colors: Map<string, SegmentAppearance>;
  valueColumnKey?: string;
  onPick: (segment: Segment) => void;
}) {
  const rowSummaries = useMemo(
    () =>
      new Map(
        (rowGroupsInfo ?? []).map((row) => [
          JSON.stringify([row.table, row.rowGroup]),
          row,
        ]),
      ),
    [rowGroupsInfo],
  );
  const index = useMemo(() => createLogicalLayoutIndex(segments), [segments]);
  const tables = useMemo(
    () => buildLogicalTables(segments, groups, index),
    [segments, groups, index],
  );
  const columnWidths = useMemo(
    () =>
      new Map(
        tables.map((table) => [
          table.name,
          table.columns.map((column) =>
            logicalColumnWidth(
              table.rows.reduce(
                (max, row) =>
                  Math.max(max, row.cells.get(column.name)?.length ?? 0),
                0,
              ),
            ),
          ),
        ]),
      ),
    [tables],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const host = useRef<HTMLDivElement>(null);
  const columnHeaders = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    const header = valueColumnKey
      ? columnHeaders.current.get(valueColumnKey)
      : undefined;
    const scroller = header?.closest<HTMLDivElement>(".logical-table-wrap");
    if (!header || !scroller) return;
    const relativeLeft =
      header.getBoundingClientRect().left -
      scroller.getBoundingClientRect().left;
    scroller.scrollLeft +=
      relativeLeft - (scroller.clientWidth - header.clientWidth) / 2;
  }, [valueColumnKey, tables]);
  // Reveal the selection when arriving from another view or selecting a block
  // elsewhere; `nearest` leaves an already visible segment where it is.
  useEffect(() => {
    if (selectedId == null && selectedBlockId == null) return;
    const target = host.current?.querySelector<HTMLElement>(
      ".segment-choice.selected",
    );
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, selectedBlockId, collapsed]);
  return (
    <div className="logical-groups" ref={host}>
      {tables.map((table) => {
        const isCollapsed = collapsed.has(table.name);
        const widths = columnWidths.get(table.name) ?? [];
        return (
          <section
            className={`table-group${isCollapsed ? " is-collapsed" : ""}`}
            key={table.name}
            data-logical-table={table.name}
          >
            <button
              type="button"
              className="table-group-heading"
              aria-expanded={!isCollapsed}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(table.name)) next.delete(table.name);
                  else next.add(table.name);
                  return next;
                })
              }
            >
              <div className="table-group-name">
                <ChevronDown size={14} className="table-group-chevron" />
                <span className="table-icon">
                  <Table2 size={15} />
                </span>
                <div>
                  <strong>{table.name}</strong>
                  <span>
                    {plural(table.columns.length, "column")} ·{" "}
                    {plural(table.rows.length, "row group")}
                  </span>
                </div>
              </div>
              <Badge variant="neutral">
                {formatNumber(table.segmentCount)} segments
              </Badge>
            </button>
            {!isCollapsed && (
              <div className="logical-table-wrap">
                <div
                  className="logical-table"
                  style={{
                    gridTemplateColumns: `var(--logical-axis-width) ${widths.map((width) => `minmax(${width}px, ${width}fr)`).join(" ")}`,
                  }}
                >
                  <div className="logical-cell logical-axis">Row group</div>
                  {table.columns.map((column) => (
                    <div
                      className={`logical-cell logical-column-head${valueColumnKey === JSON.stringify([table.name, column.name]) ? " value-column-focus" : ""}`}
                      ref={(node) => {
                        const key = JSON.stringify([table.name, column.name]);
                        if (node) columnHeaders.current.set(key, node);
                        else columnHeaders.current.delete(key);
                      }}
                      title={`${column.name} · ${column.type}`}
                      key={column.name}
                    >
                      <strong>{column.name}</strong>
                      <span>{shortName(column.type, 18)}</span>
                    </div>
                  ))}
                  {table.rows.map((row) => (
                    <LogicalRow
                      key={row.group.rowGroup}
                      summary={rowSummaries.get(
                        JSON.stringify([table.name, row.group.rowGroup]),
                      )}
                      model={row}
                      columns={table.columns}
                      selectedId={
                        selectedId != null && row.segmentIds.has(selectedId)
                          ? selectedId
                          : null
                      }
                      selectedBlockId={
                        selectedBlockId != null &&
                        row.blockIds.has(selectedBlockId)
                          ? selectedBlockId
                          : null
                      }
                      colors={colors}
                      valueColumnKey={valueColumnKey}
                      onPick={onPick}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
});

const LogicalRow = memo(function LogicalRow({
  summary,
  model,
  columns,
  selectedId,
  selectedBlockId,
  colors,
  valueColumnKey,
  onPick,
}: {
  summary?: NativeRowGroup;
  model: LogicalRowModel;
  columns: { name: string; type: string }[];
  selectedId: string | null;
  selectedBlockId: number | null;
  colors: Map<string, SegmentAppearance>;
  valueColumnKey?: string;
  onPick: (segment: Segment) => void;
}) {
  const { coverage } = model;
  const group = model.group.rowGroup;
  return (
    <>
      <div className="logical-cell row-label">
        <span>RG {group}</span>
        <small>
          {summary
            ? summary.liveRows === summary.physicalRows
              ? `${formatNumber(summary.physicalRows)} rows`
              : `${formatNumber(summary.liveRows)} live / ${formatNumber(summary.physicalRows)} physical`
            : coverage
              ? `${formatNumber(coverage.count)} rows`
              : "Unknown rows"}
        </small>
        {summary && summary.deletedRows > 0 && (
          <small className="row-label-deleted">
            {formatNumber(summary.deletedRows)} deleted
          </small>
        )}
      </div>
      {columns.map(({ name: column }) => {
        const cellSegments = model.cells.get(column) ?? [];
        if (cellSegments.length === 0)
          return (
            <div
              key={`${group}-${column}`}
              className="logical-cell logical-gap"
            >
              <span>—</span>
            </div>
          );
        return (
          <div
            key={`${group}-${column}`}
            className="logical-cell segment-cell-stack"
            title={
              cellSegments.length > 1
                ? `${cellSegments.length} segments; widths are proportional to rows`
                : undefined
            }
          >
            {cellSegments.map((segment) => {
              const selected =
                segment.id === selectedId ||
                segment.blockId === selectedBlockId;
              const appearance = colors.get(segment.id)!;
              const outsideColumn =
                valueColumnKey != null && columnKey(segment) !== valueColumnKey;
              return (
                <button
                  type="button"
                  className={`segment-choice${selected ? " selected" : ""}${segment.blockId < 0 ? " metadata-only" : ""}${outsideColumn ? " outside-value-column" : ""}`}
                  key={segment.id}
                  style={
                    {
                      "--block-color": appearance.background,
                      flexGrow: Math.max(1, segment.rowCount),
                    } as React.CSSProperties
                  }
                  onClick={() => onPick(segment)}
                  aria-pressed={selected}
                  aria-label={`${segment.table}, ${segment.column}, row group ${segment.rowGroup}, ${segment.compression}, ${formatBytes(segment.byteSize)}, ${segment.blockId >= 0 ? `block ${segment.blockId}` : "constant, no data block"}, ${appearance.description}`}
                  title={`${segment.table}.${segment.column}\nRow group ${segment.rowGroup} · rows ${formatNumber(segment.rowStart)}–${formatNumber(segment.rowStart + segment.rowCount - 1)}\n${segment.compression} · ${formatBytes(segment.byteSize)} · ${segment.blockId >= 0 ? `Block ${segment.blockId}` : "Constant · no data block"}\n${appearance.description}`}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
});

function MetaPointerValue({
  raw,
  blocksById,
  onBlockClick,
}: {
  raw: string;
  blocksById: Map<number, FileBlock>;
  onBlockClick: (id: number) => void;
}) {
  const pointer = decodeMetaPointer(raw);
  if (!raw) return <>Unknown</>;
  if (!pointer) return <span title={`Raw value ${raw}`}>None</span>;
  const label = `Block ${pointer.blockId} · slot ${pointer.slot}`;
  return blocksById.has(pointer.blockId) ? (
    <button
      type="button"
      className="inline-block-link"
      title={`Raw pointer ${raw}. Click to inspect block ${pointer.blockId}.`}
      onClick={() => onBlockClick(pointer.blockId)}
    >
      {label}
      <ArrowUpRight size={11} />
    </button>
  ) : (
    <span title={`Raw pointer ${raw}`}>{label}</span>
  );
}

function CheckpointDetails({
  checkpoint,
  activeSlot,
  blocksById,
  onBlockClick,
  onShowFreeList,
  onInspectBytes,
}: {
  checkpoint: CheckpointHeader;
  activeSlot: 1 | 2;
  blocksById: Map<number, FileBlock>;
  onBlockClick: (id: number) => void;
  onShowFreeList?: () => void;
  onInspectBytes: () => void;
}) {
  const status = checkpointStatus(checkpoint, activeSlot);
  return (
    <div className="detail-content">
      <div className="selected-kind-row">
        <span
          className={`role-dot ${checkpoint.valid ? "valid-dot" : "invalid-dot"}`}
        />
        <span>Checkpoint snapshot</span>
        <Badge variant={status.tone === "invalid" ? "warning" : "default"}>
          {status.label}
        </Badge>
      </div>
      <p className="section-caption">
        {status.tone === "active"
          ? "DuckDB reads this checkpoint because it is the newest valid header."
          : status.tone === "previous"
            ? "An older valid checkpoint that DuckDB keeps for crash recovery. Its pointers may reference blocks that have since been reused."
            : "This header failed checksum validation and is ignored."}
      </p>
      <div className="detail-card">
        <span className="detail-card-kicker">Header fields</span>
        <DetailPair
          label="Iteration"
          value={checkpoint.iteration || "Unknown"}
          mono
        />
        <DetailPair
          label="Metadata root"
          value={
            <MetaPointerValue
              raw={checkpoint.metaBlock}
              blocksById={blocksById}
              onBlockClick={onBlockClick}
            />
          }
          mono
        />
        <DetailPair
          label="Free list"
          value={
            <MetaPointerValue
              raw={checkpoint.freeList}
              blocksById={blocksById}
              onBlockClick={onBlockClick}
            />
          }
          mono
        />
        {onShowFreeList && (
          <Button variant="secondary" size="sm" onClick={onShowFreeList}>
            Inspect free list <ArrowRight size={12} />
          </Button>
        )}
        <DetailPair
          label="Block count"
          value={formatNumber(checkpoint.blockCount)}
        />
        <DetailPair
          label="Block size"
          value={formatBytes(checkpoint.blockSize)}
        />
        <DetailPair
          label="Vector size"
          value={formatNumber(checkpoint.vectorSize)}
        />
        <DetailPair
          label="Storage version"
          value={formatNumber(checkpoint.storageVersion)}
        />
      </div>
      <button
        className="raw-header-link"
        type="button"
        onClick={onInspectBytes}
      >
        <FileText size={13} />
        Inspect raw header page
        <ArrowRight size={13} />
      </button>
    </div>
  );
}

function BlockDetails({
  onShowFreeList,
  colorMode,
  block,
  inspection,
  segmentsById,
  blocksById,
  segments,
  byteView,
  loadingBytes,
  onSegmentClick,
  onBlockClick,
  onBytePage,
}: {
  colorMode: ColorMode;
  block: FileBlock;
  inspection: FileInspection;
  segmentsById: Map<string, Segment>;
  blocksById: Map<number, FileBlock>;
  segments: Segment[];
  byteView: ByteView;
  loadingBytes: boolean;
  onSegmentClick: (segment: Segment) => void;
  onBlockClick: (id: number) => void;
  onBytePage: (offset: number) => void;
  onShowFreeList?: () => void;
}) {
  const [visibleRanges, setVisibleRanges] = useState(128);
  useEffect(() => setVisibleRanges(128), [block.id]);
  const usedPercent =
    block.usedBytes == null || block.size <= 0
      ? null
      : Number(((block.usedBytes / block.size) * 100).toFixed(1));
  const linkedBlocks = block.links
    .map((id) => blocksById.get(id))
    .filter((candidate): candidate is FileBlock => Boolean(candidate));
  const orderedRanges = [...block.ranges].sort(
    (a, b) => a.offset - b.offset || a.size - b.size,
  );
  const rangeAppearances = new Map(
    orderedRanges.map((range) => [
      range.id,
      byteRangeAppearance(
        range,
        block,
        colorMode,
        range.segmentId ? segmentsById.get(range.segmentId) : undefined,
        range.indexId
          ? (inspection.indexes?.find((index) => index.id === range.indexId) ??
              block.indexOwners?.find((index) => index.id === range.indexId))
          : undefined,
      ),
    ]),
  );
  return (
    <div className="detail-content">
      <div className="selected-kind-row">
        <span
          className="role-dot"
          style={{ backgroundColor: roleColors[block.role] }}
        />
        <span>{block.role} block</span>
      </div>
      <div className="detail-card">
        {onShowFreeList && (
          <Button variant="secondary" size="sm" onClick={onShowFreeList}>
            {block.role === "free"
              ? "Show free list entry"
              : "Inspect free list"}
            <ArrowRight size={12} />
          </Button>
        )}
        <DetailPair
          label="Byte offset"
          value={formatOffset(block.offset)}
          mono
        />
        <DetailPair
          label="Space used"
          value={
            usedPercent == null ? (
              "Unknown"
            ) : (
              <span
                className="space-used-value"
                title={`${formatBytes(block.usedBytes, true)} of ${formatBytes(block.size, true)}`}
              >
                <span className="space-used-meter" aria-hidden="true">
                  <i style={{ width: `${usedPercent}%` }} />
                </span>
                {formatBytes(block.usedBytes)} · {usedPercent}%
              </span>
            )
          }
        />
        {block.role !== "free" && (
          <DetailPair
            label="Internal free space"
            value={formatBytes(internalFreeBytes(block), true)}
          />
        )}
        {block.role === "index" && (
          <>
            <DetailPair
              label="Free slot holes"
              value={formatBytes(
                block.usedBytes == null
                  ? null
                  : block.ranges
                      .filter(
                        (range) =>
                          range.kind === "unused" && range.indexId != null,
                      )
                      .reduce((sum, range) => sum + range.size, 0),
                true,
              )}
            />
            <DetailPair
              label="Unallocated tail"
              value={formatBytes(
                block.usedBytes == null
                  ? null
                  : block.ranges
                      .filter(
                        (range) =>
                          range.kind === "unused" && range.indexId == null,
                      )
                      .reduce((sum, range) => sum + range.size, 0),
                true,
              )}
            />
          </>
        )}
        {block.checksum != null && (
          <DetailPair label="Checksum" value={block.checksum} mono />
        )}
        {block.role !== "free" &&
          !block.indexOwners?.length &&
          segments.length === 0 && (
            <DetailPair label="Contents" value={block.label || "Unknown"} />
          )}
        {block.role === "free" && inspection.freeList && (
          <>
            <DetailPair
              label="Allocation source"
              value={
                inspection.freeList.implicitBlockIds.includes(block.id)
                  ? "Outside checkpoint extent"
                  : `Checkpoint ${inspection.freeList.checkpoint} free list`
              }
            />
            <DetailPair
              label="Available for reuse"
              value={formatBytes(block.size)}
            />
          </>
        )}
        {inspection.freeList?.chain.some(
          (node) => node.blockId === block.id,
        ) && (
          <DetailPair
            label="Allocator role"
            value={`Free-list storage · checkpoint ${inspection.freeList.checkpoint}`}
          />
        )}
        {inspection.freeList?.multiUseBlocks.some(
          (entry) => entry.blockId === block.id,
        ) && (
          <DetailPair
            label="Free-list references"
            value={
              inspection.freeList.multiUseBlocks.find(
                (entry) => entry.blockId === block.id,
              )!.references
            }
          />
        )}
      </div>

      <div className="detail-section">
        <div className="detail-section-heading">
          <span>Byte layout</span>
          <span>{block.ranges.length} ranges</span>
        </div>
        {block.ranges.length > 0 ? (
          <>
            <div
              className="byte-strip"
              role="group"
              aria-label="Proportional byte ranges within block"
            >
              {orderedRanges.length > 512 ? (
                <DenseByteStrip
                  block={block}
                  ranges={orderedRanges}
                  appearances={rangeAppearances}
                />
              ) : (
                orderedRanges.map((range) => {
                  const rawLeft =
                    block.size > 0
                      ? ((range.offset - block.offset) / block.size) * 100
                      : 0;
                  const rawWidth =
                    block.size > 0 ? (range.size / block.size) * 100 : 0;
                  const left = Math.max(0, Math.min(100, rawLeft));
                  const width = Math.max(
                    0,
                    Math.min(100 - left, rawWidth - Math.max(0, -rawLeft)),
                  );
                  const segment = range.segmentId
                    ? segmentsById.get(range.segmentId)
                    : undefined;
                  return (
                    <button
                      type="button"
                      key={range.id}
                      className={`byte-range range-${range.kind}`}
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        background: rangeAppearances.get(range.id)!.background,
                      }}
                      title={`${range.label}: ${formatBytes(range.size)} at ${formatOffset(range.offset)}${segment ? " · Select owning segment" : ""}`}
                      aria-label={`${range.label}, ${formatBytes(range.size)}, offset ${formatOffset(range.offset)}${segment ? ", jump to segment details" : ""}`}
                      disabled={!segment}
                      onClick={() => {
                        if (segment) onSegmentClick(segment);
                      }}
                    />
                  );
                })
              )}
            </div>
            <div className="range-list">
              {orderedRanges.slice(0, visibleRanges).map((range) => {
                const segment = range.segmentId
                  ? segmentsById.get(range.segmentId)
                  : undefined;
                return (
                  <button
                    type="button"
                    className={`range-row ${segment ? "range-row-linked" : ""}`}
                    key={range.id}
                    title={`${range.label}\n${formatOffset(range.offset)} · ${formatNumber(range.size)} bytes${segment ? " · Jump to segment" : ""}`}
                    disabled={!segment}
                    onClick={() => {
                      if (segment) onSegmentClick(segment);
                    }}
                  >
                    <i
                      className={`range-swatch range-${range.kind}`}
                      style={{
                        background: rangeAppearances.get(range.id)!.background,
                      }}
                    />
                    <span>{range.label}</span>
                    <small>{formatOffset(range.offset)}</small>
                    <strong>{formatBytes(range.size)}</strong>
                  </button>
                );
              })}
            </div>
            {visibleRanges < orderedRanges.length && (
              <div className="range-load-more">
                <span>
                  {Math.min(
                    visibleRanges,
                    orderedRanges.length,
                  ).toLocaleString()}{" "}
                  of {orderedRanges.length.toLocaleString()} ranges
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setVisibleRanges((count) => count + 128)}
                >
                  Load more ranges
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="preview-unavailable">
            <AlertCircle size={14} />
            This inspection has no byte-range metadata for the block.
          </div>
        )}
      </div>

      {(block.indexOwners?.length ?? 0) > 0 && (
        <div className="detail-section">
          <div className="detail-section-heading">
            <span className="heading-with-info">
              Index ownership
              <InfoTip label="About index ownership">
                <p>
                  Index nodes are not column codec data. Internal free bytes can
                  include both free slot holes and unallocated block tails;
                  neither is a whole reusable free block.
                </p>
              </InfoTip>
            </span>
            <span>
              {block.indexOwners!.length} index
              {block.indexOwners!.length === 1 ? "" : "es"}
            </span>
          </div>
          {block.indexOwners!.map((index) => (
            <DetailPair key={index.id} label={index.table} value={index.name} />
          ))}
        </div>
      )}
      {segments.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-heading">
            <span>Logical ownership</span>
            <span>
              {segments.length} segment{segments.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="owner-list">
            {segments.map((segment) => (
              <button
                type="button"
                className="owner-row"
                key={segment.id}
                onClick={() => onSegmentClick(segment)}
              >
                <span className="owner-table-icon">
                  <Table2 size={13} />
                </span>
                <span>
                  <strong>
                    {segment.table}.{segment.column}
                  </strong>
                  <small>
                    Row group {segment.rowGroup} · {segment.compression}
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        </div>
      )}

      {linkedBlocks.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-heading">
            <span>Pointer links</span>
            <span>
              {linkedBlocks.length} target{linkedBlocks.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="link-list">
            {linkedBlocks.map((target) => (
              <button
                type="button"
                key={target.id}
                className="link-chip"
                onClick={() => onBlockClick(target.id)}
              >
                <ArrowDownRight size={13} />
                Block {target.id}
                <span>{target.role}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="detail-section hex-section">
        <div className="detail-section-heading">
          <span>Byte preview</span>
          <span>64-byte page</span>
        </div>
        {
          <>
            <div className="byte-page-toolbar">
              <button
                type="button"
                disabled={!byteView || byteView.offset <= block.offset}
                onClick={() =>
                  onBytePage(
                    Math.max(
                      block.offset,
                      (byteView?.offset ?? block.offset) - 64,
                    ),
                  )
                }
                aria-label="Previous 64 bytes"
              >
                <ChevronLeft size={13} />
                Previous
              </button>
              <span>{byteView ? formatOffset(byteView.offset) : "—"}</span>
              <button
                type="button"
                disabled={
                  !byteView ||
                  byteView.offset + byteView.bytes.length >=
                    Math.min(block.offset + block.size, inspection.fileSize)
                }
                onClick={() =>
                  onBytePage(
                    Math.min(
                      block.offset + block.size - 1,
                      (byteView?.offset ?? block.offset) + 64,
                    ),
                  )
                }
                aria-label="Next 64 bytes"
              >
                Next
                <ChevronRight size={13} />
              </button>
            </div>
            {loadingBytes ? (
              <div className="preview-unavailable">
                <LoaderCircle size={14} className="spin" />
                Reading local file bytes…
              </div>
            ) : byteView && byteView.bytes.length > 0 ? (
              <HexPreview offset={byteView.offset} bytes={byteView.bytes} />
            ) : (
              <div className="preview-unavailable">
                <AlertCircle size={14} />
                Raw byte preview is unavailable for this block.
              </div>
            )}
          </>
        }
      </div>
    </div>
  );
}

const HEX_ROW_BYTES = 8;

function HexPreview({ offset, bytes }: { offset: number; bytes: Uint8Array }) {
  // Eight bytes per row keep offset, hex and ASCII inside the inspector.
  const rows = Array.from(
    { length: Math.ceil(bytes.length / HEX_ROW_BYTES) },
    (_, index) =>
      Array.from(
        bytes.slice(index * HEX_ROW_BYTES, (index + 1) * HEX_ROW_BYTES),
      ),
  );
  return (
    <div
      className="hex-view"
      aria-label={`${bytes.length} byte hexadecimal preview`}
    >
      {rows.map((row, rowIndex) => (
        <div className="hex-row" key={rowIndex}>
          <span className="hex-offset">
            {formatOffset(offset + rowIndex * HEX_ROW_BYTES).slice(2)}
          </span>
          <span className="hex-bytes">
            {row.map((byte, index) => (
              <i key={index}>{byte.toString(16).padStart(2, "0")}</i>
            ))}
          </span>
          <span className="hex-ascii">
            {row.map((byte, index) => (
              <i key={index}>
                {byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "·"}
              </i>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function SegmentDetails({
  colorMetric,
  segment,
  inspection,
  blocksById,
  block,
  onBlockClick,
}: {
  colorMetric?: { label: string; description: string };
  segment: Segment;
  inspection: FileInspection;
  blocksById: Map<number, FileBlock>;
  block: FileBlock | null;
  onBlockClick: (block: FileBlock) => void;
}) {
  const rowSummary = inspection.native?.rowGroupsInfo?.find(
    (row) => row.table === segment.table && row.rowGroup === segment.rowGroup,
  );
  const linked =
    block?.links
      .map((id) => blocksById.get(id))
      .filter((candidate): candidate is FileBlock => Boolean(candidate)) ?? [];
  const statistics = describeStatistics(segment.stats);
  const bound = (value: string | undefined, prefix: boolean) =>
    value == null ? (
      "Not recorded"
    ) : prefix ? (
      <span title="DuckDB stores a truncated prefix for this string bound">
        {value}… <small className="bound-note">prefix</small>
      </span>
    ) : (
      value
    );
  return (
    <div className="detail-content">
      <div className="selected-kind-row">
        <span
          className="role-dot"
          style={{ backgroundColor: stableColor(segment.table, tablePalette) }}
        />
        <span>Data segment</span>
        <Badge variant="purple">{segment.compression}</Badge>
      </div>
      <div className="detail-card">
        <DetailPair label="Type" value={segment.columnType || "Unknown"} />
        <DetailPair
          label="Rows"
          value={
            <>
              {formatNumber(segment.rowCount)}{" "}
              <small className="detail-pair-note">
                {formatNumber(segment.rowStart)}–
                {formatNumber(segment.rowStart + segment.rowCount - 1)}
              </small>
            </>
          }
        />
        <DetailPair label="Byte size" value={formatBytes(segment.byteSize)} />
        {colorMetric && colorMetric.label !== "Compression" && (
          <DetailPair
            label={colorMetric.label}
            value={colorMetric.description}
          />
        )}
        <DetailPair
          label="Offset in block"
          value={
            segment.blockId >= 0
              ? `+${formatOffset(segment.offset)}`
              : "No physical payload"
          }
          mono
        />
        <DetailPair
          label="Minimum"
          value={bound(segment.min, statistics?.minPrefix ?? false)}
          mono
        />
        <DetailPair
          label="Maximum"
          value={bound(segment.max, statistics?.maxPrefix ?? false)}
          mono
        />
        <DetailPair
          label="Null count"
          value={formatNumber(
            segment.nullCount ??
              (nullFraction(segment) === 0
                ? 0
                : nullFraction(segment) === 1
                  ? segment.rowCount
                  : undefined),
          )}
        />
        {statistics?.rows.map(([label, value]) => (
          <DetailPair key={label} label={label} value={value} />
        ))}
        {statistics?.raw && (
          <DetailPair label="Statistics" value={statistics.raw} />
        )}
      </div>
      {rowSummary && (
        <div className="detail-card">
          <span className="detail-card-kicker">
            Row group {formatNumber(segment.rowGroup)}
          </span>
          <DetailPair
            label="Physical rows"
            value={formatNumber(rowSummary.physicalRows)}
          />
          <DetailPair
            label="Live rows"
            value={formatNumber(rowSummary.liveRows)}
          />
          <DetailPair
            label="Deleted rows"
            value={formatNumber(rowSummary.deletedRows)}
          />
          {rowSummary.deleteVectors.length > 0 && (
            <>
              <DetailPair
                label="Delete vectors"
                value={`${formatNumber(rowSummary.deleteVectors.length)} · ${[
                  ...new Set(
                    rowSummary.deleteVectors.map((vector) => vector.encoding),
                  ),
                ].join(", ")}`}
              />
              <DetailPair
                label="Deleted row runs"
                value={formatNumber(
                  rowSummary.deleteVectors.reduce(
                    (sum, vector) => sum + vector.deletedRanges.length,
                    0,
                  ),
                )}
              />
            </>
          )}
          {rowSummary.deletedRows > 0 && (
            <p className="section-caption">
              Deleted rows are hidden by the checkpoint but still occupy
              storage.
            </p>
          )}
        </div>
      )}
      {block && (
        <div className="detail-section">
          <div className="detail-section-heading">
            <span>Physical placement</span>
          </div>
          <button
            type="button"
            className="physical-link-card"
            onClick={() => onBlockClick(block)}
          >
            <span className="physical-link-icon">
              <Blocks size={15} />
            </span>
            <span>
              <strong>Block {block.id}</strong>
              <small>
                {formatOffset(block.offset)} · {formatBytes(block.size)}
              </small>
            </span>
            <ArrowRight size={14} />
          </button>
          {linked.length > 0 && (
            <div className="link-list segment-link-list">
              {linked.map((target) => (
                <button
                  className="link-chip"
                  type="button"
                  key={target.id}
                  onClick={() => onBlockClick(target)}
                >
                  <ArrowDownRight size={13} />
                  Block {target.id}
                  <span>{target.role}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!inspection.native && (
        <div className="inspector-note">
          <FileCode2 size={14} />
          <span>
            Values come from the imported map; missing fields stay unknown.
          </span>
        </div>
      )}
    </div>
  );
}
