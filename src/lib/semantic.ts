import type {
  ByteRange,
  FileBlock,
  FileInspection,
  Segment,
  SemanticManifest,
} from "./types";

const STORAGE_VERSION = 69;
const MAX_SEGMENTS = 1_000_000;
const MAX_TEXT_LENGTH = 16_384;
const MAX_STATS_LENGTH = 65_536;

type RecordValue = Record<string, unknown>;

function invalid(path: string, reason: string): never {
  throw new Error(`Invalid semantic manifest at ${path}: ${reason}`);
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(
  value: RecordValue,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      invalid(path, `missing required field "${key}"`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "unknown field");
  }
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    invalid(
      path,
      `expected a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  maximum = MAX_TEXT_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim().length === 0
  ) {
    invalid(
      path,
      `expected a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

function optionalString(
  value: RecordValue,
  key: string,
  path: string,
  maximum = MAX_TEXT_LENGTH,
): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  if (
    typeof value[key] !== "string" ||
    (value[key] as string).length > maximum
  ) {
    invalid(
      `${path}.${key}`,
      `expected a string of at most ${maximum} characters`,
    );
  }
  return value[key] as string;
}

function fingerprint(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value)) {
    invalid(path, "expected a 64-character SHA-256 hex digest");
  }
  return value.toLowerCase();
}

function parseSegment(value: unknown, index: number): Segment {
  const path = `segments[${index}]`;
  if (!isRecord(value)) invalid(path, "expected an object");

  const required = [
    "id",
    "table",
    "column",
    "columnType",
    "rowGroup",
    "blockId",
    "offset",
    "byteSize",
    "rowStart",
    "rowCount",
    "compression",
  ] as const;
  const optional = ["min", "max", "nullCount", "stats"] as const;
  checkKeys(value, path, required, optional);

  const id = boundedString(value.id, `${path}.id`, 512);
  const table = boundedString(value.table, `${path}.table`);
  const column = boundedString(value.column, `${path}.column`);
  const columnType = boundedString(value.columnType, `${path}.columnType`);
  const rowGroup = safeInteger(value.rowGroup, `${path}.rowGroup`);
  const blockId = safeInteger(value.blockId, `${path}.blockId`);
  const offset = safeInteger(value.offset, `${path}.offset`);
  const byteSize =
    value.byteSize === null
      ? null
      : safeInteger(value.byteSize, `${path}.byteSize`);
  const rowStart = safeInteger(value.rowStart, `${path}.rowStart`);
  const rowCount = safeInteger(value.rowCount, `${path}.rowCount`);
  if (!Number.isSafeInteger(rowStart + rowCount))
    invalid(path, "rowStart + rowCount exceeds the safe integer range");
  const compression = boundedString(value.compression, `${path}.compression`);
  const min = optionalString(value, "min", path);
  const max = optionalString(value, "max", path);
  const stats = optionalString(value, "stats", path, MAX_STATS_LENGTH);
  let nullCount: number | undefined;
  if (Object.hasOwn(value, "nullCount")) {
    nullCount = safeInteger(value.nullCount, `${path}.nullCount`);
    if (nullCount > rowCount)
      invalid(`${path}.nullCount`, "cannot exceed rowCount");
  }

  return {
    id,
    table,
    column,
    columnType,
    rowGroup,
    blockId,
    offset,
    byteSize,
    rowStart,
    rowCount,
    compression,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(nullCount === undefined ? {} : { nullCount }),
    ...(stats === undefined ? {} : { stats }),
  };
}

function overlaps(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function subtractCoveredUnknownRanges(
  ranges: ByteRange[],
  covered: Array<{ start: number; end: number }>,
): ByteRange[] {
  const result: ByteRange[] = [];
  for (const range of ranges) {
    if (range.kind !== "unknown" || range.size <= 0) {
      result.push(range);
      continue;
    }
    let pieces = [{ start: range.offset, end: range.offset + range.size }];
    for (const extent of covered) {
      pieces = pieces.flatMap((piece) => {
        if (!overlaps(piece.start, piece.end, extent.start, extent.end))
          return [piece];
        const split: Array<{ start: number; end: number }> = [];
        if (piece.start < extent.start)
          split.push({ start: piece.start, end: extent.start });
        if (extent.end < piece.end)
          split.push({ start: extent.end, end: piece.end });
        return split;
      });
    }
    pieces.forEach((piece, pieceIndex) => {
      if (piece.end <= piece.start) return;
      const unchanged =
        pieces.length === 1 &&
        piece.start === range.offset &&
        piece.end === range.offset + range.size;
      result.push({
        ...range,
        id: unchanged ? range.id : `${range.id}:part-${pieceIndex + 1}`,
        offset: piece.start,
        size: piece.end - piece.start,
      });
    });
  }
  return result;
}

function restoreSplitUnknownRanges(ranges: ByteRange[]): ByteRange[] {
  // Previously overlaid bytes must become unknown again, including extents that
  // consumed an entire original range or either edge of it.
  if (!ranges.some((range) => range.id.startsWith("semantic:")))
    return ranges.map((range) => ({ ...range }));
  const restored = ranges.map(
    (range): ByteRange =>
      range.id.startsWith("semantic:")
        ? {
            id: `restored:${range.id}`,
            label: "Unclassified bytes",
            offset: range.offset,
            size: range.size,
            kind: "unknown",
          }
        : { ...range, id: range.id.replace(/:part-\d+$/, "") },
  );
  restored.sort((left, right) => left.offset - right.offset);
  const result: ByteRange[] = [];
  for (const range of restored) {
    const previous = result.at(-1);
    if (
      previous?.kind === "unknown" &&
      range.kind === "unknown" &&
      previous.offset + previous.size >= range.offset
    ) {
      previous.size =
        Math.max(previous.offset + previous.size, range.offset + range.size) -
        previous.offset;
    } else {
      result.push(range);
    }
  }
  return result;
}

/**
 * Validate and attach a `duckdb-file-layout/v1` semantic sidecar to a physical inspection.
 * The sidecar is accepted only for the matching storage version, file size, and header fingerprint.
 */
export function applyManifest(
  inspection: FileInspection,
  value: unknown,
): FileInspection {
  if (inspection.native)
    throw new Error(
      "This file already has a directly decoded checkpoint map; a sidecar cannot replace verified native ranges.",
    );
  if (inspection.storageVersion !== STORAGE_VERSION) {
    throw new Error(
      `Semantic manifests require storage version ${STORAGE_VERSION}; inspected file is version ${inspection.storageVersion}.`,
    );
  }
  if (
    !Number.isSafeInteger(inspection.fileSize) ||
    inspection.fileSize < 1 ||
    !Number.isSafeInteger(inspection.blockHeaderSize) ||
    inspection.blockHeaderSize < 0
  ) {
    throw new Error(
      "The physical inspection has invalid file or block-header bounds.",
    );
  }
  if (!isRecord(value)) invalid("manifest", "expected an object");

  checkKeys(
    value,
    "manifest",
    ["format", "storageVersion", "fileSize", "headerFingerprint", "segments"],
    ["fileName"],
  );
  if (value.format !== "duckdb-file-layout/v1")
    invalid("format", 'expected "duckdb-file-layout/v1"');
  if (value.storageVersion !== STORAGE_VERSION)
    invalid("storageVersion", `expected ${STORAGE_VERSION}`);
  const fileSize = safeInteger(value.fileSize, "fileSize", 1);
  if (fileSize !== inspection.fileSize)
    invalid(
      "fileSize",
      `expected ${inspection.fileSize} to match the inspected file`,
    );

  const manifestFingerprint = fingerprint(
    value.headerFingerprint,
    "headerFingerprint",
  );
  const inspectedFingerprint = fingerprint(
    inspection.headerFingerprint,
    "inspection.headerFingerprint",
  );
  if (manifestFingerprint !== inspectedFingerprint) {
    invalid(
      "headerFingerprint",
      "does not match the first 12 KiB of the inspected file",
    );
  }

  if (!Array.isArray(value.segments)) invalid("segments", "expected an array");
  if (value.segments.length > MAX_SEGMENTS)
    invalid("segments", `cannot exceed ${MAX_SEGMENTS} entries`);
  const fileName = Object.hasOwn(value, "fileName")
    ? boundedString(value.fileName, "fileName", 1024)
    : undefined;
  const segments = value.segments.map(parseSegment);

  const blockById = new Map<number, FileBlock>();
  for (const block of inspection.blocks) {
    if (!Number.isSafeInteger(block.id) || blockById.has(block.id)) {
      throw new Error(
        "The physical inspection contains an invalid or duplicate block ID.",
      );
    }
    if (block.id < 0) {
      if (block.role === "header") continue;
      throw new Error(
        `The physical inspection contains an invalid negative block ID ${block.id}.`,
      );
    }
    if (
      !Number.isSafeInteger(block.offset) ||
      block.offset < 0 ||
      !Number.isSafeInteger(block.size) ||
      block.size < 0
    ) {
      throw new Error(
        `The physical inspection has invalid bounds for block ${block.id}.`,
      );
    }
    if (
      !Number.isSafeInteger(block.offset + block.size) ||
      block.offset + block.size > inspection.fileSize
    ) {
      throw new Error(
        `The physical inspection has out-of-file bounds for block ${block.id}.`,
      );
    }
    blockById.set(block.id, block);
  }

  const seenSegmentIds = new Set<string>();
  const segmentsByBlock = new Map<number, Segment[]>();
  const coveredByBlock = new Map<
    number,
    Array<{ start: number; end: number; segmentId: string }>
  >();
  for (const segment of segments) {
    if (seenSegmentIds.has(segment.id))
      invalid("segments", `duplicate segment ID "${segment.id}"`);
    seenSegmentIds.add(segment.id);
    const block = blockById.get(segment.blockId);
    if (!block)
      invalid(
        `segments[${segment.id}].blockId`,
        "does not refer to a block in the physical inspection",
      );
    if (block.role !== "unknown" && block.role !== "data") {
      invalid(
        `segments[${segment.id}].blockId`,
        `points to a ${block.role} block`,
      );
    }
    if (segment.offset < inspection.blockHeaderSize) {
      invalid(
        `segments[${segment.id}].offset`,
        `must begin after the ${inspection.blockHeaderSize}-byte block header`,
      );
    }
    if (segment.offset >= block.size)
      invalid(
        `segments[${segment.id}].offset`,
        "must be inside the referenced block",
      );
    const absoluteStart = block.offset + segment.offset;
    if (
      !Number.isSafeInteger(absoluteStart) ||
      absoluteStart >= inspection.fileSize
    ) {
      invalid(
        `segments[${segment.id}].offset`,
        "points outside the inspected file",
      );
    }
    if (segment.byteSize !== null) {
      const absoluteEnd = absoluteStart + segment.byteSize;
      if (
        !Number.isSafeInteger(absoluteEnd) ||
        segment.byteSize > block.size - segment.offset ||
        absoluteEnd > inspection.fileSize
      ) {
        invalid(
          `segments[${segment.id}].byteSize`,
          "extends beyond the referenced block or file",
        );
      }
      if (segment.byteSize > 0) {
        const extents = coveredByBlock.get(segment.blockId) ?? [];
        if (
          extents.some((extent) =>
            overlaps(absoluteStart, absoluteEnd, extent.start, extent.end),
          )
        ) {
          invalid(
            `segments[${segment.id}]`,
            "exact physical extent overlaps another segment in the same block",
          );
        }
        extents.push({
          start: absoluteStart,
          end: absoluteEnd,
          segmentId: segment.id,
        });
        coveredByBlock.set(segment.blockId, extents);
      }
    }
    const list = segmentsByBlock.get(segment.blockId) ?? [];
    list.push(segment);
    segmentsByBlock.set(segment.blockId, list);
  }

  const previousSegmentIds = new Set(
    inspection.segments.map((segment) => segment.id),
  );
  const previousSegmentBlocks = new Set(
    inspection.segments.map((segment) => segment.blockId),
  );
  const blocks = inspection.blocks.map((block) => {
    const forBlock = segmentsByBlock.get(block.id);
    const staleSemanticBlock =
      previousSegmentBlocks.has(block.id) &&
      block.label.startsWith("Table data · ");
    if (!forBlock) {
      return {
        ...block,
        ...(staleSemanticBlock
          ? { role: "unknown" as const, label: `Block ${block.id}` }
          : {}),
        ranges: restoreSplitUnknownRanges(block.ranges),
        segmentIds: block.segmentIds.filter(
          (id) => !previousSegmentIds.has(id),
        ),
        links: [...block.links],
      };
    }

    const segmentIds = new Set(
      block.segmentIds.filter((id) => !previousSegmentIds.has(id)),
    );
    for (const segment of forBlock) segmentIds.add(segment.id);
    const baseRanges = restoreSplitUnknownRanges(block.ranges);
    const exactExtents = (coveredByBlock.get(block.id) ?? []).map(
      ({ start, end }) => ({ start, end }),
    );
    for (const range of baseRanges) {
      if (range.kind === "unknown") continue;
      if (
        exactExtents.some((extent) =>
          overlaps(
            range.offset,
            range.offset + range.size,
            extent.start,
            extent.end,
          ),
        )
      ) {
        invalid(
          `blocks[${block.id}].ranges`,
          "an exact segment extent overlaps a known physical range",
        );
      }
    }
    const ranges = subtractCoveredUnknownRanges(baseRanges, exactExtents);
    for (const segment of forBlock) {
      if (segment.byteSize === null || segment.byteSize === 0) continue;
      ranges.push({
        id: `semantic:${segment.id}`,
        label: `${segment.table}.${segment.column} · ${segment.compression}`,
        offset: block.offset + segment.offset,
        size: segment.byteSize,
        kind: "segment",
        segmentId: segment.id,
      });
    }
    return {
      ...block,
      role: "data" as const,
      label:
        block.role === "unknown"
          ? `Table data · ${forBlock.length} segment${forBlock.length === 1 ? "" : "s"}`
          : block.label,
      ranges,
      segmentIds: [...segmentIds],
      links: [...block.links],
    };
  });

  const unknownSizes = segments.filter(
    (segment) => segment.byteSize === null,
  ).length;
  const warnings = [
    ...inspection.warnings.filter(
      (warning) =>
        !warning.startsWith("Semantic metadata matched") &&
        !warning.startsWith("Exact byte sizes are unavailable"),
    ),
    `Semantic metadata matched the inspected file by storage version, file size, and SHA-256 of its first 12 KiB${fileName ? ` (${fileName})` : ""}.`,
    ...(unknownSizes > 0
      ? [
          `Exact byte sizes are unavailable for ${unknownSizes} segment${unknownSizes === 1 ? "" : "s"}; their block and row metadata is shown without claiming a physical extent.`,
        ]
      : []),
  ];

  return {
    ...inspection,
    blocks,
    segments,
    warnings,
    capabilities: { ...inspection.capabilities, semantic: true },
  };
}

export type { SemanticManifest };
