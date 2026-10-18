import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFile, inspectPhysicalFile, readBytes } from "../src/lib/reader";
import { applyManifest } from "../src/lib/semantic";
import { collectManifest } from "../scripts/inspect";
import { buildLogicalMetrics } from "../src/lib/logical-colors";

const duckdb = process.env.DUCKDB_BIN;
const native = duckdb ? describe : describe.skip;

/** Run against a source-built revision-69 engine rather than a mirrored TS fixture writer. */
native("native DuckDB revision 69 integration", () => {
  test("reads a real checkpoint, enriches quoted catalog names, and preserves the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-native-"));
    const path = join(directory, "real.duckdb");
    try {
      const sql = `CREATE TABLE discarded AS SELECT hash(i) AS payload FROM range(300000) t(i);
        CREATE SCHEMA "analytics's";
        CREATE TABLE "analytics's"."order's events" AS
        SELECT i AS "event id", 'event-' || (i % 4096)::VARCHAR AS category,
               CASE WHEN i % 7 = 0 THEN NULL ELSE i * 0.25 END AS amount
        FROM range(250000) t(i);
        CHECKPOINT; DROP TABLE discarded; CHECKPOINT;`;
      const create = Bun.spawn([duckdb!, path, "-batch", "-c", sql], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const diagnostic = await new Response(create.stderr).text();
      expect(await create.exited, diagnostic).toBe(0);
      const before = await Bun.file(path).arrayBuffer();
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.storageVersion).toBe(69);
      expect(inspection.native, inspection.warnings.join("\n")).toBeDefined();
      expect(
        inspection.segments.some(
          (segment) => segment.blockId >= 0 && segment.byteSize != null,
        ),
      ).toBe(true);
      expect(inspection.headers.filter((header) => header.valid).length).toBe(
        2,
      );
      expect(inspection.blocks.some((block) => block.role === "metadata")).toBe(
        true,
      );
      expect(inspection.blocks.some((block) => block.role === "free")).toBe(
        true,
      );
      expect(inspection.blocks.filter((block) => block.id < 0).length).toBe(3);
      expect(
        inspection.blocks.reduce((sum, block) => sum + block.size, 0),
      ).toBe(before.byteLength);
      expect(inspection.headerFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const sample = await readBytes(Bun.file(path) as unknown as File, 8, 4);
      expect(new TextDecoder().decode(sample)).toBe("DUCK");

      const exporter = Bun.spawn(
        [process.execPath, "scripts/inspect.ts", "--duckdb", duckdb!, path],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(exporter.stdout).text(),
        new Response(exporter.stderr).text(),
      ]);
      expect(await exporter.exited, stderr).toBe(0);
      const manifest = JSON.parse(stdout);
      const enriched = applyManifest(
        await inspectPhysicalFile(Bun.file(path) as unknown as File),
        manifest,
      );
      expect(enriched.capabilities.semantic).toBe(true);
      expect(
        enriched.segments.some((segment) =>
          segment.table.includes("order's events"),
        ),
      ).toBe(true);
      expect(
        enriched.segments.some((segment) =>
          segment.column.includes("event id"),
        ),
      ).toBe(true);
      expect(
        new Set(enriched.segments.map((segment) => segment.rowGroup)).size,
      ).toBeGreaterThan(1);
      expect(
        enriched.segments.every((segment) => segment.byteSize === null),
      ).toBe(true);
      expect(enriched.capabilities.exactSizes).toBe(false);
      expect(await Bun.file(path).arrayBuffer()).toEqual(before);
      for (const suffix of [".wal", ".wal.checkpoint", ".wal.recovery"]) {
        await Bun.write(path + suffix, "uncheckpointed changes");
        await expect(collectManifest(path, duckdb!)).rejects.toThrow(
          /Unresolved WAL/,
        );
        await rm(path + suffix);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  test("reads a revision-69 upgrade with a legacy main marker and 16 KiB blocks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-upgrade-"));
    const path = join(directory, "upgraded.duckdb");
    const literal = "'" + path.replaceAll("'", "''") + "'";
    try {
      const sql = `SET force_compression='uncompressed';
        ATTACH ${literal} AS old (STORAGE_VERSION 'v1.2.0', BLOCK_SIZE 16384);
        CREATE TABLE old.t AS SELECT i FROM range(10000) t(i); CHECKPOINT old; DETACH old;
        ATTACH ${literal} AS upgraded (STORAGE_VERSION 'v2.0.0');
        CREATE TABLE upgraded.t2 AS SELECT i FROM range(100) t(i); CHECKPOINT upgraded;`;
      const child = Bun.spawn([duckdb!, "-no-agent", "-batch", "-c", sql], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const file = Bun.file(path) as unknown as File;
      const prefix = await readBytes(file, 0, 20);
      expect(new DataView(prefix.buffer).getBigUint64(12, true)).toBe(65n);
      const inspection = await inspectFile(file);
      expect(inspection.storageVersion).toBe(69);
      expect(inspection.blockSize).toBe(16384);
      expect(inspection.native?.complete, inspection.warnings.join("\n")).toBe(
        true,
      );
      expect(inspection.capabilities.semantic).toBe(true);
      expect(inspection.capabilities.exactSizes).toBe(false);
      expect(
        inspection.native?.catalog?.map(({ name, rows }) => ({ name, rows })),
      ).toEqual([
        { name: "main.t", rows: 10000 },
        { name: "main.t2", rows: 100 },
      ]);
      const retained = inspection.segments.filter(
        (segment) => segment.table === "main.t" && segment.column === "i",
      );
      expect(retained.length).toBeGreaterThan(1);
      let rowStart = 0;
      for (const segment of retained) {
        expect(segment.rowStart).toBe(rowStart);
        expect(segment.min).toBe(String(rowStart));
        rowStart += segment.rowCount;
        expect(segment.max).toBe(String(rowStart - 1));
        // Old streams do not record field 106; do not invent exact sizes.
        expect(segment.byteSize).toBeNull();
      }
      expect(rowStart).toBe(10000);
      const added = inspection.segments.filter(
        (segment) => segment.table === "main.t2" && segment.column === "i",
      );
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        rowStart: 0,
        rowCount: 100,
        min: "0",
        max: "99",
        byteSize: 800,
      });
      expect(inspection.blocks.some((block) => block.role === "metadata")).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});

native("native checkpoint semantics and allocation sizes", () => {
  for (const version of ["v1.2.0", "v1.5.0"]) {
    test(`reads retained ${version} VARCHAR bounds after upgrading to revision 69`, async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "file-atlas-string-upgrade-"),
      );
      const path = join(directory, "strings.duckdb");
      const literal = "'" + path.replaceAll("'", "''") + "'";
      try {
        const sql = `SET force_compression='uncompressed';
          ATTACH ${literal} AS old (STORAGE_VERSION '${version}', BLOCK_SIZE 16384);
          CREATE TABLE old.strings AS SELECT printf('%04d', i) AS short_text,
            'prefix-' || printf('%08d', i) AS long_text FROM range(1000) t(i);
          CHECKPOINT old; DETACH old;
          ATTACH ${literal} AS upgraded (STORAGE_VERSION 'v2.0.0');
          CREATE TABLE upgraded.fresh AS SELECT i FROM range(100) t(i); CHECKPOINT upgraded;`;
        const child = Bun.spawn([duckdb!, "-no-agent", "-batch", "-c", sql], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = await new Response(child.stderr).text();
        expect(await child.exited, stderr).toBe(0);
        const inspection = await inspectFile(Bun.file(path) as unknown as File);
        expect(inspection.storageVersion).toBe(69);
        expect(
          inspection.native?.complete,
          inspection.warnings.join("\n"),
        ).toBe(true);
        expect(inspection.capabilities.semantic).toBe(true);
        expect(inspection.capabilities.exactSizes).toBe(false);
        expect(
          inspection.native?.catalog?.find(
            (table) => table.name === "main.strings",
          )?.rows,
        ).toBe(1000);
        for (const column of ["short_text", "long_text"]) {
          const segments = inspection.segments.filter(
            (segment) => segment.column === column,
          );
          expect(segments.length).toBeGreaterThan(0);
          let rowStart = 0;
          for (const segment of segments) {
            expect(segment.rowStart).toBe(rowStart);
            expect(segment.byteSize).toBeNull();
            rowStart += segment.rowCount;
            const short = column === "short_text";
            expect(segment.min).toBe(
              short ? String(segment.rowStart).padStart(4, "0") : "prefix-0",
            );
            expect(segment.max).toBe(
              short ? String(rowStart - 1).padStart(4, "0") : "prefix-0",
            );
            expect(JSON.parse(segment.stats!).string).toEqual({
              minExact: short,
              maxExact: short,
              maxLength: short ? 4 : 15,
            });
          }
          expect(rowStart).toBe(1000);
        }
        expect(
          inspection.segments.find(
            (segment) =>
              segment.table === "main.fresh" && segment.column === "i",
          ),
        ).toMatchObject({ rowCount: 100, byteSize: 800 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60000);
  }

  test("preserves temporal infinity bounds and excludes them from value-range colors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-infinity-"));
    const path = join(directory, "infinity.duckdb");
    try {
      const types = [
        "DATE",
        "TIMESTAMP",
        "TIMESTAMP_S",
        "TIMESTAMP_MS",
        "TIMESTAMP_NS",
        "TIMESTAMPTZ",
      ];
      const projection = types
        .map((type, index) => `v::${type} AS c${index}`)
        .join(", ");
      const sql = `SET force_compression='uncompressed';
        CREATE TABLE both_bounds AS SELECT ${projection} FROM (VALUES ('-infinity'), ('infinity')) t(v);
        CREATE TABLE negative_bound AS SELECT ${projection} FROM (VALUES ('-infinity'), ('2026-01-01')) t(v);
        CREATE TABLE positive_bound AS SELECT ${projection} FROM (VALUES ('2026-01-01'), ('infinity')) t(v);
        CHECKPOINT;`;
      const child = Bun.spawn(
        [duckdb!, path, "-no-agent", "-batch", "-c", sql],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.native?.complete, inspection.warnings.join("\n")).toBe(
        true,
      );
      const values = inspection.segments.filter(
        (segment) => segment.columnType !== "VALIDITY",
      );
      expect(values).toHaveLength(types.length * 3);
      for (const segment of values) {
        const stats = JSON.parse(segment.stats!);
        if (segment.table !== "main.positive_bound") {
          expect(segment.min).toBe("-infinity");
          expect(stats.min).toBe("-infinity");
        }
        if (segment.table !== "main.negative_bound") {
          expect(segment.max).toBe("infinity");
          expect(stats.max).toBe("infinity");
        }
      }
      expect(buildLogicalMetrics(inspection.segments).valueColumns).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

  test("reads nested columns, indexes and string overflow without a manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-nested-"));
    const path = join(directory, "nested.duckdb");
    try {
      const sql = `CREATE TABLE nested AS SELECT i::INTEGER AS id, {'a':i,'b':i::VARCHAR} AS obj,
          [i,i+1] AS xs, [i,i+1]::BIGINT[2] AS arr, map(['k'],[i]) AS m FROM range(3000) t(i);
        CREATE INDEX nested_idx ON nested(id);
        SET force_compression='uncompressed';
        CREATE TABLE strings AS SELECT repeat(md5(i::VARCHAR),500) AS txt FROM range(40) t(i);
        CREATE TABLE fixed AS SELECT (i%1024)::INTEGER AS n FROM range(10000) t(i);
        CREATE TABLE empty_table(a INTEGER, b VARCHAR);
        CHECKPOINT;`;
      const child = Bun.spawn(
        [duckdb!, path, "-no-agent", "-batch", "-c", sql],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.native, inspection.warnings.join("\n")).toBeDefined();
      expect(inspection.native?.tables).toBe(4);
      expect(
        inspection.segments.some((segment) => segment.column === "xs.element"),
      ).toBe(true);
      expect(
        inspection.segments.some((segment) => segment.auxiliaryBlocks?.length),
      ).toBe(true);
      expect(inspection.blocks.some((block) => block.role === "index")).toBe(
        true,
      );
      expect(
        inspection.segments
          .filter(
            (segment) =>
              segment.table === "main.fixed" && segment.column === "n",
          )
          .reduce((sum, segment) => sum + (segment.byteSize ?? 0), 0),
      ).toBe(40000);
      for (const block of inspection.blocks.filter(
        (block) => block.role === "data" && block.usedBytes != null,
      )) {
        expect(block.ranges.reduce((sum, range) => sum + range.size, 0)).toBe(
          block.size,
        );
        expect(
          block.usedBytes! +
            block.ranges
              .filter((range) => range.kind === "unused")
              .reduce((sum, range) => sum + range.size, 0),
        ).toBe(block.size);
      }
      const list = inspection.segments.find(
        (segment) => segment.column === "xs.element",
      );
      expect(list?.rowCount).toBe(6000);
      expect(list?.rowGroupRowCount).toBe(3000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});

native("native catalog expressions and identifier identity", () => {
  test("reads simple views, scalar macros and generated columns without merging quoted names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-catalog-"));
    const path = join(directory, "catalog.duckdb");
    try {
      const sql = `CREATE SCHEMA "a.b"; CREATE SCHEMA a;
        CREATE TABLE "a.b".c(id INTEGER PRIMARY KEY, "x.validity" INTEGER, x INTEGER DEFAULT 4,
          generated INTEGER GENERATED ALWAYS AS (x+1), CHECK(x>0));
        INSERT INTO "a.b".c VALUES (1,9,2),(2,10,3);
        CREATE TABLE a."b.c" AS SELECT i::DOUBLE AS d, i%2=0 AS b, i::FLOAT AS f,
          CURRENT_TIMESTAMP AS ts, TIME '12:30:00' AS tm, INTERVAL '2 days' AS iv,
          union_value(n:=i) AS u FROM range(1000) t(i);
        CREATE VIEW vv AS SELECT id FROM "a.b".c ORDER BY id LIMIT 2;
        CREATE MACRO inc(v) AS v+1; CHECKPOINT;`;
      const child = Bun.spawn(
        [duckdb!, path, "-no-agent", "-batch", "-c", sql],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.native, inspection.warnings.join("\n")).toBeDefined();
      expect(
        inspection.native!.catalog!.map((table) => table.name).sort(),
      ).toEqual(['"a.b".c', 'a."b.c"']);
      expect(
        inspection.native!.catalog!.find((table) => table.name === '"a.b".c')!
          .columns,
      ).toHaveLength(3);
      expect(
        new Set(inspection.segments.map((segment) => segment.id)).size,
      ).toBe(inspection.segments.length);
      const columns = new Set(
        inspection.segments.map((segment) => segment.column),
      );
      expect(columns.has('"x.validity"')).toBe(true);
      expect(columns.has("x.validity")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});

native("rewritten checkpoints", () => {
  test("reads reused column metadata whose old stream tail has been freed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "file-atlas-rewrite-"));
    const path = join(directory, "rewritten.duckdb");
    try {
      const sql = `ATTACH '${path.replaceAll("'", "''")}' AS edited (STORAGE_VERSION 'v2.0.0', BLOCK_SIZE 16384);
        USE edited;
        CREATE TABLE t AS SELECT i AS id, 'payload-' || (i % 20000)::VARCHAR AS label,
          (i % 101)::INTEGER AS score, DATE '2026-01-01' + (i % 365)::INTEGER AS day,
          i * 10 AS untouched, (i % 201)::INTEGER AS category FROM range(400000) r(i);
        CHECKPOINT;
        UPDATE t SET score = NULL WHERE id % 19 = 0;
        UPDATE t SET day = NULL WHERE id % 31 = 0;
        CREATE UNIQUE INDEX by_id ON t(id);
        CREATE INDEX by_category ON t(category);
        CHECKPOINT;`;
      const process = Bun.spawn(
        [duckdb!, "--batch", "--bail", "--no-init", "--no-agent", "-c", sql],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(process.stderr).text();
      expect(await process.exited, stderr).toBe(0);
      const inspection = await inspectFile(Bun.file(path) as unknown as File);
      expect(inspection.native?.complete, inspection.warnings.join("\n")).toBe(
        true,
      );
      expect(inspection.native?.catalog?.[0].rows).toBe(400000);
      expect(inspection.blocks.some((block) => block.role === "index")).toBe(
        true,
      );
      const validity = inspection.segments.filter(
        (segment) => segment.columnType === "VALIDITY" && segment.blockId >= 0,
      );
      expect(new Set(validity.map((segment) => segment.column))).toEqual(
        new Set(["score.validity", "day.validity"]),
      );
      expect(
        validity.every(
          (segment) => segment.byteSize != null && segment.byteSize > 0,
        ),
      ).toBe(true);
      expect(
        inspection.segments.some((segment) => segment.column === "untouched"),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
