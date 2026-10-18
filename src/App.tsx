import { IndexView } from "@/components/index-view";
import { DenseByteStrip } from "@/components/dense-byte-strip";
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
  Sun,
  Plus,
  Info,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useContinuousLayout } from "@/hooks/use-continuous-layout";
import { BlockHeatmap } from "@/components/block-heatmap";
import {
  roleColors,
  tablePalette,
  compressionPalette,
  stableColor,
} from "@/lib/palette";
import { createDemo } from "@/lib/demo";
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

function formatBytes(value: number | null | undefined, precise = false) {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024)
    return `${(value / 1024).toFixed(precise ? 1 : value >= 10 * 1024 ? 0 : 1)} KiB`;
  if (value < 1024 ** 3)
    return `${(value / 1024 ** 2).toFixed(precise ? 1 : value >= 10 * 1024 ** 2 ? 0 : 1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

const numberFormatter = new Intl.NumberFormat();

function formatNumber(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "Unknown"
    : numberFormatter.format(value);
}

function shortName(value: string, max = 20) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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

function CheckpointCard({
  checkpoint,
  active,
  onClick,
}: {
  checkpoint: CheckpointHeader;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`checkpoint-card ${active ? "selected" : ""}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="checkpoint-indicator" />
      <span className="checkpoint-copy">
        <span className="checkpoint-title">Checkpoint {checkpoint.slot}</span>
        <span className="checkpoint-subtitle">
          {checkpoint.valid
            ? `Iteration ${checkpoint.iteration}`
            : "Invalid snapshot"}
        </span>
      </span>
      <span className={`checkpoint-state ${checkpoint.valid ? "valid" : ""}`}>
        {checkpoint.valid ? "Valid" : "Invalid"}
      </span>
    </button>
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
  const [inspection, setInspection] = useState<FileInspection>(() =>
    createDemo(),
  );
  const [view, setView] = useState<ViewMode>("physical");
  const [colorMode, setColorMode] = useState<ColorMode>("role");
  const [logicalColorMode, setLogicalColorMode] =
    useState<LogicalColorMode>("compression");
  const [valueColumnKey, setValueColumnKey] = useState("");
  const [cellSize, setCellSize] = useState(8);
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
  const [activeFile, setActiveFile] = useState<File | null>(null);
  const [byteView, setByteView] = useState<ByteView>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [loadingBytes, setLoadingBytes] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [manifestMessage, setManifestMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const manifestInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const fileLoadRequestRef = useRef(0);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => inspectionAbortRef.current?.abort(), []);
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
  const matchingBlocks = useMemo(() => {
    const term = deferredQuery.trim().toLocaleLowerCase();
    if (!term) return inspection.blocks;
    const matchingSegmentBlocks = new Set(
      segmentSearch
        .filter(
          (entry) => entry.segment.blockId >= 0 && entry.text.includes(term),
        )
        .map((entry) => entry.segment.blockId),
    );
    return blockSearch
      .filter(
        (entry) =>
          entry.text.includes(term) ||
          matchingSegmentBlocks.has(entry.block.id),
      )
      .map((entry) => entry.block);
  }, [inspection.blocks, segmentSearch, blockSearch, deferredQuery]);
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
          .filter((entry) => entry.text.includes(term))
          .map((entry) => entry.segment)
      : inspection.segments;
  }, [inspection.segments, segmentSearch, deferredQuery]);
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
  const logicalUnits = useMemo(
    () => buildRowGroupUnits(filteredSegments),
    [filteredSegments],
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
    filteredSegments.length > LARGE_SEGMENT_COUNT,
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
    setSelectedBlockId(null);
    setSelectedSegmentId(null);
    setSelectedHeaderSlot(null);
    setByteView(null);
  }, []);

  const loadDatabase = useCallback(
    async (file: File) => {
      const requestId = ++fileLoadRequestRef.current;
      inspectionAbortRef.current?.abort();
      const controller = new AbortController();
      inspectionAbortRef.current = controller;
      manifestImportRequestRef.current += 1;
      requestIdRef.current += 1;
      setByteView(null);
      setLoadingBytes(false);
      setLoadingFile(true);
      setError("");
      setManifestMessage("");
      try {
        const result = await inspectDatabase(file, controller.signal);
        if (requestId !== fileLoadRequestRef.current) return;
        setInspection(result);
        setActiveFile(file);
        setView("physical");
        setColorMode("role");
        setLogicalColorMode("compression");
        setValueColumnKey("");
        setQuery("");

        clearSelection();
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
    },
    [clearSelection],
  );

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
    setSelectedBlockId(block.id);
    setView("physical");
    setSelectedSegmentId(null);
    setSelectedHeaderSlot(null);
  }, []);

  const loadBlockBytes = useCallback(
    async (block: FileBlock, requestedOffset = block.offset) => {
      const requestId = ++requestIdRef.current;
      if (!activeFile || inspection.source !== "file") {
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
    [activeFile, inspection.fileSize, inspection.source],
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
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const selectCheckpoint = (slot: 1 | 2) => {
    setSelectedHeaderSlot(slot);
    setSelectedBlockId(slot === 1 ? -2 : -1);
    setSelectedSegmentId(null);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void loadDatabase(file);
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
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("atlas-theme", theme);
    } catch {
      /* Storage is optional. */
    }
  }, [theme]);
  return (
    <div
      className="app-shell"
      data-theme={theme}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
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
      <header className="topbar">
        <div className="brand-lockup">
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
        </div>
      </header>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="side-section">
            <div className="eyebrow-row">
              <span className="eyebrow">TABLES</span>
              <span className="side-count">{tables.length}</span>
            </div>
            {tables.length ? (
              <div className="side-tables">
                {tables.map((table) => (
                  <button
                    type="button"
                    key={table.name}
                    className={query === table.name ? "active" : ""}
                    onClick={() => {
                      setQuery(query === table.name ? "" : table.name);
                    }}
                    title={`${table.name} · ${table.segments} segments`}
                  >
                    <Table2 size={14} />
                    <span>{table.name.replace(/^analytics\./, "")}</span>
                    <small>{table.segments}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="side-empty">
                {inspection.native
                  ? "No tables in this checkpoint."
                  : "Logical metadata is not available for this file."}
              </p>
            )}
          </div>
          <div className="side-section side-section-divider">
            <span className="eyebrow">FILE PROPERTIES</span>
            <div className="overview-stat">
              <span>Storage revision</span>
              <strong>v{inspection.storageVersion}</strong>
            </div>
            <div className="overview-stat">
              <span>Block allocation</span>
              <strong>{formatBytes(inspection.blockSize)}</strong>
            </div>
            <div className="overview-stat">
              <span>Vector size</span>
              <strong>{formatNumber(inspection.vectorSize)}</strong>
            </div>
          </div>
          <div className="side-section side-section-divider">
            <div className="eyebrow-row">
              <span className="eyebrow">CHECKPOINTS</span>
              <span className="side-count">{inspection.headers.length}</span>
            </div>
            <div className="checkpoint-list">
              {inspection.headers.map((header) => (
                <CheckpointCard
                  key={header.slot}
                  checkpoint={header}
                  active={selectedHeaderSlot === header.slot}
                  onClick={() => selectCheckpoint(header.slot)}
                />
              ))}
            </div>
          </div>
        </aside>
        <main className="main-area">
          <div className="workspace-heading">
            <div>
              <h1>{inspection.name}</h1>
            </div>
            <div className="heading-actions">
              {inspection.source === "file" && !inspection.native && (
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
              {inspection.source === "demo" && (
                <Badge variant="neutral">Example</Badge>
              )}
              {inspection.source === "file" &&
                !inspection.native &&
                semanticReady && (
                  <Badge variant="neutral">Imported metadata</Badge>
                )}
            </div>
          </div>
          <section className="overview-card" aria-label="Database overview">
            <div className="overview-metrics">
              <div className="hero-metric">
                <span className="eyebrow">FILE FOOTPRINT</span>
                <strong>{formatBytes(inspection.fileSize)}</strong>
                <small>{formatNumber(inspection.fileSize)} bytes on disk</small>
              </div>
              <div className="support-metric">
                <span className="eyebrow">PHYSICAL BLOCKS</span>
                <strong>{formatNumber(dataBlocks.length)}</strong>
                <small>{formatBytes(inspection.blockSize)} per block</small>
              </div>
              <div className="support-metric">
                <span className="eyebrow">MAPPED SEGMENTS</span>
                <strong>
                  {semanticReady
                    ? formatNumber(inspection.segments.length)
                    : "—"}
                </strong>
                <small>
                  {semanticReady
                    ? `${tables.length} tables`
                    : "Native decoding unavailable"}
                </small>
              </div>
              <div className="support-metric">
                <span className="eyebrow">DATA INTERNAL FREE SPACE</span>
                <strong
                  title={`${formatNumber(fragmentation.bytes)} bytes in completely mapped data blocks`}
                >
                  {fragmentation.measuredBlocks
                    ? formatBytes(fragmentation.bytes, true)
                    : "—"}
                </strong>
                <small>
                  {fragmentation.measuredBlocks
                    ? `${((fragmentation.ratio ?? 0) * 100).toFixed(2)}% unused · ${Math.round(fragmentation.coverage * 100)}% of data blocks measured`
                    : "Complete segment extents required"}
                </small>
              </div>
            </div>
            <div
              className="allocation-rail"
              aria-label="File footprint by storage role"
            >
              {roleSummary
                .filter((role) => role.bytes > 0)
                .map((role) => (
                  <span
                    key={role.role}
                    style={{
                      width: `${(role.bytes / inspection.fileSize) * 100}%`,
                      backgroundColor: roleColors[role.role],
                    }}
                    title={`${role.label}: ${formatBytes(role.bytes)}`}
                  />
                ))}
            </div>
            <div className="overview-key">
              {roleSummary
                .filter((role) => role.bytes > 0)
                .map((role) => (
                  <span key={role.role}>
                    <i style={{ backgroundColor: roleColors[role.role] }} />
                    {role.label}
                    <strong>{formatBytes(role.bytes)}</strong>
                  </span>
                ))}
            </div>
          </section>
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
          {inspection.warnings.length > 0 && (
            <details className="inspection-notes">
              <summary>
                <Info size={13} />
                {inspection.source === "demo"
                  ? "Example data · layout and statistics are illustrative"
                  : "Inspection notes and decoding coverage"}
                <ChevronDown size={12} />
              </summary>
              <div>
                {inspection.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
              </div>
            </details>
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
            className={`content-grid${selectedBlock || selectedSegment || selectedHeader ? " has-selection" : ""}`}
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
                          "--tile-progress": `${((cellSize - 4) / 20) * 100}%`,
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
                    <div className="header-region">
                      <div className="region-heading">
                        <span>FILE HEADERS</span>
                        <small>3 × 4 KiB · before block 0</small>
                      </div>
                      <div className="header-chips">
                        {headerBlocks.map((block) => (
                          <button
                            type="button"
                            key={block.id}
                            className={`header-chip ${selectedBlockId === block.id || (selectedHeaderSlot === 1 && block.id === -2) || (selectedHeaderSlot === 2 && block.id === -1) ? "selected" : ""}`}
                            onClick={() =>
                              block.id === -3
                                ? chooseBlock(block)
                                : selectCheckpoint(block.id === -2 ? 1 : 2)
                            }
                            onMouseEnter={() => setHoveredBlockId(block.id)}
                            onMouseLeave={() => setHoveredBlockId(null)}
                            aria-pressed={
                              selectedBlockId === block.id ||
                              (selectedHeaderSlot === 1 && block.id === -2) ||
                              (selectedHeaderSlot === 2 && block.id === -1)
                            }
                            aria-label={`${block.label}, ${formatBytes(block.size)}`}
                          >
                            <span className="header-chip-icon">
                              <FileText size={14} />
                            </span>
                            <span>
                              {block.id === -3
                                ? "Main header"
                                : `Checkpoint ${block.id === -2 ? 1 : 2}`}
                            </span>
                            <small>4 KiB</small>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="region-heading block-region-heading">
                      <span>BLOCK MAP</span>
                      <small>
                        {query
                          ? `${matchingBlocks.filter((block) => block.role !== "header").length} matches`
                          : `${formatBytes(inspection.blockSize)} / cell`}
                      </small>
                    </div>
                    <BlockHeatmap
                      blocks={visibleDataBlocks}
                      segmentsByBlock={segmentsByBlock}
                      colorMode={colorMode}
                      selectedBlockId={selectedBlockId}
                      hoveredBlockId={effectiveHoverBlock}
                      matchingBlockIds={query ? matchingBlockIds : null}
                      onSelect={chooseBlock}
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
                    <Legend
                      mode={colorMode}
                      semanticReady={semanticReady}
                      indexes={inspection.indexes}
                      segments={inspection.segments}
                    />
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
                    <LogicalColorLegend
                      mode={logicalColorMode}
                      metrics={logicalMetrics}
                      column={valueColumn}
                    />
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
                          segments={filteredSegments}
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
            {(selectedBlock || selectedSegment || selectedHeader) && (
              <aside className="details-panel" aria-label="Selection details">
                <div className="details-header">
                  <div>
                    <h2>
                      {selectedHeader
                        ? `Checkpoint ${selectedHeader.slot}`
                        : selectedSegment
                          ? selectedSegment.column
                          : selectedBlock
                            ? `Block ${String(selectedBlock.id).padStart(4, "0")}`
                            : "Inspector"}
                    </h2>
                  </div>
                  <button
                    type="button"
                    className="details-close"
                    aria-label="Clear selection"
                    disabled={
                      !selectedBlock && !selectedSegment && !selectedHeader
                    }
                    onClick={clearSelection}
                  >
                    <X size={15} />
                  </button>
                </div>
                {selectedHeader ? (
                  <CheckpointDetails
                    checkpoint={selectedHeader}
                    source={inspection.source}
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
                ) : null}
              </aside>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

const Legend = memo(function Legend({
  mode,
  semanticReady,
  indexes = [],
  segments = [],
}: {
  mode: ColorMode;
  semanticReady: boolean;
  indexes?: IndexInspection[];
  segments?: Segment[];
}) {
  if (mode === "fragmentation")
    return (
      <div className="legend">
        <span className="legend-title">
          UNUSED WITHIN MEASURED DATA / INDEX BLOCKS
        </span>
        <span className="gradient-legend" />
        <span>0%</span>
        <span>100%</span>
        <span className="legend-unknown">
          <i />
          Unmeasured allocations
        </span>
      </div>
    );
  if (mode === "utilization")
    return (
      <div className="legend">
        <span className="legend-title">SPACE USED</span>
        <span className="gradient-legend" />
        <span>0%</span>
        <span>100%</span>
        <span className="legend-item">
          <i style={{ backgroundColor: roleColors.free }} />
          Free space
        </span>
        <span className="legend-unknown">
          <i />
          Unknown
        </span>
      </div>
    );
  if (mode === "role")
    return (
      <div className="legend">
        <span className="legend-title">STORAGE ROLE</span>
        {Object.entries(roleColors).map(([role, color]) => (
          <span className="legend-item" key={role}>
            <i style={{ backgroundColor: color }} />
            {role}
          </span>
        ))}
      </div>
    );
  if (!semanticReady)
    return (
      <div className="legend">
        <span className="legend-title">{mode.toUpperCase()}</span>
        <span className="legend-empty">
          Available after checkpoint metadata is decoded
        </span>
      </div>
    );
  const categories =
    mode === "table"
      ? [
          ...new Set([
            ...segments.map((segment) => segment.table),
            ...indexes.map((index) => index.table),
          ]),
        ]
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ name, color: stableColor(name, tablePalette) }))
      : mode === "column"
        ? [
            ...new Set([
              ...segments.map(
                (segment) => `${segment.table}.${segment.column}`,
              ),
              ...indexes.map((index) => `${index.table} / ${index.name}`),
            ]),
          ]
            .sort((a, b) => a.localeCompare(b))
            .map((name) => ({ name, color: stableColor(name, tablePalette) }))
        : [...new Set(segments.map((segment) => segment.compression))]
            .sort((a, b) => a.localeCompare(b))
            .map((name) => ({
              name,
              color: stableColor(name, compressionPalette),
            }));
  const title =
    mode === "table" ? "TABLES" : mode === "column" ? "COLUMNS" : "COMPRESSION";
  return (
    <div className="legend">
      <span className="legend-title">{title}</span>
      {categories.map(({ name, color }) => (
        <span className="legend-item" key={name}>
          <i style={{ backgroundColor: color }} />
          {name}
        </span>
      ))}
      <span className="legend-item unmapped">
        <i style={{ backgroundColor: roleColors.unknown }} />
        Unknown
      </span>
      <span className="legend-item">
        <i style={{ backgroundColor: roleColors.free }} />
        Free space
      </span>
    </div>
  );
});

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
  return (
    <div className="logical-groups">
      {tables.map((table) => (
        <section className="table-group" key={table.name}>
          <div className="table-group-heading">
            <div className="table-group-name">
              <span className="table-icon">
                <Table2 size={15} />
              </span>
              <div>
                <strong>{table.name}</strong>
                <span>
                  {table.columns.length} columns · {table.rows.length} row
                  groups
                </span>
              </div>
            </div>
            <Badge variant="neutral">{table.segmentCount} segments</Badge>
          </div>
          <div className="logical-table-wrap">
            <div
              className="logical-table"
              style={
                {
                  "--column-count": table.columns.length,
                } as React.CSSProperties
              }
            >
              <div className="logical-cell logical-axis">ROW GROUP</div>
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
                    selectedBlockId != null && row.blockIds.has(selectedBlockId)
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
        </section>
      ))}
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
            ? `${formatNumber(summary.liveRows)} live / ${formatNumber(summary.physicalRows)} physical`
            : coverage
              ? `${formatNumber(coverage.count)} rows`
              : "Unknown rows"}
        </small>
        {summary && <small>{formatNumber(summary.deletedRows)} deleted</small>}
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
                    } as React.CSSProperties
                  }
                  onClick={() => onPick(segment)}
                  aria-pressed={selected}
                  aria-label={`${segment.table}, ${segment.column}, row group ${segment.rowGroup}, ${segment.compression}, ${formatBytes(segment.byteSize)}, ${segment.blockId >= 0 ? `block ${segment.blockId}` : "constant, no data block"}, ${appearance.description}`}
                  title={`${segment.table}.${segment.column}\nRow group ${segment.rowGroup} · ${segment.compression}\n${formatBytes(segment.byteSize)} · ${segment.blockId >= 0 ? `Block ${segment.blockId}` : "Constant · no data block"}\n${appearance.description}`}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
});

function CheckpointDetails({
  checkpoint,
  source,
  onShowFreeList,
  onInspectBytes,
}: {
  checkpoint: CheckpointHeader;
  source: FileInspection["source"];
  onShowFreeList?: () => void;
  onInspectBytes: () => void;
}) {
  return (
    <div className="detail-content">
      <div className="selected-kind-row">
        <span
          className={`role-dot ${checkpoint.valid ? "valid-dot" : "invalid-dot"}`}
        />
        <span>Checkpoint snapshot</span>
        <Badge variant={checkpoint.valid ? "default" : "warning"}>
          {checkpoint.valid ? "Valid" : "Invalid"}
        </Badge>
      </div>
      <div className="detail-card">
        <span className="detail-card-kicker">HEADER FIELDS</span>
        <DetailPair label="Slot" value={`Checkpoint ${checkpoint.slot}`} />
        <DetailPair
          label="Validity"
          value={checkpoint.valid ? "Valid" : "Invalid"}
        />
        <DetailPair
          label="Iteration"
          value={checkpoint.iteration || "Unknown"}
          mono
        />
        <DetailPair
          label="Metadata block"
          value={checkpoint.metaBlock || "Unknown"}
          mono
        />
        <DetailPair
          label="Free list"
          value={checkpoint.freeList || "Unknown"}
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
        <Badge variant={block.role === "free" ? "neutral" : "default"}>
          {block.role}
        </Badge>
      </div>
      <div className="detail-card">
        <span className="detail-card-kicker">BLOCK PROPERTIES</span>
        {onShowFreeList && (
          <Button variant="secondary" size="sm" onClick={onShowFreeList}>
            {block.role === "free"
              ? "Show free list entry"
              : "Inspect free list"}
            <ArrowRight size={12} />
          </Button>
        )}
        <DetailPair label="Block ID" value={block.id} mono />
        <DetailPair
          label="Byte offset"
          value={formatOffset(block.offset)}
          mono
        />
        <DetailPair label="Block size" value={formatBytes(block.size)} />
        <DetailPair label="Bytes used" value={formatBytes(block.usedBytes)} />
        <DetailPair
          label="Internal free space"
          value={formatBytes(internalFreeBytes(block), true)}
        />
        {block.role === "index" && (
          <>
            <DetailPair
              label="Free stored-slot holes"
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
              label="Unallocated gaps / tails"
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
        <DetailPair
          label="Space used"
          value={usedPercent == null ? "Unknown" : `${usedPercent}%`}
        />
        <DetailPair
          label="Checksum"
          value={block.checksum ?? "Not available"}
          mono
        />
        <DetailPair label="Description" value={block.label || "Unknown"} />
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
            label="Shared references"
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
                    title={`${formatOffset(range.offset)} · ${formatNumber(range.size)} bytes${segment ? " · Jump to segment" : ""}`}
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
            <span>Index ownership</span>
            <span>{block.indexOwners!.length} indexes</span>
          </div>
          {block.indexOwners!.map((index) => (
            <DetailPair key={index.id} label={index.table} value={index.name} />
          ))}
          <p className="section-caption">
            Index nodes are not column codec data. Internal free bytes can
            include both free stored-slot holes and unallocated block tails;
            neither is a whole reusable free block.
          </p>
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
          <p className="section-caption">
            Block references decoded by inspection.
          </p>
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
        {inspection.source === "demo" ? (
          <div className="preview-unavailable">
            <Sparkles size={14} />
            Illustrative sample has no raw file bytes.
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}

function HexPreview({ offset, bytes }: { offset: number; bytes: Uint8Array }) {
  const rows = Array.from(
    { length: Math.ceil(bytes.length / 16) },
    (_, index) => Array.from(bytes.slice(index * 16, index * 16 + 16)),
  );
  return (
    <div
      className="hex-view"
      aria-label={`${bytes.length} byte hexadecimal preview`}
    >
      {rows.map((row, rowIndex) => (
        <div className="hex-row" key={rowIndex}>
          <span className="hex-offset">
            {formatOffset(offset + rowIndex * 16).slice(2)}
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
        <span className="detail-card-kicker">SEMANTIC DETAILS</span>
        <DetailPair label="Table" value={segment.table} />
        <DetailPair label="Column" value={segment.column} />
        <DetailPair label="Type" value={segment.columnType || "Unknown"} />
        <DetailPair
          label="Compression"
          value={segment.compression || "Unknown"}
        />
        <DetailPair label="Row group" value={formatNumber(segment.rowGroup)} />
        <DetailPair
          label="Rows"
          value={`${formatNumber(segment.rowStart)}–${formatNumber(segment.rowStart + segment.rowCount - 1)}`}
        />
        <DetailPair label="Row count" value={formatNumber(segment.rowCount)} />
        <DetailPair label="Byte size" value={formatBytes(segment.byteSize)} />
        {colorMetric && (
          <DetailPair
            label={colorMetric.label}
            value={colorMetric.description}
          />
        )}
        <DetailPair
          label="Block-relative offset"
          value={
            segment.blockId >= 0
              ? `+${formatOffset(segment.offset)}`
              : "No physical payload"
          }
          mono
        />
        <DetailPair
          label="Minimum"
          value={segment.min ?? "Not recorded"}
          mono
        />
        <DetailPair
          label="Maximum"
          value={segment.max ?? "Not recorded"}
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
        <DetailPair
          label="Statistics"
          value={segment.stats ?? "Not recorded"}
        />
      </div>
      {rowSummary && (
        <div className="detail-card">
          <span className="detail-card-kicker">CHECKPOINT ROW GROUP</span>
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
          <DetailPair
            label="Row start"
            value={formatNumber(rowSummary.rowStart)}
          />
          <DetailPair
            label="Delete vectors"
            value={formatNumber(rowSummary.deleteVectors.length)}
          />
          <DetailPair
            label="Delete encodings"
            value={
              [
                ...new Set(
                  rowSummary.deleteVectors.map((vector) => vector.encoding),
                ),
              ].join(", ") || "None"
            }
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
          <p className="section-caption">
            Logical checkpoint visibility, not per-segment null counts or
            reclaimable physical bytes.
          </p>
        </div>
      )}
      {block && (
        <div className="detail-section">
          <div className="detail-section-heading">
            <span>Physical placement</span>
            <span>Block {block.id}</span>
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
      <div className="inspector-note">
        <FileCode2 size={14} />
        <span>
          {inspection.source === "demo"
            ? "Example data."
            : inspection.native
              ? "String zonemaps may contain truncated bounds. Mixed null counts are not always recorded."
              : "Semantic values come from the imported map. Missing fields remain unknown or unrecorded."}
        </span>
      </div>
    </div>
  );
}
