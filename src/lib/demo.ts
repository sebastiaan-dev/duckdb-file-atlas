import type { ByteRange, FileBlock, FileInspection, Segment } from "./types";

const HEADER_SIZE = 4096;
const DATA_START = HEADER_SIZE * 3;
const BLOCK_SIZE = 262_144;
const CHECKSUM_SIZE = 8;
const BLOCK_COUNT = 320;
const ROW_GROUP_ROWS = 122_880;

type ColumnSpec = {
  name: string;
  type: string;
  bytes: number;
  codec: string;
  min: string;
  max: string;
  nullable?: boolean;
};
type TableSpec = { name: string; groups: number; columns: ColumnSpec[] };
const tables: TableSpec[] = [
  {
    name: "analytics.events",
    groups: 14,
    columns: [
      {
        name: "event_id",
        type: "BIGINT",
        bytes: 51_200,
        codec: "Bitpacking",
        min: "1000001",
        max: "2720320",
      },
      {
        name: "customer_id",
        type: "BIGINT",
        bytes: 96_000,
        codec: "Bitpacking",
        min: "1",
        max: "1185920",
      },
      {
        name: "event_type",
        type: "VARCHAR",
        bytes: 42_000,
        codec: "Dictionary",
        min: "add_to_cart",
        max: "view",
      },
      {
        name: "path",
        type: "VARCHAR",
        bytes: 420_000,
        codec: "FSST",
        min: "/account",
        max: "/search",
        nullable: true,
      },
      {
        name: "payload",
        type: "VARCHAR",
        bytes: 1_150_000,
        codec: "FSST",
        min: '{"action":"add"}',
        max: '{"action":"view"}',
        nullable: true,
      },
      {
        name: "is_mobile",
        type: "BOOLEAN",
        bytes: 4096,
        codec: "RLE",
        min: "false",
        max: "true",
      },
    ],
  },
  {
    name: "analytics.orders",
    groups: 12,
    columns: [
      {
        name: "order_id",
        type: "BIGINT",
        bytes: 48_000,
        codec: "Bitpacking",
        min: "9000001",
        max: "10434560",
      },
      {
        name: "customer_id",
        type: "BIGINT",
        bytes: 91_000,
        codec: "Bitpacking",
        min: "1",
        max: "1185920",
      },
      {
        name: "amount",
        type: "DOUBLE",
        bytes: 127_000,
        codec: "ALP",
        min: "1.25",
        max: "9999.99",
      },
      {
        name: "status",
        type: "VARCHAR",
        bytes: 24_000,
        codec: "Dictionary",
        min: "cancelled",
        max: "shipped",
      },
      {
        name: "items",
        type: "VARCHAR",
        bytes: 250_000,
        codec: "FSST",
        min: '[{"sku":"A-001"}]',
        max: '[{"sku":"Z-999"}]',
      },
      {
        name: "note",
        type: "VARCHAR",
        bytes: 950_000,
        codec: "FSST",
        min: "",
        max: "Wrap separately",
        nullable: true,
      },
    ],
  },
  {
    name: "analytics.customers",
    groups: 10,
    columns: [
      {
        name: "customer_id",
        type: "BIGINT",
        bytes: 45_000,
        codec: "Bitpacking",
        min: "1",
        max: "1185920",
      },
      {
        name: "region",
        type: "VARCHAR",
        bytes: 34_000,
        codec: "Dictionary",
        min: "APAC",
        max: "West",
      },
      {
        name: "lifetime_value",
        type: "DOUBLE",
        bytes: 118_000,
        codec: "ALP",
        min: "0.00",
        max: "95000.00",
        nullable: true,
      },
      {
        name: "email",
        type: "VARCHAR",
        bytes: 270_000,
        codec: "FSST",
        min: "a@example.test",
        max: "z@example.test",
      },
      {
        name: "profile",
        type: "VARCHAR",
        bytes: 750_000,
        codec: "FSST",
        min: '{"region":"APAC"}',
        max: '{"region":"West"}',
        nullable: true,
      },
      {
        name: "active",
        type: "BOOLEAN",
        bytes: 3072,
        codec: "RLE",
        min: "false",
        max: "true",
      },
    ],
  },
];

/** A deterministic illustrative model, not a parsed DuckDB file or a raw-byte fixture. */
export function createDemo(): FileInspection {
  const segments: Segment[] = [];
  const freeIds = new Set<number>();
  const metadataIds = new Set<number>([
    0, 1, 2, 3, 60, 61, 122, 123, 184, 185, 246, 247,
  ]);
  const indexIds = new Set<number>([7, 50, 93, 136, 179, 222, 265, 308]);
  for (let id = 4; id < BLOCK_COUNT; id++) {
    if (
      !metadataIds.has(id) &&
      !indexIds.has(id) &&
      (id % 19 === 13 || id % 37 === 9)
    )
      freeIds.add(id);
  }
  const availableIds = Array.from({ length: BLOCK_COUNT }, (_, id) => id)
    .filter(
      (id) => !metadataIds.has(id) && !indexIds.has(id) && !freeIds.has(id),
    )
    .sort((a, b) => ((a * 73) % 317) - ((b * 73) % 317) || a - b);
  const dataBlocks = new Map<number, FileBlock>();
  let allocationIndex = -1;
  let current: FileBlock | undefined;
  let cursor = CHECKSUM_SIZE;
  let sequence = 0;

  function allocate(size: number): { block: FileBlock; offset: number } {
    const gap = sequence % 7 === 0 ? 1536 : sequence % 3 === 0 ? 256 : 0;
    if (!current || cursor + gap + size > BLOCK_SIZE) {
      const id = availableIds[++allocationIndex];
      if (id === undefined)
        throw new Error("Illustrative segments exceed the demo block budget.");
      current = block(id, "data", "Illustrative column data", []);
      dataBlocks.set(id, current);
      cursor = CHECKSUM_SIZE;
    } else if (gap) {
      current.ranges.push(
        range(
          current.id,
          `gap-${sequence}`,
          cursor,
          gap,
          "unused",
          "Alignment / reusable space",
        ),
      );
      cursor += gap;
    }
    const offset = cursor;
    cursor += size;
    sequence++;
    return { block: current, offset };
  }

  // Interleave columns, row groups, and tables before scattering their physical allocation.
  for (let group = 0; group < 14; group++) {
    for (let columnIndex = 0; columnIndex < 6; columnIndex++) {
      tables.forEach((table, tableIndex) => {
        if (group >= table.groups) return;
        const column = table.columns[columnIndex];
        const rows =
          group === table.groups - 1
            ? 80_000 + tableIndex * 4096
            : ROW_GROUP_ROWS;
        const variation =
          0.72 + ((group * 7 + columnIndex * 3 + tableIndex) % 11) * 0.061;
        const totalBytes =
          Math.ceil((column.bytes * variation * rows) / ROW_GROUP_ROWS / 8) * 8;
        const parts = Math.ceil(totalBytes / 120_000);
        let previousRows = 0;
        let previousBytes = 0;
        for (let part = 0; part < parts; part++) {
          const nextRows = Math.floor((rows * (part + 1)) / parts);
          const nextBytes =
            Math.floor((totalBytes * (part + 1)) / parts / 8) * 8;
          const byteSize = nextBytes - previousBytes;
          const location = allocate(byteSize);
          const id = `${table.name}.${column.name}.rg${group}.s${part}`;
          const nullCount = column.nullable
            ? Math.floor(
                (nextRows - previousRows) *
                  (column.name === "note" ? 0.15 : 0.004),
              )
            : 0;
          const segment: Segment = {
            id,
            table: table.name,
            column: column.name,
            columnType: column.type,
            rowGroup: group,
            blockId: location.block.id,
            offset: location.offset,
            byteSize,
            rowStart: group * ROW_GROUP_ROWS + previousRows,
            rowCount: nextRows - previousRows,
            compression:
              column.codec === "FSST" && (group + columnIndex) % 5 === 0
                ? "Dictionary"
                : column.codec,
            min: column.min,
            max: column.max,
            nullCount,
            stats: `${nextRows - previousRows} rows · ${nullCount} nulls · illustrative statistics`,
          };
          segments.push(segment);
          location.block.segmentIds.push(id);
          location.block.ranges.push({
            ...range(
              location.block.id,
              id,
              location.offset,
              byteSize,
              "segment",
              `${table.name}.${column.name}`,
            ),
            segmentId: id,
          });
          previousRows = nextRows;
          previousBytes = nextBytes;
        }
      });
    }
  }

  // All unallocated physical blocks are genuinely reusable in this synthetic model.
  availableIds.slice(allocationIndex + 1).forEach((id) => freeIds.add(id));
  const freeList = [...freeIds].sort((a, b) => a - b);
  const blocks: FileBlock[] = [
    header(-3, "Main header · illustrative", [-2, -1]),
    header(-2, "Checkpoint header 1 · illustrative", [0, 1]),
    header(-1, "Checkpoint header 2 · illustrative", [0, 1]),
  ];
  const segmentMap = new Map(segments.map((segment) => [segment.id, segment]));
  for (let id = 0; id < BLOCK_COUNT; id++) {
    let item = dataBlocks.get(id);
    if (item) {
      item.label = [
        ...new Set(
          item.segmentIds.map((segmentId) => segmentMap.get(segmentId)!.table),
        ),
      ].join(" · ");
    } else if (metadataIds.has(id)) {
      const isFreeList = id === 1;
      const links = isFreeList
        ? freeList
        : id === 0
          ? [2, 3, 60, 122, 184, 246]
          : [];
      item = block(
        id,
        "metadata",
        isFreeList
          ? "Free-list metadata · illustrative"
          : "Catalog / row-group metadata · illustrative",
        links,
      );
      const size = (isFreeList ? 2 : 9 + (id % 28)) * 4096;
      item.ranges.push(
        range(id, "metadata", CHECKSUM_SIZE, size, "metadata", item.label),
      );
    } else if (indexIds.has(id)) {
      const targets = [...dataBlocks.keys()]
        .filter((_, index) => index % 8 === [...indexIds].indexOf(id))
        .slice(0, 12);
      item = block(id, "index", "ART index · illustrative", targets);
      item.ranges.push(
        range(
          id,
          "index",
          CHECKSUM_SIZE,
          70_000 + (id % 5) * 28_000,
          "unknown",
          "Synthetic index payload",
        ),
      );
    } else {
      item = block(id, "free", "Reusable block · illustrative", []);
    }
    const end =
      item.ranges.at(-1)!.offset + item.ranges.at(-1)!.size - item.offset;
    if (end < BLOCK_SIZE)
      item.ranges.push(
        range(
          id,
          "tail",
          end,
          BLOCK_SIZE - end,
          "unused",
          item.role === "free"
            ? "Reusable payload space"
            : "Unused block space",
        ),
      );
    // Accounting includes the modeled checksum field consistently for every role.
    item.usedBytes = item.ranges.reduce(
      (sum, part) => sum + (part.kind === "unused" ? 0 : part.size),
      0,
    );
    blocks.push(item);
  }
  return {
    name: "warehouse-demo.duckdb",
    fileSize: DATA_START + BLOCK_COUNT * BLOCK_SIZE,
    source: "demo",
    storageVersion: 69,
    blockSize: BLOCK_SIZE,
    blockHeaderSize: CHECKSUM_SIZE,
    vectorSize: 2048,
    libraryVersion: "Illustrative DuckDB layout",
    activeHeader: 2,
    headers: [1, 2].map((slot) => ({
      slot: slot as 1 | 2,
      iteration: String(11 + slot),
      metaBlock: "0",
      freeList: "1",
      blockCount: BLOCK_COUNT,
      blockSize: BLOCK_SIZE,
      vectorSize: 2048,
      storageVersion: 69,
      valid: true,
    })),
    blocks,
    segments,
    warnings: [
      "Illustrative sample: tables, allocation, byte sizes, statistics, compression labels, metadata and index roles are synthetic. No real DuckDB bytes or verified checksums are supplied.",
    ],
    capabilities: { semantic: true, exactSizes: true, checksums: false },
  };
}

/** Deterministic placeholder bytes only; these are not bytes from a DuckDB database. */
export function demoBytes(offset: number, length: number): Uint8Array {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0
  )
    throw new RangeError(
      "Byte ranges must use non-negative safe integer offsets and lengths.",
    );
  if (
    !Number.isSafeInteger(offset + length) ||
    offset + length > DATA_START + BLOCK_COUNT * BLOCK_SIZE
  )
    throw new RangeError(
      "Requested demo bytes exceed the illustrative sample file.",
    );
  return Uint8Array.from(
    { length },
    (_, index) => ((offset + index) * 31 + 17) & 0xff,
  );
}

function range(
  id: number,
  suffix: string,
  offset: number,
  size: number,
  kind: ByteRange["kind"],
  label: string,
): ByteRange {
  return {
    id: `block-${id}-${suffix}`,
    label,
    offset: DATA_START + id * BLOCK_SIZE + offset,
    size,
    kind,
  };
}
function block(
  id: number,
  role: FileBlock["role"],
  label: string,
  links: number[],
): FileBlock {
  return {
    id,
    offset: DATA_START + id * BLOCK_SIZE,
    size: BLOCK_SIZE,
    role,
    label,
    usedBytes: 0,
    segmentIds: [],
    links,
    ranges: [
      range(
        id,
        "checksum",
        0,
        CHECKSUM_SIZE,
        "checksum",
        "Illustrative checksum field",
      ),
    ],
    checksum: "illustrative",
  };
}
function header(id: -3 | -2 | -1, label: string, links: number[]): FileBlock {
  const offset = (id + 3) * HEADER_SIZE;
  return {
    id,
    offset,
    size: HEADER_SIZE,
    role: "header",
    label,
    usedBytes: HEADER_SIZE,
    links,
    segmentIds: [],
    checksum: "illustrative",
    ranges: [
      {
        id: `header-${id}-checksum`,
        label: "Illustrative checksum field",
        offset,
        size: CHECKSUM_SIZE,
        kind: "checksum",
      },
      {
        id: `header-${id}-body`,
        label,
        offset: offset + CHECKSUM_SIZE,
        size: HEADER_SIZE - CHECKSUM_SIZE,
        kind: "header",
      },
    ],
  };
}
