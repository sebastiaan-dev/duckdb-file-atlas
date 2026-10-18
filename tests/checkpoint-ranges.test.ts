import { describe, expect, test } from "bun:test";
import {
  mapMetadataSpan,
  refineMetadataRanges,
} from "../src/lib/checkpoint-ranges";
import type { MetadataRange } from "../src/lib/checkpoint-ranges";
import type { ByteRange, FileBlock } from "../src/lib/types";

function range(
  offset: number,
  size: number,
  kind: ByteRange["kind"] = "metadata",
  label = kind,
): ByteRange {
  return { id: `${kind}-${offset}`, offset, size, kind, label };
}

function block(offset = 100): FileBlock {
  return {
    id: offset,
    offset,
    size: 100,
    role: "metadata",
    label: "Verified metadata",
    usedBytes: 48,
    checksum: "1234",
    segmentIds: [],
    links: [],
    ranges: [
      range(offset, 8, "checksum"),
      range(offset + 8, 32),
      range(offset + 40, 16, "unknown"),
      range(offset + 56, 16, "unused"),
      range(offset + 72, 24),
      range(offset + 96, 4, "unused"),
    ],
  };
}

function span(
  offset: number,
  size: number,
  label = "Catalog",
  id = label,
): MetadataRange {
  return { id, offset, size, label, kind: "metadata" };
}

function partition(result: FileBlock): void {
  let cursor = result.offset;
  for (const part of result.ranges) {
    expect(part.offset).toBe(cursor);
    expect(part.size).toBeGreaterThan(0);
    cursor += part.size;
  }
  expect(cursor).toBe(result.offset + result.size);
}

function labelled(result: FileBlock): MetadataRange[] {
  return result.ranges.filter(
    (r) => (r as MetadataRange).metadataOwners,
  ) as MetadataRange[];
}

describe("checkpoint metadata physical span mapping", () => {
  test("splits a consumed unit across payload chunks without links/checksums", () => {
    const mapped = mapMetadataSpan(
      [
        { offset: 116, length: 4 }, // pointer begins beyond link header
        { offset: 148, length: 8 },
        { offset: 180, length: 8 }, // opened, but unconsumed continuation
      ],
      2,
      9,
      "Table statistics",
      "stats",
    );
    expect(
      mapped.map(({ offset, size, kind, label }) => ({
        offset,
        size,
        kind,
        label,
      })),
    ).toEqual([
      { offset: 118, size: 2, kind: "metadata", label: "Table statistics" },
      { offset: 148, size: 5, kind: "metadata", label: "Table statistics" },
    ]);
    expect(mapped[0].metadataOwners).toEqual([
      { id: "stats", label: "Table statistics" },
    ]);
    expect(new Set(mapped.map((r) => r.id)).size).toBe(2);
  });

  test("supports nonmonotonic physical chain order and zero-length spans", () => {
    expect(
      mapMetadataSpan(
        [
          { offset: 500, length: 2 },
          { offset: 100, length: 2 },
        ],
        1,
        3,
        "Column",
        "c",
      ).map(({ offset, size }) => ({ offset, size })),
    ).toEqual([
      { offset: 501, size: 1 },
      { offset: 100, size: 1 },
    ]);
    expect(
      mapMetadataSpan([{ offset: 100, length: 2 }], 2, 2, "empty", "e"),
    ).toEqual([]);
    expect(mapMetadataSpan([], 0, 0, "empty", "e")).toEqual([]);
  });

  test("maps a successful prefix despite a released/missing tail, rejects needed bytes", () => {
    const chunks = [{ offset: 116, length: 12 }];
    expect(mapMetadataSpan(chunks, 0, 5, "Descriptor", "d")[0].size).toBe(5);
    expect(() => mapMetadataSpan(chunks, 0, 13, "Descriptor", "d")).toThrow(
      /available payload/,
    );
  });

  test("rejects reversed, unsafe, negative, overlapping and out-of-bounds provenance", () => {
    for (const [start, stop] of [
      [-1, 2],
      [3, 2],
      [0, NaN],
      [0, Infinity],
      [0.5, 2],
      [0, 4],
    ]) {
      expect(() =>
        mapMetadataSpan([{ offset: 100, length: 3 }], start, stop, "x", "x"),
      ).toThrow(/Corrupt/);
    }
    for (const chunks of [
      [{ offset: -1, length: 2 }],
      [{ offset: 1, length: -1 }],
      [{ offset: Number.MAX_SAFE_INTEGER, length: 1 }],
      [
        { offset: 0, length: Number.MAX_SAFE_INTEGER },
        { offset: Number.MAX_SAFE_INTEGER, length: 1 },
      ],
      [
        { offset: 100, length: 3 },
        { offset: 102, length: 3 },
      ],
    ])
      expect(() => mapMetadataSpan(chunks, 0, 1, "x", "x")).toThrow(/Corrupt/);
  });
});

describe("checkpoint range partition refinement", () => {
  test("refines consumed bytes only, retaining checksum, unused slots, tails and allocation totals", () => {
    const original = block();
    const before = structuredClone(original);
    const mapped = mapMetadataSpan(
      [
        { offset: 116, length: 12 },
        { offset: 180, length: 12 },
      ],
      1,
      15,
      "Row-group descriptor",
      "rg",
    );
    const result = refineMetadataRanges([original], mapped)[0];
    partition(result);
    expect(original).toEqual(before);
    expect(result.usedBytes).toBe(original.usedBytes);
    expect(result.role).toBe(original.role);
    expect(result.checksum).toBe(original.checksum);
    expect(
      result.ranges.filter((r) => r.kind === "checksum" || r.kind === "unused"),
    ).toEqual(
      original.ranges.filter(
        (r) => r.kind === "checksum" || r.kind === "unused",
      ),
    );
    expect(
      labelled(result).map(({ offset, size }) => ({ offset, size })),
    ).toEqual([
      { offset: 117, size: 11 },
      { offset: 180, size: 3 },
    ]);
    expect(result.ranges.find((r) => r.offset === 128)?.kind).toBe("metadata");
    expect(result.ranges.find((r) => r.offset === 183)?.kind).toBe("metadata");
    expect(result.ranges.find((r) => r.offset === 140)?.kind).toBe("unknown");
  });

  test("consumed unknown bytes become metadata; their remainder stays unknown", () => {
    const result = refineMetadataRanges(
      [block()],
      [span(144, 4, "Deletes")],
    )[0];
    partition(result);
    expect(
      result.ranges
        .filter((r) => r.offset >= 140 && r.offset < 156)
        .map((r) => [r.offset, r.size, r.kind]),
    ).toEqual([
      [140, 4, "unknown"],
      [144, 4, "metadata"],
      [148, 8, "unknown"],
    ]);
  });

  test("deduplicates exact repeated units and retains all owner provenance", () => {
    const spans = [
      span(116, 8, "Column", "rg-1"),
      span(116, 8, "Column", "rg-2"),
      span(116, 8, "Column", "rg-1"),
    ];
    const result = refineMetadataRanges([block()], spans)[0];
    partition(result);
    expect(labelled(result)).toHaveLength(1);
    expect(labelled(result)[0].label).toBe("Column");
    expect(labelled(result)[0].metadataOwners).toEqual([
      { id: "rg-1", label: "Column" },
      { id: "rg-2", label: "Column" },
    ]);
    expect(refineMetadataRanges([result], spans)).toEqual([result]);
  });

  test("coalesces nested, partial, transitive and differently labelled exact overlaps conservatively", () => {
    for (const spans of [
      [span(116, 12, "Outer"), span(118, 4, "Inner")],
      [span(116, 8, "One"), span(120, 8, "Two")],
      [span(116, 5, "One"), span(120, 4, "Two"), span(123, 5, "Three")],
      [span(116, 12, "One"), span(116, 12, "Two")],
      [span(116, 8, "Column", "a"), span(120, 8, "Column", "b")],
    ]) {
      const result = refineMetadataRanges([block()], spans)[0];
      partition(result);
      expect(labelled(result)).toHaveLength(1);
      expect(labelled(result)[0].offset).toBe(116);
      expect(labelled(result)[0].size).toBe(12);
      expect(labelled(result)[0].label).toBe("Shared checkpoint metadata");
      expect(labelled(result)[0].metadataOwners?.length).toBe(spans.length);
      expect(refineMetadataRanges([block()], [...spans].reverse())).toEqual([
        result,
      ]);
    }
  });

  test("keeps adjacent units separate and splits spans across current allocated/unknown partitions", () => {
    const result = refineMetadataRanges(
      [block()],
      [span(132, 12, "Stats"), span(144, 4, "Deletes")],
    )[0];
    partition(result);
    expect(labelled(result).map((r) => [r.offset, r.size, r.label])).toEqual([
      [132, 8, "Stats"],
      [140, 4, "Stats"],
      [144, 4, "Deletes"],
    ]);
  });

  test("sorts for sweeping but preserves input block order and unchanged blocks", () => {
    const first = block(300),
      second = block(100),
      untouched = block(500);
    first.ranges.reverse();
    const result = refineMetadataRanges(
      [first, second, untouched],
      [span(320, 4), span(120, 4)],
    );
    expect(result.map((b) => b.id)).toEqual([300, 100, 500]);
    expect(result[2]).toBe(untouched);
    partition(result[0]);
    partition(result[1]);
    expect(refineMetadataRanges([untouched], [])).toEqual([untouched]);
  });

  test("rejects checksum, free slots, block tails, segment/data/header and unverified block overlaps", () => {
    for (const [offset, size] of [
      [100, 2],
      [106, 4],
      [154, 4],
      [160, 4],
      [192, 8],
    ]) {
      expect(() =>
        refineMetadataRanges([block()], [span(offset, size)]),
      ).toThrow(/protected/);
    }
    for (const kind of [
      "segment",
      "validity",
      "dictionary",
      "header",
    ] as const) {
      const original = block();
      original.ranges[1].kind = kind;
      expect(() => refineMetadataRanges([original], [span(120, 4)])).toThrow(
        /protected/,
      );
    }
    for (const role of [
      "free",
      "data",
      "header",
      "index",
      "unknown",
    ] as const) {
      const original = block();
      original.role = role;
      expect(() => refineMetadataRanges([original], [span(120, 4)])).toThrow(
        /non-metadata/,
      );
    }
    const unverified = block();
    delete unverified.checksum;
    expect(() => refineMetadataRanges([unverified], [span(120, 4)])).toThrow(
      /unverified/,
    );
  });

  test("rejects invalid spans and corrupt existing partitions without mutating inputs", () => {
    for (const bad of [
      span(99, 4),
      span(198, 4),
      span(120, 0),
      span(120, -1),
      span(NaN, 4),
      span(120, Infinity),
      span(120.5, 4),
      span(Number.MAX_SAFE_INTEGER, 4),
      { ...span(120, 4), kind: "unknown" as const },
    ]) {
      const original = block();
      const before = structuredClone(original);
      expect(() => refineMetadataRanges([original], [bad])).toThrow(/Corrupt/);
      expect(original).toEqual(before);
    }
    for (const change of [
      (b: FileBlock) => {
        b.ranges[1].offset++;
      },
      (b: FileBlock) => {
        b.ranges[1].size++;
      },
      (b: FileBlock) => {
        b.ranges.pop();
      },
      (b: FileBlock) => {
        b.size = Number.MAX_SAFE_INTEGER;
      },
    ]) {
      const original = block();
      change(original);
      expect(() => refineMetadataRanges([original], [])).toThrow(/Corrupt/);
    }
    expect(() => refineMetadataRanges([block(), block(150)], [])).toThrow(
      /overlapping blocks/,
    );
    expect(() => refineMetadataRanges([], [span(120, 4)])).toThrow(/outside/);
  });

  test("sweeps 50,000 shared observations over 64 slot partitions", () => {
    const original: FileBlock = {
      ...block(0),
      size: 8 + 64 * 128,
      usedBytes: 64 * 128,
      ranges: [
        range(0, 8, "checksum"),
        ...Array.from({ length: 64 }, (_, i) => range(8 + i * 128, 128)),
      ],
    };
    const spans = Array.from({ length: 50000 }, (_, i) =>
      span(16 + (i % 64) * 128, 16, "Column", `rg-${i}`),
    );
    const result = refineMetadataRanges([original], spans)[0];
    partition(result);
    expect(labelled(result)).toHaveLength(64);
    expect(
      labelled(result).reduce(
        (sum, r) => sum + (r.metadataOwners?.length ?? 0),
        0,
      ),
    ).toBe(50000);
    expect(result.usedBytes).toBe(original.usedBytes);
    expect(labelled(result).reduce((sum, r) => sum + r.size, 0)).toBe(64 * 16);
  });
});
