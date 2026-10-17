import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectFile, readBytes } from '../src/lib/reader';
import { applyManifest } from '../src/lib/semantic';
import { collectManifest } from '../scripts/inspect';

const duckdb = process.env.DUCKDB_BIN;
const native = duckdb ? describe : describe.skip;

/** Run against a source-built revision-69 engine rather than a mirrored TS fixture writer. */
native('native DuckDB revision 69 integration', () => {
  test('reads a real checkpoint, enriches quoted catalog names, and preserves the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'file-atlas-native-'));
    const path = join(directory, 'real.duckdb');
    try {
      const sql = `CREATE TABLE discarded AS SELECT hash(i) AS payload FROM range(300000) t(i);
        CREATE SCHEMA "analytics's";
        CREATE TABLE "analytics's"."order's events" AS
        SELECT i AS "event id", 'event-' || (i % 4096)::VARCHAR AS category,
               CASE WHEN i % 7 = 0 THEN NULL ELSE i * 0.25 END AS amount
        FROM range(250000) t(i);
        CHECKPOINT; DROP TABLE discarded; CHECKPOINT;`;
      const create = Bun.spawn([duckdb!, path, '-batch', '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
      const diagnostic = await new Response(create.stderr).text();
      expect(await create.exited, diagnostic).toBe(0);
      const before = await Bun.file(path).arrayBuffer();
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.storageVersion).toBe(69);
      expect(inspection.headers.filter((header) => header.valid).length).toBe(2);
      expect(inspection.blocks.some((block) => block.role === 'metadata')).toBe(true);
      expect(inspection.blocks.some((block) => block.role === 'free')).toBe(true);
      expect(inspection.blocks.filter((block) => block.id < 0).length).toBe(3);
      expect(inspection.blocks.reduce((sum, block) => sum + block.size, 0)).toBe(before.byteLength);
      expect(inspection.headerFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const sample = await readBytes(Bun.file(path) as unknown as File, 8, 4);
      expect(new TextDecoder().decode(sample)).toBe('DUCK');

      const exporter = Bun.spawn([process.execPath, 'scripts/inspect.ts', '--duckdb', duckdb!, path], {
        cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([new Response(exporter.stdout).text(), new Response(exporter.stderr).text()]);
      expect(await exporter.exited, stderr).toBe(0);
      const manifest = JSON.parse(stdout);
      const enriched = applyManifest(inspection, manifest);
      expect(enriched.capabilities.semantic).toBe(true);
      expect(enriched.segments.some((segment) => segment.table.includes("order's events"))).toBe(true);
      expect(enriched.segments.some((segment) => segment.column === 'event id')).toBe(true);
      expect(new Set(enriched.segments.map((segment) => segment.rowGroup)).size).toBeGreaterThan(1);
      expect(enriched.segments.every((segment) => segment.byteSize === null)).toBe(true);
      expect(enriched.capabilities.exactSizes).toBe(false);
      expect(await Bun.file(path).arrayBuffer()).toEqual(before);
      for (const suffix of ['.wal', '.wal.checkpoint', '.wal.recovery']) {
        await Bun.write(path + suffix, 'uncheckpointed changes');
        await expect(collectManifest(path, duckdb!)).rejects.toThrow(/Unresolved WAL/);
        await rm(path + suffix);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  test('reads a revision-69 upgrade with a legacy main marker and 16 KiB blocks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'file-atlas-upgrade-'));
    const path = join(directory, 'upgraded.duckdb');
    const literal = "'" + path.replaceAll("'", "''") + "'";
    try {
      const sql = `ATTACH ${literal} AS old (STORAGE_VERSION 'v1.2.0', BLOCK_SIZE 16384);
        CREATE TABLE old.t AS SELECT i FROM range(10000) t(i); CHECKPOINT old; DETACH old;
        ATTACH ${literal} AS upgraded (STORAGE_VERSION 'v2.0.0');
        CREATE TABLE upgraded.t2 AS SELECT i FROM range(100) t(i); CHECKPOINT upgraded;`;
      const child = Bun.spawn([duckdb!, '-no-agent', '-batch', '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const file = Bun.file(path) as unknown as File;
      const prefix = await readBytes(file, 0, 20);
      expect(new DataView(prefix.buffer).getBigUint64(12, true)).toBe(65n);
      const inspection = await inspectFile(file);
      expect(inspection.storageVersion).toBe(69);
      expect(inspection.blockSize).toBe(16384);
      expect(inspection.blocks.some((block) => block.role === 'metadata')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

});
