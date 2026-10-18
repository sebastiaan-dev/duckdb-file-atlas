import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { inspectFile } from "../src/lib/reader";

// Colon-separated CLI paths on Unix, semicolon-separated on Windows. Each
// executable writes its own real files: defaults plus explicit supported
// storage targets. No mirrored TypeScript serializer is used in this test.
const bins = (process.env.DUCKDB_COMPAT_BINS ?? "")
  .split(delimiter)
  .filter(Boolean);
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
async function sql(bin: string, path: string, query: string, readonly = false) {
  const process = Bun.spawn(
    [
      bin,
      ...(readonly ? ["-readonly"] : []),
      path,
      "-batch",
      "-json",
      "-c",
      query,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`${bin}: ${err}`);
  return out.trim() && /^(SELECT|PRAGMA)\b/i.test(query.trim())
    ? JSON.parse(out)
    : [];
}

const workload = `
CREATE SCHEMA "odd.schema";
CREATE TABLE "odd.schema"."t.name" AS SELECT
  i::INTEGER AS id, i % 2 = 0 AS flag, (i % 100)::TINYINT AS tiny,
  i::BIGINT * 1000003 AS big, i::HUGEINT * 1000000000000 AS huge,
  (i / 7)::DECIMAL(18,3) AS dec, (i / 3.0)::DOUBLE AS dbl,
  DATE '2020-01-01' + (i % 3650)::INTEGER AS d,
  TIMESTAMP '2020-01-01' + INTERVAL (i) MINUTE AS ts, INTERVAL (i) DAY AS iv,
  CASE WHEN i % 5 = 0 THEN NULL ELSE 'short-' || (i % 50) END AS s,
  repeat('long string payload ', 30) || i AS long_s,
  [i, i + 1, i + 2] AS lst, {'a': i, 'b': 'x' || i} AS st
FROM range(20000) t(i);
CREATE TABLE main."t.name" AS SELECT i, 'value-' || i AS payload FROM range(10000) t(i);
CREATE VIEW "odd.schema".v AS SELECT id, s FROM "odd.schema"."t.name" WHERE flag;
CREATE SEQUENCE "odd.schema".seq START 10;
CREATE MACRO plus_one(x) AS x + 1;
CREATE INDEX id_idx ON "odd.schema"."t.name"(id);
CHECKPOINT;
DELETE FROM "odd.schema"."t.name" WHERE id % 3 = 0;
UPDATE "odd.schema"."t.name" SET s = 'updated' WHERE id % 11 = 1;
CHECKPOINT;
`;
const names = ['"odd.schema"."t.name"', 'main."t.name"'];
const key = (v: unknown[]) => JSON.stringify(v);
// Atlas labels physical type families, while pragma_storage_info prints the
// full SQL type (DECIMAL precision, list element types, etc.).
const typeFamily = (name: string) =>
  name.endsWith("[]") ? "LIST" : name.startsWith("DECIMAL(") ? "DECIMAL" : name;

for (const bin of bins.length ? bins : [""]) {
  test.skipIf(!bin)(
    `released storage compatibility: ${bin || "set DUCKDB_COMPAT_BINS"}`,
    async () => {
      const [version] = await sql(bin, ":memory:", "PRAGMA version");
      const match = /^v?(\d+)\.(\d+)/.exec(version.library_version)!;
      const major = Number(match[1]),
        minor = Number(match[2]);
      const targets: [string | null, number][] = [[null, major >= 2 ? 69 : 64]];
      // Explicit STORAGE_VERSION was introduced in 1.2. Earlier CLIs use defaults.
      if (major >= 2 || minor >= 2)
        for (const [target, storage, minimumMinor] of [
          ["v1.0.0", 64, 0],
          ["v1.2.0", 65, 2],
          ["v1.3.0", 66, 3],
          ["v1.4.0", 67, 4],
          ["v1.5.0", 68, 5],
          ["v2.0.0", 69, Infinity],
        ] as const)
          if (major >= 2 || minor >= minimumMinor)
            targets.push([target, storage]);
      const dir = await mkdtemp(join(tmpdir(), "atlas-compat-"));
      try {
        for (const [target, expectedVersion] of targets) {
          const path = join(dir, `${target ?? "default"}.duckdb`);
          if (target) {
            await sql(
              bin,
              ":memory:",
              `ATTACH ${literal(path)} AS db (STORAGE_VERSION ${literal(target)}); USE db; ${workload}`,
            );
          } else await sql(bin, path, workload);
          const before = await Bun.file(path).arrayBuffer();
          const inspection = await inspectFile(
            Bun.file(path) as unknown as File,
          );
          const context = `${version.library_version} / ${target ?? "default"}: ${inspection.warnings.join("\n")}`;
          expect(inspection.native?.complete, context).toBe(true);
          expect(inspection.storageVersion).toBe(expectedVersion);
          expect(inspection.native!.catalog!.map((t) => t.name).sort()).toEqual(
            [...names].sort(),
          );
          for (const name of names) {
            const [{ n }] = await sql(
              bin,
              path,
              `SELECT count(*) AS n FROM ${name}`,
              true,
            );
            expect(
              inspection.native!.catalog!.find((t) => t.name === name)!
                .liveRows,
              context,
            ).toBe(n);
            const storage = await sql(
              bin,
              path,
              `SELECT row_group_id, segment_type, start, count, compression, block_id, block_offset FROM pragma_storage_info(${literal(name)}) WHERE persistent`,
              true,
            );
            // These fields have SQL ground truth, including constants/validity and
            // nested child segments. Missing byte lengths must stay unknown.
            const expected = storage
              .map((r: any) =>
                key([
                  r.row_group_id,
                  typeFamily(r.segment_type),
                  r.start,
                  r.count,
                  r.compression,
                  r.block_id ?? -1,
                  r.block_id >= 0 ? r.block_offset + 8 : 0,
                ]),
              )
              .sort();
            const actual = inspection.segments
              .filter((s) => s.table === name)
              .map((s) =>
                key([
                  s.rowGroup,
                  s.columnType,
                  s.rowStart,
                  s.rowCount,
                  s.compression,
                  s.blockId,
                  s.blockId >= 0 ? s.offset : 0,
                ]),
              )
              .sort();
            expect(actual, context).toEqual(expected);
          }
          if (expectedVersion < 69) {
            expect(
              inspection.segments.some(
                (s) => s.blockId >= 0 && s.byteSize === null,
              ),
            ).toBe(true);
            expect(
              inspection.segments
                .filter((s) => s.blockId < 0)
                .every((s) => s.byteSize === 0),
            ).toBe(true);
          }
          expect(inspection.indexes).toHaveLength(1);
          if (expectedVersion >= 68) {
            expect(inspection.indexes![0].complete, context).toBe(true);
            expect(inspection.indexes![0].occupiedBytes!).toBeGreaterThan(0);
          }
          // Unsupported historical ART layouts remain explicitly unmeasured.
          for (const index of inspection.indexes ?? [])
            if (!index.complete) {
              expect(index.reason).toBeTruthy();
              expect(index.occupiedBytes).toBeNull();
            }
          expect(await Bun.file(path).arrayBuffer()).toEqual(before);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
}
