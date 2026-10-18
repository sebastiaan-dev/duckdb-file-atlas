import { describe, expect, test } from 'bun:test';
import { applyManifest } from '../src/lib/semantic';
import type { FileInspection, SemanticManifest, Segment } from '../src/lib/types';

const fingerprint = 'a'.repeat(64);

function makeInspection(): FileInspection {
  return {
    name: 'sample.duckdb',
    fileSize: 16_384,
    storageVersion: 69,
    headerFingerprint: fingerprint,
    blockSize: 4096,
    blockHeaderSize: 8,
    vectorSize: 2048,
    libraryVersion: 'DuckDB v2.0.0',
    activeHeader: 2,
    headers: [],
    blocks: [
      { id: -3, offset: 0, size: 4096, role: 'header', label: 'Main header', usedBytes: null, ranges: [], segmentIds: [], links: [] },
      { id: -2, offset: 4096, size: 4096, role: 'header', label: 'Checkpoint header 1', usedBytes: null, ranges: [], segmentIds: [], links: [] },
      { id: -1, offset: 8192, size: 4096, role: 'header', label: 'Checkpoint header 2', usedBytes: null, ranges: [], segmentIds: [], links: [] },
      {
        id: 0, offset: 12_288, size: 4096, role: 'unknown', label: 'Unknown block 0', usedBytes: null,
        ranges: [{ id: 'unknown-0', label: 'Unclassified bytes', offset: 12_288, size: 4096, kind: 'unknown' }],
        segmentIds: [], links: [],
      },
      { id: 1, offset: 12_288 + 4096, size: 0, role: 'unknown', label: 'Empty block 1', usedBytes: null, ranges: [], segmentIds: [], links: [] },
    ],
    segments: [],
    warnings: [],
    capabilities: { semantic: false, exactSizes: false, checksums: true },
  };
}

function makeSegment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: '42:0:0:0', table: 'main.items', column: 'id', columnType: 'BIGINT', rowGroup: 0,
    blockId: 0, offset: 8, byteSize: 100, rowStart: 0, rowCount: 1000,
    compression: 'BitPacking', ...overrides,
  };
}

function makeManifest(segments: Segment[] = [makeSegment()], overrides: Partial<SemanticManifest> = {}): SemanticManifest {
  return {
    format: 'duckdb-file-layout/v1', storageVersion: 69, fileSize: 16_384,
    headerFingerprint: fingerprint, fileName: 'sample.duckdb', segments, ...overrides,
  };
}

describe('applyManifest', () => {
  test('attaches row metadata to verified data blocks and draws only exact byte ranges', () => {
    const inspection = makeInspection();
    const enriched = applyManifest(inspection, makeManifest());
    const dataBlock = enriched.blocks.find((block) => block.id === 0)!;

    expect(enriched.capabilities.semantic).toBe(true);
    expect(enriched.segments).toHaveLength(1);
    expect(dataBlock.role).toBe('data');
    expect(dataBlock.segmentIds).toEqual(['42:0:0:0']);
    expect(dataBlock.ranges).toEqual([
      { id: 'unknown-0:part-1', label: 'Unclassified bytes', offset: 12_288, size: 8, kind: 'unknown' },
      { id: 'unknown-0:part-2', label: 'Unclassified bytes', offset: 12_396, size: 3988, kind: 'unknown' },
      {
        id: 'semantic:42:0:0:0', label: 'main.items.id · BitPacking', offset: 12_296, size: 100,
        kind: 'segment', segmentId: '42:0:0:0',
      },
    ]);
    expect(enriched.blocks.find((block) => block.id === -3)?.role).toBe('header');
    expect(inspection.blocks.find((block) => block.id === 0)?.role).toBe('unknown');
    expect(inspection.blocks.find((block) => block.id === 0)?.ranges).toHaveLength(1);
  });

  test('keeps unknown segment extents unpainted when byteSize is unavailable', () => {
    const enriched = applyManifest(makeInspection(), makeManifest([makeSegment({ byteSize: null })]));
    const block = enriched.blocks.find((item) => item.id === 0)!;
    expect(block.role).toBe('data');
    expect(block.segmentIds).toEqual(['42:0:0:0']);
    expect(block.ranges.map((range) => range.kind)).toEqual(['unknown']);
    expect(enriched.capabilities.exactSizes).toBe(false);
  });

  test('reapplying a sidecar removes stale semantic links and restores unknown coverage', () => {
    const first = applyManifest(makeInspection(), makeManifest());
    const secondSegment = makeSegment({ id: '42:0:0:1', offset: 208, byteSize: 80 });
    const second = applyManifest(first, makeManifest([secondSegment]));
    const block = second.blocks.find((item) => item.id === 0)!;

    expect(block.segmentIds).toEqual(['42:0:0:1']);
    expect(block.ranges.filter((range) => range.kind === 'segment')).toHaveLength(1);
    expect(block.ranges.reduce((sum, range) => sum + range.size, 0)).toBe(4096);
    expect(second.segments.map((segment) => segment.id)).toEqual(['42:0:0:1']);
  });

  test('replacement restores extents at both edges and an entirely covered unknown range', () => {
    for (const [offset, byteSize] of [[8, 100], [3996, 100], [8, 4088]]) {
      const base = makeInspection();
      base.blocks[3].ranges = [
        { id: 'checksum', label: 'Checksum', offset: 12288, size: 8, kind: 'checksum' },
        { id: 'body', label: 'Unknown body', offset: 12296, size: 4088, kind: 'unknown' },
      ];
      const first = applyManifest(base, makeManifest([makeSegment({ offset, byteSize })]));
      const cleared = applyManifest(first, makeManifest([]));
      const block = cleared.blocks.find((item) => item.id === 0)!;
      expect(block.ranges.reduce((sum, range) => sum + range.size, 0)).toBe(4096);
      expect(block.ranges.find((range) => range.kind === 'unknown')).toMatchObject({ offset: 12296, size: 4088 });
      expect(block.segmentIds).toEqual([]);
    }
  });

  test('requires matching format, storage version, size, and header fingerprint', () => {
    expect(() => applyManifest(makeInspection(), { ...makeManifest(), format: 'other/v1' })).toThrow(/format/);
    expect(() => applyManifest(makeInspection(), makeManifest([], { storageVersion: 68 }))).toThrow(/storageVersion/);
    expect(() => applyManifest(makeInspection(), makeManifest([], { fileSize: 16_383 }))).toThrow(/fileSize/);
    expect(() => applyManifest(makeInspection(), makeManifest([], { headerFingerprint: 'b'.repeat(64) }))).toThrow(/headerFingerprint/);
  });

  test('rejects malformed arrays, unknown fields, duplicate IDs, and unsafe pointers', () => {
    expect(() => applyManifest(makeInspection(), { ...makeManifest(), segments: {} })).toThrow(/segments/);
    expect(() => applyManifest(makeInspection(), { ...makeManifest(), extra: true })).toThrow(/unknown field/);
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment(), makeSegment()]))).toThrow(/duplicate segment ID/);
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment({ blockId: 99 })]))).toThrow(/does not refer to a block/);
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment({ blockId: -1 })]))).toThrow(/safe integer/);
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment({ offset: 0 })]))).toThrow(/block header/);
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment({ offset: 4096 })]))).toThrow(/inside the referenced block/);
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment({ byteSize: 4096 })]))).toThrow(/extends beyond/);
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment({ rowCount: Number.MAX_SAFE_INTEGER, rowStart: 1 })]))).toThrow(/safe integer range/);
  });

  test('rejects overlapping exact extents and extents that collide with known physical ranges', () => {
    const overlapping = makeSegment({ id: '42:0:0:1', offset: 80, byteSize: 40 });
    expect(() => applyManifest(makeInspection(), makeManifest([makeSegment(), overlapping]))).toThrow(/overlaps another segment/);

    const inspection = makeInspection();
    inspection.blocks[3].ranges.push({ id: 'checksum', label: 'Checksum', offset: 12_296, size: 8, kind: 'checksum' });
    expect(() => applyManifest(inspection, makeManifest())).toThrow(/overlaps a known physical range/);
  });
});
