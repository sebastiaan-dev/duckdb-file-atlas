import { BinaryReader, readBlockPointer } from "./binary-reader";
import { displayIdentifier, type LogicalType } from "./checkpoint-catalog";
import type { Segment } from "./types";

/** Statistics retained from a checkpoint without attempting to decode segment payloads. */
export interface DecodedStatistics {
  type: string;
  hasNull: boolean;
  hasNoNull: boolean;
  distinctCount: number;
  min?: string;
  max?: string;
  unit?: string;
  children?: Record<string, DecodedStatistics>;
  string?: { minExact?: boolean; maxExact?: boolean; maxLength?: number };
}

const COMPRESSION: Record<number, string> = {
  0: "Auto",
  1: "Uncompressed",
  2: "Constant",
  3: "RLE",
  4: "Dictionary",
  5: "PFOR",
  6: "BitPacking",
  7: "FSST",
  8: "Chimp",
  9: "Patas",
  10: "ALP",
  11: "ALPRD",
  12: "ZSTD",
  13: "Roaring",
  14: "Empty Validity",
  15: "DICT_FSST",
};

function child(
  type: LogicalType,
  index: number,
): { name: string; type: LogicalType } {
  const result = type.children?.[index];
  if (!result)
    throw new Error(`Checkpoint type ${type.name} is missing child ${index}.`);
  return result;
}

function typeHasNumericStats(type: LogicalType): boolean {
  return [
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 27, 28, 29, 30, 31,
    32, 33, 34, 35, 49, 50, 54, 104,
  ].includes(type.id);
}

function formatDecimal(value: string, scale: number): string {
  if (scale <= 0) return value;
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(scale + 1, "0");
  const result = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
  return negative ? `-${result}` : result;
}

function formatDate(value: bigint): string | undefined {
  if (value === 2147483647n) return "infinity";
  if (value === -2147483647n) return "-infinity";
  const date = new Date(Number(value) * 86_400_000);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().split("T")[0];
}

function floorDiv(value: bigint, divisor: bigint): [bigint, bigint] {
  let quotient = value / divisor;
  let remainder = value % divisor;
  if (remainder < 0n) {
    quotient--;
    remainder += divisor;
  }
  return [quotient, remainder];
}

function formatEpoch(
  value: bigint,
  unitsPerSecond: bigint,
  precision: number,
): string | undefined {
  if (value === 9223372036854775807n) return "infinity";
  if (value === -9223372036854775807n) return "-infinity";
  const [seconds, remainder] = floorDiv(value, unitsPerSecond);
  const millis = Number(seconds * 1000n);
  const date = new Date(millis);
  if (!Number.isFinite(millis) || Number.isNaN(date.getTime()))
    return undefined;
  const fullIso = date.toISOString();
  const iso = fullIso.slice(0, fullIso.indexOf("."));
  const fraction = precision
    ? `.${((remainder * 10n ** BigInt(precision)) / unitsPerSecond).toString().padStart(precision, "0")}`
    : "";
  return `${iso}${fraction}Z`;
}

function formatTime(
  value: bigint,
  unitsPerSecond: bigint,
  precision: number,
): string | undefined {
  if (value < 0n) return undefined;
  const [seconds, remainder] = floorDiv(value, unitsPerSecond);
  if (seconds >= 86_400n) return undefined;
  const hour = seconds / 3600n;
  const minute = (seconds / 60n) % 60n;
  const second = seconds % 60n;
  const fraction = precision
    ? `.${((remainder * 10n ** BigInt(precision)) / unitsPerSecond).toString().padStart(precision, "0")}`
    : "";
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:${second.toString().padStart(2, "0")}${fraction}`;
}

function formatTimeTZ(value: bigint): string | undefined {
  const bits = BigInt.asUintN(64, value);
  const micros = bits >> 24n;
  const offset = 57599 - Number(bits & 0xffffffn);
  const time = formatTime(micros, 1_000_000n, 6);
  if (!time || Math.abs(offset) > 57599) return undefined;
  const absolute = Math.abs(offset);
  const hh = Math.floor(absolute / 3600)
    .toString()
    .padStart(2, "0");
  const mm = Math.floor((absolute % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const ss = (absolute % 60).toString().padStart(2, "0");
  return `${time}${offset < 0 ? "-" : "+"}${hh}:${mm}${ss === "00" ? "" : `:${ss}`}`;
}

function temporalUnit(type: LogicalType): string | undefined {
  switch (type.id) {
    case 15:
      return "days from 1970-01-01; displayed as a calendar date";
    case 16:
      return "microseconds since midnight; displayed as a time of day";
    case 17:
      return "seconds from the Unix epoch; displayed in UTC";
    case 18:
      return "milliseconds from the Unix epoch; displayed in UTC";
    case 19:
    case 32:
      return "microseconds from the Unix epoch; displayed in UTC";
    case 20:
    case 33:
      return "nanoseconds from the Unix epoch; displayed in UTC";
    case 34:
      return "packed time-of-day microseconds and UTC offset";
    case 35:
      return "nanoseconds since midnight; displayed as a time of day";
    default:
      return undefined;
  }
}

function readIntegerValue(
  reader: BinaryReader,
  type: LogicalType,
): string | number {
  switch (type.id) {
    case 10:
      return reader.bool() ? "true" : "false";
    case 11:
    case 12:
    case 13:
    case 14:
    case 15:
    case 16:
    case 17:
    case 18:
    case 19:
    case 20:
    case 21:
    case 27:
    case 32:
    case 33:
    case 34:
    case 35:
    case 50:
      if (type.id === 50 || (type.id === 21 && (type.width ?? 0) > 18)) {
        const upper = reader.signed();
        const lower = reader.unsigned();
        return ((upper << 64n) | lower).toString();
      }
      return reader.signed().toString();
    case 22:
      return reader.f32();
    case 23:
      return reader.f64();
    case 28:
    case 29:
    case 30:
    case 31:
      return reader.unsigned().toString();
    case 49: {
      const upper = reader.unsigned();
      const lower = reader.unsigned();
      return ((upper << 64n) | lower).toString();
    }
    case 54: {
      const upper = reader.signed();
      const lower = reader.unsigned();
      return formatUuid(upper, lower);
    }
    case 104:
      return reader.unsigned().toString();
    default:
      if (type.id === 21 && (type.width ?? 0) <= 4)
        return reader.signed().toString();
      if (type.id === 21 && (type.width ?? 0) <= 9)
        return reader.signed().toString();
      throw new Error(
        `Unsupported numeric checkpoint statistics for ${type.name}.`,
      );
  }
}

function formatUuid(encodedUpper: bigint, lower: bigint): string {
  const upper = BigInt.asUintN(64, encodedUpper) ^ (1n << 63n);
  const hex = `${upper.toString(16).padStart(16, "0")}${lower.toString(16).padStart(16, "0")}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readNumericStat(
  reader: BinaryReader,
  type: LogicalType,
): string | undefined {
  return reader.object(() => {
    reader.field(100);
    if (!reader.bool()) return undefined;
    reader.field(101);
    if (type.id === 27) {
      const interval = reader.object(() => {
        const months = reader.optional(1) ? reader.int() : 0;
        const days = reader.optional(2) ? reader.int() : 0;
        const micros = reader.optional(3) ? reader.signed().toString() : "0";
        return `${months} months ${days} days ${micros} microseconds`;
      });
      return interval;
    }
    const value = String(readIntegerValue(reader, type));
    if (type.id === 21) return formatDecimal(value, type.scale ?? 0);
    if (type.id === 104 && type.enumValues) {
      const label = type.enumValues[Number(value)];
      if (label === undefined)
        throw new Error("Invalid enum ordinal in checkpoint statistics.");
      return label;
    }
    if ([15, 16, 17, 18, 19, 20, 32, 33, 34, 35].includes(type.id)) {
      const integer = BigInt(value);
      switch (type.id) {
        case 15:
          return formatDate(integer) ?? `${value} days`;
        case 16:
          return (
            formatTime(integer, 1_000_000n, 6) ??
            `${value} microseconds since midnight`
          );
        case 17:
          return (
            formatEpoch(integer, 1n, 0) ?? `${value} seconds since Unix epoch`
          );
        case 18:
          return (
            formatEpoch(integer, 1_000n, 3) ??
            `${value} milliseconds since Unix epoch`
          );
        case 19:
        case 32:
          return (
            formatEpoch(integer, 1_000_000n, 6) ??
            `${value} microseconds since Unix epoch`
          );
        case 20:
        case 33:
          return (
            formatEpoch(integer, 1_000_000_000n, 9) ??
            `${value} nanoseconds since Unix epoch`
          );
        case 34:
          return formatTimeTZ(integer) ?? `${value} packed TIME_TZ`;
        case 35:
          return (
            formatTime(integer, 1_000_000_000n, 9) ??
            `${value} nanoseconds since midnight`
          );
      }
    }
    switch (type.id) {
      default:
        return value;
    }
  });
}

function readStringStats(
  reader: BinaryReader,
  byteString = false,
): { min?: string; max?: string; info: DecodedStatistics["string"] } {
  const decoder = new TextDecoder("utf-8");
  const render = (value: Uint8Array) =>
    byteString
      ? `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
      : decoder.decode(value);
  if (reader.optional(200)) {
    // Pre-v2.0 streams can survive a file upgrade. DuckDB's LegacyReadMinMax /
    // LegacyGetMinMaxType use zero-padded eight-byte bounds, not packed field 206.
    const minBytes = reader.blob();
    reader.field(201);
    const maxBytes = reader.blob();
    if (minBytes.length !== 8 || maxBytes.length !== 8)
      throw new Error(
        "Invalid legacy checkpoint string statistics min/max payload.",
      );
    reader.field(202);
    reader.bool(); // has_unicode
    reader.field(203);
    const hasMaxLength = reader.bool();
    reader.field(204);
    const storedMaxLength = reader.uint();
    const maxLength = hasMaxLength ? storedMaxLength : undefined;
    const unset =
      minBytes[0] > maxBytes[0] ||
      (minBytes.every((byte) => byte === 0) &&
        maxBytes.every((byte) => byte === 255));
    const exact =
      hasMaxLength &&
      storedMaxLength <= 8 &&
      (storedMaxLength === 0 ||
        (minBytes[storedMaxLength - 1] !== 0 &&
          maxBytes[storedMaxLength - 1] !== 0));
    const trim = (bytes: Uint8Array) => {
      let length = bytes.length;
      while (length && bytes[length - 1] === 0) length--;
      return bytes.subarray(0, length);
    };
    return {
      min: unset ? undefined : render(trim(minBytes)),
      max: unset ? undefined : render(trim(maxBytes)),
      info: {
        minExact: unset ? undefined : exact,
        maxExact: unset ? undefined : exact,
        maxLength,
      },
    };
  }
  const hasMaxLength = reader.optional(204);
  const maxLength = hasMaxLength ? reader.uint() : undefined;
  const bytes = reader.optional(205) ? reader.blob() : undefined;
  if (bytes && bytes.length !== 24)
    throw new Error("Invalid checkpoint string statistics min/max payload.");
  reader.field(206);
  const packed = reader.uint();
  const minLength = (packed >>> 3) & 0xf;
  const maxValueLength = (packed >>> 7) & 0xf;
  if (minLength > 12 || maxValueLength > 12)
    throw new Error("Invalid checkpoint string statistics lengths.");
  // Field 207 is an optional_idx, encoded as a uint64 (INVALID_INDEX means unknown).
  if (reader.optional(207)) reader.unsigned();
  const min = bytes ? render(bytes.subarray(0, minLength)) : undefined;
  const max = bytes
    ? render(bytes.subarray(12, 12 + maxValueLength))
    : undefined;
  return {
    min,
    max,
    info: {
      minExact: bytes ? Boolean(packed & (1 << 1)) : undefined,
      maxExact: bytes ? Boolean(packed & (1 << 2)) : undefined,
      maxLength,
    },
  };
}

function readBaseStatistics(
  reader: BinaryReader,
  type: LogicalType,
): DecodedStatistics {
  return reader.object(() => {
    reader.field(100);
    const hasNull = reader.bool();
    reader.field(101);
    const hasNoNull = reader.bool();
    reader.field(102);
    const distinctCount = reader.uint();
    reader.field(103);
    const nested = reader.object(() => {
      if (typeHasNumericStats(type)) {
        reader.field(200);
        const min = readNumericStat(reader, type);
        reader.field(201);
        const max = readNumericStat(reader, type);
        return { min, max, unit: temporalUnit(type) };
      }
      if (type.id === 24 || type.id === 25 || type.id === 26 || type.id === 36)
        return readStringStats(reader, type.id === 26 || type.id === 36);
      if (type.id === 101 || type.id === 102) {
        reader.field(200);
        const value = readBaseStatistics(reader, child(type, 0).type);
        return { children: { [child(type, 0).name]: value } };
      }
      if (type.id === 100 || type.id === 107 || type.id === 110) {
        reader.field(200);
        const values = reader.list((index) =>
          readBaseStatistics(reader, child(type, index).type),
        );
        if (values.length !== (type.children?.length ?? 0))
          throw new Error(
            `Checkpoint ${type.name} statistics child count does not match its type.`,
          );
        return {
          children: Object.fromEntries(
            values.map((value, index) => [child(type, index).name, value]),
          ),
        };
      }
      if (type.id === 108) {
        reader.field(200);
        return {
          children: {
            [child(type, 0).name]: readBaseStatistics(
              reader,
              child(type, 0).type,
            ),
          },
        };
      }
      // Base statistics (e.g. VALIDITY/BIT) serialize an empty type_stats object.
      if (reader.peekField() !== 0xffff)
        throw new Error(
          `Unsupported type-specific checkpoint statistics for ${type.name}.`,
        );
      return {};
    });
    const result: DecodedStatistics = {
      type: type.name,
      hasNull,
      hasNoNull,
      distinctCount,
    };
    if ("min" in nested && nested.min !== undefined) result.min = nested.min;
    if ("max" in nested && nested.max !== undefined) result.max = nested.max;
    if ("unit" in nested && nested.unit !== undefined)
      result.unit = nested.unit;
    if ("children" in nested && nested.children)
      result.children = nested.children;
    if ("info" in nested && nested.info) result.string = nested.info;
    return result;
  });
}

/** Reads one BaseStatistics object using the type supplied by the parent catalog. */
export function readStatistics(
  reader: BinaryReader,
  type: LogicalType,
): DecodedStatistics {
  return readBaseStatistics(reader, type);
}

function readDistinct(reader: BinaryReader) {
  reader.object(() => {
    if (reader.optional(100)) reader.unsigned();
    if (reader.optional(101)) reader.unsigned();
    if (reader.optional(102)) {
      const present = reader.nullable(() =>
        reader.object(() => {
          reader.field(100);
          reader.uint();
          reader.field(101);
          reader.blob();
        }),
      );
      void present;
    }
  });
}

function readBaseReservoir(reader: BinaryReader) {
  reader.object(() => {
    if (reader.optional(100)) reader.uint();
    reader.field(101);
    reader.f64();
    if (reader.optional(102)) reader.uint();
    if (reader.optional(103)) reader.uint();
    if (reader.optional(104)) reader.uint();
    if (reader.optional(105))
      reader.list(() =>
        reader.object(() => {
          reader.field(0);
          reader.f64();
          reader.field(1);
          reader.uint();
        }),
      );
  });
}

function readTableSample(reader: BinaryReader) {
  reader.object(() => {
    if (reader.optional(100)) reader.nullable(() => readBaseReservoir(reader));
    reader.field(101);
    const sampleType = reader.uint();
    if (reader.optional(102)) reader.bool();
    if (sampleType === 1) {
      if (reader.optional(200)) reader.uint();
      if (reader.optional(201)) {
        const hasChunk = reader.nullable(() => true);
        if (hasChunk)
          throw new Error(
            "Checkpoint table statistics contain a materialized reservoir chunk that is not supported.",
          );
      }
      return;
    }
    if (sampleType === 2) {
      reader.field(200);
      reader.f64();
      if (reader.optional(201)) reader.uint();
      return;
    }
    throw new Error(`Unsupported checkpoint table sample type ${sampleType}.`);
  });
}

/**
 * Consumes a serialized TableStatistics object and returns its nullable per-column statistics.
 */
export function readTableStatistics(
  reader: BinaryReader,
  types: LogicalType[],
): (DecodedStatistics | null)[] {
  return reader.object(() => {
    reader.field(100);
    const columns = reader.list((index) => {
      const type = types[index];
      const value = reader.nullable(() => {
        if (!type)
          throw new Error(
            "Checkpoint table statistics contain more columns than the catalog schema.",
          );
        let result: DecodedStatistics | undefined;
        readColumnStatisticsWithResult(reader, type, (value) => {
          result = value;
        });
        return result!;
      });
      return value;
    });
    if (columns.length !== types.length)
      throw new Error(
        "Checkpoint table statistics column count does not match the catalog schema.",
      );
    if (reader.optional(101)) {
      const sample = reader.nullable(() => readTableSample(reader));
      void sample;
    }
    return columns;
  });
}

function readColumnStatisticsWithResult(
  reader: BinaryReader,
  type: LogicalType,
  set: (value: DecodedStatistics) => void,
) {
  reader.object(() => {
    reader.field(100);
    set(readStatistics(reader, type));
    if (reader.optional(101)) reader.nullable(() => readDistinct(reader));
  });
}

interface ReadContext {
  table: string;
  column: string;
  rowGroup: number;
  rowStart: number;
  rowCount?: number;
}
type ColumnPath = { label: string; kind: string }[];
interface PointerResult {
  segments: Segment[];
  tupleCount: number;
}
interface ColumnResult {
  segments: Segment[];
  rowCount: number;
}

function verifyCount(
  expected: number | undefined,
  actual: number,
  label: string,
) {
  if (expected !== undefined && expected !== actual)
    throw new Error(
      `Corrupt checkpoint: ${label} tuple count ${actual} does not match expected ${expected}.`,
    );
}

function appendPointerSegments(
  reader: BinaryReader,
  type: LogicalType,
  context: ReadContext,
  path: ColumnPath,
): PointerResult {
  if (!reader.optional(100)) return { segments: [], tupleCount: 0 };
  let rowStart = context.rowStart;
  let totalTuples = 0;
  const result = reader.list((index) =>
    reader.object(() => {
      // Deleted in v1.5: like DuckDB, consume the old row_start but derive row
      // ranges from the parent row group and tuple counts, including nested leaves.
      if (reader.optional(100)) reader.unsigned();
      const tupleCount = reader.optional(101) ? reader.uint() : 0;
      reader.field(102);
      const pointer = readBlockPointer(reader);
      reader.field(103);
      const compressionId = reader.uint();
      const compression = COMPRESSION[compressionId];
      if (!compression)
        throw new Error(
          `Unsupported checkpoint compression type ${compressionId}.`,
        );
      reader.field(104);
      const stats = readStatistics(reader, type);
      const overflow: number[] = [];
      if (reader.optional(105)) {
        const state = reader.nullable(() =>
          reader.object(() => {
            if (
              ![24, 25, 26, 36].includes(type.id) ||
              (compressionId !== 1 && compressionId !== 12)
            )
              throw new Error(
                `Unsupported serialized segment state for ${type.name}/${compression}.`,
              );
            reader.field(1);
            return reader.list(() => {
              const block = reader.int();
              if (block < 0)
                throw new Error(
                  "Corrupt checkpoint: invalid negative overflow block id.",
                );
              return block;
            });
          }),
        );
        if (state) overflow.push(...state);
      }
      let storedByteSize: number | null = null;
      if (reader.optional(106))
        storedByteSize = reader.nullable(() => reader.uint());
      if (
        !Number.isSafeInteger(totalTuples + tupleCount) ||
        !Number.isSafeInteger(rowStart + tupleCount)
      )
        throw new Error(
          "Corrupt checkpoint: segment row range exceeds safe integer precision.",
        );
      if (pointer.blockId < -1)
        throw new Error("Corrupt checkpoint: invalid negative data block id.");
      if (
        pointer.blockId === -1 &&
        ((compressionId !== 2 && compressionId !== 14) || pointer.offset !== 0)
      ) {
        throw new Error(
          "Corrupt checkpoint: invalid constant or empty-validity sentinel pointer.",
        );
      }
      // INVALID_BLOCK constants and empty segments do not occupy a physical block, even though
      // DuckDB may retain the in-memory segment_size in DataPointer.byte_size (field 106).
      const byteSize = pointer.blockId === -1 ? 0 : storedByteSize;
      const columnPath = [context.column, ...path.map((item) => item.label)];
      const segment: Segment = {
        id: JSON.stringify([
          context.table,
          columnPath,
          context.rowGroup,
          [...path.map((item) => item.kind), `${type.id}:data`],
          index,
        ]),
        table: context.table,
        column: columnPath.map(displayIdentifier).join("."),
        columnType: type.name,
        rowGroup: context.rowGroup,
        blockId: pointer.blockId,
        offset: pointer.offset + 8,
        byteSize,
        ...(pointer.blockId === -1 && storedByteSize !== null
          ? { storedByteSize }
          : {}),
        rowStart,
        rowCount: tupleCount,
        compression,
        ...(stats.min === undefined ? {} : { min: stats.min }),
        ...(stats.max === undefined ? {} : { max: stats.max }),
        stats: JSON.stringify(stats),
        ...(overflow.length ? { auxiliaryBlocks: [...new Set(overflow)] } : {}),
      };
      totalTuples += tupleCount;
      rowStart += tupleCount;
      return segment;
    }),
  );
  return { segments: result, tupleCount: totalTuples };
}

function readPersistentColumn(
  reader: BinaryReader,
  type: LogicalType,
  context: ReadContext,
  path: ColumnPath,
): ColumnResult {
  return reader.object(() => {
    if (reader.optional(99))
      throw new Error(
        `Unsupported persistent column extension data for ${type.name}.`,
      );
    const pointers = appendPointerSegments(reader, type, context, path);
    const result = pointers.segments;
    const complex = [100, 107, 108, 110].includes(type.id);
    if (pointers.tupleCount || !complex)
      verifyCount(
        context.rowCount,
        pointers.tupleCount,
        `${type.name} data pointers`,
      );
    let rowCount = pointers.tupleCount;
    if (complex && !pointers.tupleCount) rowCount = context.rowCount ?? 0;
    if (type.id === 53) return { segments: result, rowCount }; // VALIDITY is a physical BIT leaf.
    if (type.id === 109)
      throw new Error("Unsupported VARIANT persistent column layout.");

    const validityType: LogicalType = { id: 53, name: "VALIDITY" };
    reader.field(101);
    const validity = readPersistentColumn(
      reader,
      validityType,
      {
        ...context,
        rowCount:
          context.rowCount ??
          (pointers.tupleCount || !complex ? pointers.tupleCount : undefined),
      },
      [...path, { label: "validity", kind: "validity" }],
    );
    if (complex && !pointers.tupleCount && context.rowCount === undefined)
      rowCount = validity.rowCount;
    verifyCount(rowCount, validity.rowCount, `${type.name} validity`);
    result.push(...validity.segments);

    if (type.id === 100 || type.id === 107 || type.id === 110) {
      reader.field(102);
      const columns = reader.list((index) => {
        const item = child(type, index);
        return readPersistentColumn(
          reader,
          item.type,
          { ...context, rowCount },
          [...path, { label: item.name, kind: `child:${index}` }],
        );
      });
      if (columns.length !== (type.children?.length ?? 0))
        throw new Error(
          `Checkpoint ${type.name} child column count does not match its type.`,
        );
      for (const column of columns)
        verifyCount(rowCount, column.rowCount, `${type.name} child`);
      result.push(...columns.flatMap((column) => column.segments));
    } else if (type.id === 101 || type.id === 102 || type.id === 108) {
      reader.field(102);
      const item = { name: "element", type: child(type, 0).type };
      let arrayCount: number | undefined;
      if (type.id === 108 && type.arraySize !== undefined) {
        arrayCount = rowCount * type.arraySize;
        if (!Number.isSafeInteger(arrayCount))
          throw new Error(
            "Corrupt checkpoint: ARRAY child tuple count exceeds safe integer precision.",
          );
      }
      const element = readPersistentColumn(
        reader,
        item.type,
        { ...context, rowStart: 0, rowCount: arrayCount },
        [
          ...path,
          {
            label: item.name,
            kind: type.id === 108 ? "array-element" : "list-element",
          },
        ],
      );
      if (arrayCount !== undefined)
        verifyCount(arrayCount, element.rowCount, "ARRAY child");
      result.push(...element.segments);
    }
    return { segments: result, rowCount };
  });
}

/** Decodes the checkpoint's persistent column tree, exposing physical segment extents and references. */
export function readColumn(
  reader: BinaryReader,
  type: LogicalType,
  context: ReadContext,
): Segment[] {
  return readPersistentColumn(reader, type, context, []).segments;
}
