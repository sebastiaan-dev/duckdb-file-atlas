import { fragmentationSummary, internalFreeBytes } from "@/lib/fragmentation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  FileCode2,
  FileText,
  HardDrive,
  Layers3,
  LoaderCircle,
  Search,
  Sparkles,
  Table2,
  Upload,
  X,
  Moon,
  Sun,
  Plus,
  Grid2X2,
  ChevronsUpDown,
  Info,
  MousePointer2,
  LockKeyhole,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useContinuousLayout } from "@/hooks/use-continuous-layout";
import { BlockHeatmap } from "@/components/block-heatmap";
import {
  roleColors,
  tablePalette,
  compressionPalette,
  stableColor,
  spaceRamp,
} from "@/lib/palette";
import { createDemo } from "@/lib/demo";
import { readBytes } from "@/lib/reader";
import { inspectDatabase } from "@/lib/open-database";
import { applyManifest } from "@/lib/semantic";
import {
  aggregateByteSize,
  buildRowGroupUnits,
  LARGE_BLOCK_COUNT,
  LARGE_SEGMENT_COUNT,
  rowCoverage,
  type RowGroupUnit,
} from "@/lib/layout";
import type {
  CheckpointHeader,
  ColorMode,
  FileBlock,
  FileInspection,
  Segment,
  StorageRole,
} from "@/lib/types";

type ViewMode = "physical" | "logical";
type Density = 0 | 1 | 2;
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

function formatNumber(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "Unknown"
    : new Intl.NumberFormat().format(value);
}

function shortName(value: string, max = 20) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function segmentFootprintColor(byteSize: number | null, maximum: number) {
  if (byteSize == null || maximum <= 0) return "var(--chart-empty)";
  const ratio = Math.log1p(byteSize) / Math.log1p(maximum);
  return spaceRamp[ratio > 0.75 ? 3 : ratio > 0.5 ? 2 : ratio > 0.25 ? 1 : 0];
}

function formatOffset(value: number) {
  return `0x${Math.max(0, value).toString(16).padStart(8, "0")}`;
}

function HeaderIcon({ mode }: { mode: ViewMode }) {
  return mode === "physical" ? <HardDrive size={15} /> : <Layers3 size={15} />;
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
  const [density, setDensity] = useState<Density>(0);
  const [query, setQuery] = useState("");
  const [selectedBlockId, setSelectedBlockId] = useState<number | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const [selectedHeaderSlot, setSelectedHeaderSlot] = useState<1 | 2 | null>(
    null,
  );
  const [hoveredBlockId, setHoveredBlockId] = useState<number | null>(null);
  const [hoveredSegmentId, setHoveredSegmentId] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<File | null>(null);
  const [byteView, setByteView] = useState<ByteView>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [loadingBytes, setLoadingBytes] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [manifestMessage, setManifestMessage] = useState("");
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const manifestInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const fileLoadRequestRef = useRef(0);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => inspectionAbortRef.current?.abort(), []);
  const manifestImportRequestRef = useRef(0);

  const semanticReady = inspection.capabilities.semantic;
  const selectedBlock = useMemo(
    () =>
      inspection.blocks.find((block) => block.id === selectedBlockId) ?? null,
    [inspection.blocks, selectedBlockId],
  );
  const selectedSegment = useMemo(
    () =>
      inspection.segments.find((segment) => segment.id === selectedSegmentId) ??
      null,
    [inspection.segments, selectedSegmentId],
  );
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
    () =>
      new Set(
        inspection.blocks.find((block) => block.id === effectiveHoverBlock)
          ?.links ?? [],
      ),
    [inspection.blocks, effectiveHoverBlock],
  );
  const matchingBlocks = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return inspection.blocks;
    const matchingSegmentBlocks = new Set(
      inspection.segments
        .filter((segment) =>
          `${segment.table} ${segment.column} ${segment.columnType} ${segment.compression} ${segment.id}`
            .toLocaleLowerCase()
            .includes(term),
        )
        .map((segment) => segment.blockId)
        .filter((id) => id >= 0),
    );
    return inspection.blocks.filter(
      (block) =>
        `${block.id} ${block.label} ${block.role}`
          .toLocaleLowerCase()
          .includes(term) || matchingSegmentBlocks.has(block.id),
    );
  }, [inspection.blocks, inspection.segments, query]);
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
    const term = query.trim().toLocaleLowerCase();
    if (!term) return inspection.segments;
    return inspection.segments.filter((segment) =>
      `${segment.table} ${segment.column} ${segment.columnType} ${segment.compression} ${segment.id} ${segment.rowGroup}`
        .toLocaleLowerCase()
        .includes(term),
    );
  }, [inspection.segments, query]);
  const dataBlocks = useMemo(
    () =>
      inspection.blocks
        .filter((block) => block.role !== "header")
        .slice()
        .sort((a, b) => a.offset - b.offset),
    [inspection.blocks],
  );
  const headerBlocks = inspection.blocks.filter(
    (block) => block.role === "header",
  );
  const logicalUnits = useMemo(
    () => buildRowGroupUnits(filteredSegments),
    [filteredSegments],
  );
  const firstMatchingBlockId = query.trim()
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
    logicalUnits.findIndex((group) =>
      group.segments.some((segment) => segment.id === selectedSegmentId),
    ),
  );
  const visibleDataBlocks = useMemo(
    () => dataBlocks.slice(0, physicalLayout.visibleCount),
    [dataBlocks, physicalLayout.visibleCount],
  );
  const visibleLogicalUnits = useMemo(
    () => logicalUnits.slice(0, logicalLayout.visibleCount),
    [logicalUnits, logicalLayout.visibleCount],
  );
  const maxLogicalSegmentBytes = inspection.segments.reduce(
    (maximum, segment) => Math.max(maximum, segment.byteSize ?? 0),
    0,
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
      setNotice("");
      try {
        const result = await inspectDatabase(file, controller.signal);
        if (requestId !== fileLoadRequestRef.current) return;
        setInspection(result);
        setActiveFile(file);
        setView("physical");
        setColorMode("role");
        setQuery("");

        clearSelection();
        setNotice(
          result.native
            ? `Read ${result.native.tables} tables and ${result.native.rowGroups} row groups directly from ${file.name}`
            : `Loaded ${file.name} locally`,
        );
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

        setColorMode("table");
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
    setByteView(null);
  }, []);

  const chooseBlock = useCallback((block: FileBlock) => {
    setSelectedBlockId(block.id);
    setView("physical");
    setSelectedSegmentId(null);
    setSelectedHeaderSlot(null);
    setByteView(null);
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
    if (selectedBlock) {
      const selectedOffset =
        selectedSegment?.blockId === selectedBlock.id
          ? selectedBlock.offset + selectedSegment.offset
          : selectedBlock.offset;
      void loadBlockBytes(selectedBlock, selectedOffset);
    }
  }, [selectedBlock, selectedSegment, loadBlockBytes]);

  useEffect(() => {
    if (view !== "physical" || selectedBlockId == null) return;
    const tile = document.querySelector<HTMLButtonElement>(
      `[data-block-id="${selectedBlockId}"]`,
    );
    tile?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [view, selectedBlockId]);

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
    setByteView(null);
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
  const roleSummary = (Object.keys(roleColors) as StorageRole[]).map(
    (role) => ({
      role,
      label: roleLabels[role],
      bytes: inspection.blocks
        .filter((block) => block.role === role)
        .reduce((sum, block) => sum + block.size, 0),
    }),
  );
  const fragmentation = fragmentationSummary(inspection);
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
        <div className="topbar-center">
          <span className="privacy-mark">
            <span />
            Local file explorer
          </span>
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
          <span className="eyebrow">WORKSPACE</span>
          <button
            className="file-card"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Open another database"
          >
            <span className="file-card-icon">
              <Database size={18} strokeWidth={1.5} />
            </span>
            <span className="file-card-info">
              <strong title={inspection.name}>
                {shortName(inspection.name, 23)}
              </strong>
              <small>
                {formatBytes(inspection.fileSize)} <i />{" "}
                {inspection.source === "demo" ? "Example file" : "Local file"}
              </small>
            </span>
            <ChevronsUpDown size={14} />
          </button>
          <nav className="side-nav" aria-label="Explorer views">
            <button
              type="button"
              className={view === "physical" ? "active" : ""}
              onClick={() => setView("physical")}
            >
              <Grid2X2 size={16} />
              Physical layout<span>{formatNumber(dataBlocks.length)}</span>
            </button>
            <button
              type="button"
              className={view === "logical" ? "active" : ""}
              onClick={() => {
                setView("logical");
                if (colorMode === "fragmentation") setColorMode("utilization");
                if (colorMode === "role") setColorMode("table");
              }}
            >
              <Layers3 size={16} />
              Logical data{semanticReady && <span>{tables.length}</span>}
            </button>
          </nav>
          <div className="side-section side-section-divider">
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
          <div className="sidebar-footer">
            <span className="local-dot" />
            <div>
              <strong>Read locally. Explore freely.</strong>
              <small>Your database stays on your device.</small>
            </div>
          </div>
        </aside>
        <main className="main-area">
          <div className="workspace-heading">
            <div>
              <div className="breadcrumb">
                <span>Workspace</span>
                <ChevronRight size={12} />
                <span>{inspection.name}</span>
              </div>
              <h1>Storage overview</h1>
              <p>A closer look at how your database takes shape.</p>
            </div>
            <div className="heading-actions">
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
              {inspection.native && (
                <Badge variant="purple">
                  <Check size={12} />
                  Decoded from file
                </Badge>
              )}
              <TooltipProvider delayDuration={250}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="help-link"
                      type="button"
                      onClick={() =>
                        setNotice(
                          "Checkpoint metadata is traversed locally to read tables, column segments, recorded byte sizes, and statistics. Gaps are measured only in completely mapped data blocks.",
                        )
                      }
                      aria-label="About the file map"
                    >
                      <CircleHelp size={17} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Explore checkpoint metadata, physical allocations, and
                    measured internal free space.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
          <section className="overview-card" aria-label="Database overview">
            <div className="overview-card-top">
              <span className="overview-file">
                <Database size={15} />
                <span>{inspection.name}</span>
              </span>
              <span
                className={`source-badge ${inspection.source === "demo" ? "sample" : ""}`}
              >
                {inspection.source === "demo" ? (
                  <Sparkles size={12} />
                ) : (
                  <Check size={12} />
                )}
                {inspection.source === "demo"
                  ? "Illustrative example"
                  : "Local database"}
              </span>
            </div>
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
                    ? `${tables.length} tables connected`
                    : "Native decoding unavailable"}
                </small>
              </div>
              <div className="support-metric">
                <span className="eyebrow">INTERNAL FREE SPACE</span>
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
          {(error || notice || manifestMessage) && (
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
              {!error && (manifestMessage || notice) && (
                <div className="message notice-message" role="status">
                  <CircleHelp size={15} />
                  <span>{manifestMessage || notice}</span>
                  <button
                    type="button"
                    aria-label="Dismiss message"
                    onClick={() => {
                      setManifestMessage("");
                      setNotice("");
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
                if (value === "logical" && colorMode === "fragmentation")
                  setColorMode("utilization");
                if (value === "logical" && colorMode === "role")
                  setColorMode("table");
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
                  placeholder="Find a block, table, column…"
                  aria-label="Search blocks, tables, or columns"
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
              <label className="color-select-label">
                <span>Color</span>
                <select
                  value={colorMode}
                  aria-label="Color blocks by"
                  onChange={(event) =>
                    setColorMode(event.target.value as ColorMode)
                  }
                >
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
                    <option value="fragmentation">Internal free space</option>
                  )}
                  <option value="utilization">
                    {view === "logical" ? "Segment footprint" : "Space used"}
                  </option>
                </select>
                <ChevronDown size={12} />
              </label>
            </div>
          </div>
          <div className="content-grid">
            <section className="map-column" aria-label="File map">
              <div className="map-card">
                <div className="map-card-header">
                  <div>
                    <div className="section-title-row">
                      <HeaderIcon mode={view} />
                      <h2>
                        {view === "physical"
                          ? "Disk blocks"
                          : "Row groups & columns"}
                      </h2>
                      <span className="count-label">
                        {formatNumber(
                          view === "physical"
                            ? dataBlocks.length
                            : filteredSegments.length,
                        )}
                      </span>
                    </div>
                    <p>
                      {view === "physical"
                        ? "Physical address order. Every cell is one allocation."
                        : "Follow each segment back to its physical block."}
                    </p>
                  </div>
                  {view === "physical" && (
                    <div className="zoom-control" aria-label="Map tile density">
                      <div className="zoom-buttons">
                        {([0, 1, 2] as Density[]).map((level) => (
                          <button
                            key={level}
                            type="button"
                            className={density === level ? "active" : ""}
                            onClick={() => setDensity(level)}
                            aria-label={
                              [
                                "Compact heatmap",
                                "Balanced heatmap",
                                "Larger heatmap cells",
                              ][level]
                            }
                            aria-pressed={density === level}
                          >
                            <span
                              className={`density-glyph ${["small", "medium", "large"][level]}`}
                            />
                          </button>
                        ))}
                      </div>
                    </div>
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
                      onHover={setHoveredBlockId}
                      density={density}
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
                      segments={inspection.segments}
                    />
                  </div>
                ) : semanticReady ? (
                  <div className="logical-body">
                    <div className="logical-intro">
                      <div>
                        <span className="logical-eyebrow">
                          {inspection.native
                            ? "CHECKPOINT METADATA"
                            : "SEMANTIC OVERLAY"}
                        </span>
                        <p>
                          Color and selection connect each logical segment to
                          its physical block.
                        </p>
                      </div>
                      <Badge variant="purple">
                        <Layers3 size={12} />
                        {inspection.segments.length} mapped segments
                      </Badge>
                    </div>
                    {filteredSegments.length === 0 ? (
                      <div className="empty-search">
                        <Search size={16} />
                        {query
                          ? `No segments match “${query}”.`
                          : inspection.native?.catalog?.length
                            ? `${inspection.native.catalog.map((table) => `${table.name} (${table.columns.length} columns, ${table.rows} rows)`).join(" · ")} · No stored segments.`
                            : "The database contains no tables or stored segments."}
                      </div>
                    ) : (
                      <>
                        <LogicalGroups
                          segments={filteredSegments}
                          groups={visibleLogicalUnits}
                          selectedId={selectedSegmentId}
                          hoveredId={hoveredSegmentId}
                          selectedBlockId={selectedBlockId}
                          mode={colorMode}
                          maxSegmentBytes={maxLogicalSegmentBytes}
                          onPick={chooseSegment}
                          onEnter={(segment) => setHoveredSegmentId(segment.id)}
                          onLeave={() => setHoveredSegmentId(null)}
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
                    <Legend
                      mode={colorMode === "role" ? "table" : colorMode}
                      semanticReady={semanticReady}
                      segments={inspection.segments}
                      logical
                      maxSegmentBytes={maxLogicalSegmentBytes}
                    />
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
                      <span>Read locally. Nothing is uploaded.</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="map-caption">
                <span>
                  <MousePointer2 size={12} />
                  Hover to inspect · click to select
                </span>
                <span>
                  {inspection.source === "demo"
                    ? "ILLUSTRATIVE DATASET"
                    : "LOCAL FILE"}
                </span>
              </div>
            </section>
            <aside className="details-panel" aria-label="Selection details">
              <div className="details-header">
                <div>
                  <span className="eyebrow">INSPECTOR</span>
                  <h2>
                    {selectedHeader
                      ? `Checkpoint ${selectedHeader.slot}`
                      : selectedSegment
                        ? selectedSegment.column
                        : selectedBlock
                          ? `Block ${String(selectedBlock.id).padStart(4, "0")}`
                          : "Look inside a block"}
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
                  segment={selectedSegment}
                  inspection={inspection}
                  block={selectedBlock}
                  onBlockClick={chooseBlock}
                />
              ) : selectedBlock ? (
                <BlockDetails
                  block={selectedBlock}
                  inspection={inspection}
                  segments={segmentsByBlock.get(selectedBlock.id) ?? []}
                  byteView={
                    byteView?.blockId === selectedBlock.id ? byteView : null
                  }
                  loadingBytes={loadingBytes}
                  onSegmentClick={chooseSegment}
                  onBlockClick={(id) => {
                    const block = inspection.blocks.find(
                      (item) => item.id === id,
                    );
                    if (block) chooseBlock(block);
                  }}
                  onBytePage={(offset) =>
                    void loadBlockBytes(selectedBlock, offset)
                  }
                />
              ) : (
                <InspectorWelcome
                  semanticReady={semanticReady}
                  source={inspection.source}
                />
              )}
              <div className="inspector-footnote">
                <LockKeyhole size={12} />
                <span>
                  {inspection.source === "demo"
                    ? "Example data. Open a file to inspect real bytes."
                    : "Read-only inspection · your original file is unchanged."}
                </span>
              </div>
            </aside>
          </div>
        </main>
      </div>
      <footer className="app-statusbar">
        <span>
          <span className="local-dot" />
          LOCAL FILE INSPECTION
        </span>
        <span>
          DUCKDB STORAGE V{inspection.storageVersion}
          <i />
          {formatNumber(dataBlocks.length)} BLOCKS
        </span>
        <span className="statusbar-private">
          <LockKeyhole size={11} />
          PRIVATE BY DESIGN
        </span>
      </footer>
    </div>
  );
}

function Legend({
  mode,
  semanticReady,
  segments = [],
  logical = false,
  maxSegmentBytes = 0,
}: {
  mode: ColorMode;
  semanticReady: boolean;
  segments?: Segment[];
  logical?: boolean;
  maxSegmentBytes?: number;
}) {
  if (mode === "fragmentation")
    return (
      <div className="legend">
        <span className="legend-title">UNUSED WITHIN DATA BLOCKS</span>
        <span className="gradient-legend" />
        <span>0%</span>
        <span>100%</span>
        <span className="legend-unknown">
          <i />
          Unmeasured allocations
        </span>
      </div>
    );
  if (mode === "utilization" && logical)
    return (
      <div className="legend">
        <span className="legend-title">SEGMENT FOOTPRINT</span>
        <span className="gradient-legend" />
        <span>{formatBytes(0)}</span>
        <span>{formatBytes(maxSegmentBytes)}</span>
        <span className="legend-unknown">
          <i />
          Unknown
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
      ? [...new Set(segments.map((segment) => segment.table))]
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ name, color: stableColor(name, tablePalette) }))
      : mode === "column"
        ? [
            ...new Set(
              segments.map((segment) => `${segment.table}.${segment.column}`),
            ),
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
      {!logical && (
        <span className="legend-item">
          <i style={{ backgroundColor: roleColors.free }} />
          Free space
        </span>
      )}
    </div>
  );
}

function LogicalGroups({
  segments,
  groups,
  selectedId,
  hoveredId,
  selectedBlockId,
  mode,
  maxSegmentBytes,
  onPick,
  onEnter,
  onLeave,
}: {
  segments: Segment[];
  groups: RowGroupUnit[];
  selectedId: string | null;
  hoveredId: string | null;
  selectedBlockId: number | null;
  mode: ColorMode;
  maxSegmentBytes: number;
  onPick: (segment: Segment) => void;
  onEnter: (segment: Segment) => void;
  onLeave: () => void;
}) {
  const tables = [...new Set(groups.map((group) => group.table))].sort((a, b) =>
    a.localeCompare(b),
  );
  return (
    <div className="logical-groups">
      {tables.map((table) => {
        const tableSegments = segments.filter(
          (segment) => segment.table === table,
        );
        const tableGroups = groups.filter((group) => group.table === table);
        const columns = [
          ...new Set(tableSegments.map((segment) => segment.column)),
        ];
        return (
          <section className="table-group" key={table}>
            <div className="table-group-heading">
              <div className="table-group-name">
                <span className="table-icon">
                  <Table2 size={15} />
                </span>
                <div>
                  <strong>{table}</strong>
                  <span>
                    {columns.length} columns · {tableGroups.length} row groups
                  </span>
                </div>
              </div>
              <Badge variant="neutral">
                {tableGroups.reduce(
                  (count, group) => count + group.segments.length,
                  0,
                )}{" "}
                segments
              </Badge>
            </div>
            <div className="logical-table-wrap">
              <div
                className="logical-table"
                style={
                  { "--column-count": columns.length } as React.CSSProperties
                }
              >
                <div className="logical-cell logical-axis">ROW GROUP</div>
                {columns.map((column) => (
                  <div
                    className="logical-cell logical-column-head"
                    key={column}
                  >
                    <strong>{column}</strong>
                    <span>
                      {shortName(
                        tableSegments.find(
                          (segment) => segment.column === column,
                        )?.columnType ?? "Unknown",
                        18,
                      )}
                    </span>
                  </div>
                ))}
                {tableGroups.map((group) => (
                  <LogicalRow
                    key={group.rowGroup}
                    group={group.rowGroup}
                    columns={columns}
                    segments={group.segments}
                    selectedId={selectedId}
                    hoveredId={hoveredId}
                    selectedBlockId={selectedBlockId}
                    mode={mode}
                    maxSegmentBytes={maxSegmentBytes}
                    onPick={onPick}
                    onEnter={onEnter}
                    onLeave={onLeave}
                  />
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LogicalRow({
  group,
  columns,
  segments,
  selectedId,
  hoveredId,
  selectedBlockId,
  mode,
  maxSegmentBytes,
  onPick,
  onEnter,
  onLeave,
}: {
  group: number;
  columns: string[];
  segments: Segment[];
  selectedId: string | null;
  hoveredId: string | null;
  selectedBlockId: number | null;
  mode: ColorMode;
  maxSegmentBytes: number;
  onPick: (segment: Segment) => void;
  onEnter: (segment: Segment) => void;
  onLeave: () => void;
}) {
  const coverage = rowCoverage(segments);
  return (
    <>
      <div className="logical-cell row-label">
        <span>RG {group}</span>
        <small>
          {coverage ? `${formatNumber(coverage.count)} rows` : "Unknown rows"}
        </small>
      </div>
      {columns.map((column) => {
        const cellSegments = segments.filter((item) => item.column === column);
        if (cellSegments.length === 0)
          return (
            <div
              key={`${group}-${column}`}
              className="logical-cell logical-gap"
            >
              <span>—</span>
            </div>
          );
        const totalBytes = aggregateByteSize(cellSegments);
        return (
          <div
            key={`${group}-${column}`}
            className="logical-cell segment-cell-stack"
          >
            {cellSegments.length > 1 && (
              <span className="segment-cell-total">
                Combined footprint · {formatBytes(totalBytes)}
              </span>
            )}
            {cellSegments.map((segment) => {
              const selected =
                segment.id === selectedId ||
                segment.blockId === selectedBlockId;
              const hovered = segment.id === hoveredId;
              const color =
                mode === "compression"
                  ? stableColor(segment.compression, compressionPalette)
                  : mode === "utilization"
                    ? segmentFootprintColor(segment.byteSize, maxSegmentBytes)
                    : stableColor(
                        mode === "column"
                          ? `${segment.table}.${segment.column}`
                          : segment.table,
                        tablePalette,
                      );
              return (
                <button
                  type="button"
                  className={`segment-choice ${selected ? "selected" : ""} ${hovered ? "hovered" : ""}`}
                  key={segment.id}
                  style={{ "--block-color": color } as React.CSSProperties}
                  onClick={() => onPick(segment)}
                  onMouseEnter={() => onEnter(segment)}
                  onMouseLeave={onLeave}
                  onFocus={() => onEnter(segment)}
                  onBlur={onLeave}
                  aria-pressed={selected}
                  aria-label={`${segment.table}, ${segment.column}, row group ${segment.rowGroup}, ${formatBytes(segment.byteSize)}, block ${segment.blockId}`}
                  title={`${segment.column} · ${segment.compression} · block ${segment.blockId}`}
                >
                  <span className="segment-cell-name">
                    {shortName(segment.column, 18)}
                  </span>
                  <span className="segment-cell-meta">
                    {formatBytes(segment.byteSize)} <i />{" "}
                    {segment.blockId >= 0
                      ? `Block ${segment.blockId}`
                      : "Constant · no data block"}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function CheckpointDetails({
  checkpoint,
  source,
  onInspectBytes,
}: {
  checkpoint: CheckpointHeader;
  source: FileInspection["source"];
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
      <div className="inspector-note">
        <AlertCircle size={14} />
        <span>
          {source === "demo"
            ? "These checkpoint values are illustrative sample data, not decoded from a database file."
            : "These are checkpoint header values decoded by the local file inspection."}
        </span>
      </div>
    </div>
  );
}

function BlockDetails({
  block,
  inspection,
  segments,
  byteView,
  loadingBytes,
  onSegmentClick,
  onBlockClick,
  onBytePage,
}: {
  block: FileBlock;
  inspection: FileInspection;
  segments: Segment[];
  byteView: ByteView;
  loadingBytes: boolean;
  onSegmentClick: (segment: Segment) => void;
  onBlockClick: (id: number) => void;
  onBytePage: (offset: number) => void;
}) {
  const usedPercent =
    block.usedBytes == null || block.size <= 0
      ? null
      : Math.round((block.usedBytes / block.size) * 100);
  const linkedBlocks = block.links
    .map((id) => inspection.blocks.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is FileBlock => Boolean(candidate));
  const orderedRanges = [...block.ranges].sort(
    (a, b) => a.offset - b.offset || a.size - b.size,
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
              aria-label="Proportional byte ranges within block"
            >
              {orderedRanges.map((range) => {
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
                  ? inspection.segments.find(
                      (candidate) => candidate.id === range.segmentId,
                    )
                  : undefined;
                return (
                  <button
                    type="button"
                    key={range.id}
                    className={`byte-range range-${range.kind}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${range.label}: ${formatBytes(range.size)} at ${formatOffset(range.offset)}${segment ? " · Select owning segment" : ""}`}
                    aria-label={`${range.label}, ${formatBytes(range.size)}, offset ${formatOffset(range.offset)}${segment ? ", jump to segment details" : ""}`}
                    disabled={!segment}
                    onClick={() => {
                      if (segment) onSegmentClick(segment);
                    }}
                  />
                );
              })}
            </div>
            <div className="range-list">
              {orderedRanges.map((range) => {
                const segment = range.segmentId
                  ? inspection.segments.find(
                      (candidate) => candidate.id === range.segmentId,
                    )
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
                    <i className={`range-swatch range-${range.kind}`} />
                    <span>{range.label}</span>
                    <small>{formatOffset(range.offset)}</small>
                    <strong>{formatBytes(range.size)}</strong>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="preview-unavailable">
            <AlertCircle size={14} />
            This inspection has no byte-range metadata for the block.
          </div>
        )}
      </div>

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
  segment,
  inspection,
  block,
  onBlockClick,
}: {
  segment: Segment;
  inspection: FileInspection;
  block: FileBlock | null;
  onBlockClick: (block: FileBlock) => void;
}) {
  const linked =
    block?.links
      .map((id) => inspection.blocks.find((candidate) => candidate.id === id))
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
          value={formatNumber(segment.nullCount)}
        />
        <DetailPair
          label="Statistics"
          value={segment.stats ?? "Not recorded"}
        />
      </div>
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
            ? "These semantic values are illustrative sample data. Import a map to connect a real database file."
            : inspection.native
              ? "Read directly from the checkpoint. String zonemaps may be bounded prefixes; null counts are shown only when recorded or provable."
              : "Semantic values come from the imported map. Missing fields remain unknown or unrecorded."}
        </span>
      </div>
    </div>
  );
}

function InspectorWelcome({
  semanticReady,
  source,
}: {
  semanticReady: boolean;
  source: "demo" | "file";
}) {
  return (
    <div className="inspector-welcome">
      <div className="inspect-orbit">
        <span />
        <Blocks size={23} />
        <i />
        <i />
      </div>
      <h3>Inspect a block or segment</h3>
      <p>
        Select any tile to see its offset, role, byte ranges, and known
        references.
      </p>
      <div className="welcome-divider" />
      <div className="shortcut-tip">
        <span className="shortcut-icon">
          <Search size={14} />
        </span>
        <span>
          <strong>Search the map</strong>
          <small>Find block IDs, tables, and columns.</small>
        </span>
      </div>
      {!semanticReady && (
        <div className="shortcut-tip">
          <span className="shortcut-icon purple">
            <Layers3 size={14} />
          </span>
          <span>
            <strong>Connect logical data</strong>
            <small>
              A sidecar can provide ownership when native decoding is
              unavailable.
            </small>
          </span>
        </div>
      )}
      {source === "demo" && (
        <div className="inspector-demo-tip">
          <Sparkles size={13} />
          This sample is illustrative.
        </div>
      )}
    </div>
  );
}
