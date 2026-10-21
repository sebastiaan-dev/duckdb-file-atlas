#!/usr/bin/env python3
"""Generate closed, checkpointed Atlas exercises using only Python's stdlib."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SOURCE_PIN = "fb38af476a7d07408df3e1f943dd2eb3cd426ff0"
HERE = Path(__file__).resolve().parent
WAL_SUFFIXES = (".wal", ".wal.checkpoint", ".wal.recovery")


def default_duckdb():
    for build in ("reldebug", "release"):
        candidate = Path.home() / "repos/duckdb/build" / build / "duckdb"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return "duckdb"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def assert_no_wal(database):
    for suffix in WAL_SUFFIXES:
        wal = Path(str(database) + suffix)
        if wal.exists() and wal.stat().st_size:
            raise RuntimeError(f"Refusing snapshot with nonempty WAL: {wal}")


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def source_provenance(binary):
    # Only inspect an adjacent checkout, never infer source identity from --version.
    root = binary.parent.parent.parent
    if not (root / ".git").exists():
        return {"checkout": None, "note": "No adjacent source checkout found."}
    if shutil.which("git") is None:
        return {"checkout": str(root), "note": "Git unavailable; source state not inspected."}
    result = {"checkout": str(root)}
    for key, args in (("head", ["rev-parse", "HEAD"]),
                      ("status_porcelain", ["status", "--porcelain"])):
        run = subprocess.run(["git", "-C", str(root), *args],
                             capture_output=True, text=True, check=True)
        result[key] = run.stdout.strip()
    result["head_matches_reference"] = result["head"] == SOURCE_PIN
    result["note"] = "Adjacent source state is not proof of this executable's build inputs."
    return result


def run_logged(command, prefix, sql=None):
    if sql is not None:
        prefix.with_suffix(".sql").write_text(sql, encoding="utf-8")
    prefix.with_suffix(".command.json").write_text(
        json.dumps(command, indent=2) + "\n", encoding="utf-8")
    # Stream to files, keeping complete output even on failure or interruption.
    with prefix.with_suffix(".stdout.log").open("w") as stdout, \
            prefix.with_suffix(".stderr.log").open("w") as stderr:
        run = subprocess.run(command, input=sql, text=True, stdout=stdout,
                             stderr=stderr, timeout=120)
    if run.returncode:
        raise RuntimeError(f"CLI exited {run.returncode}; see {prefix}.stderr.log")


def generate(args):
    found = shutil.which(args.duckdb)
    if found is None:
        raise RuntimeError(f"DuckDB executable not found: {args.duckdb}")
    binary = Path(found).resolve()
    # mkdir without exist_ok: even an empty directory or symlink is refused.
    out = Path(args.out).absolute()
    out.mkdir(parents=True, exist_ok=False)
    logs = out / "logs"
    logs.mkdir()
    work = out / "working"
    work.mkdir()
    snapshots = out / "snapshots"
    snapshots.mkdir()
    manifest = {
        "complete": False,
        "source_reference": SOURCE_PIN,
        "duckdb": str(binary),
        "snapshots": [],
        "storage_version_requested": "v2.0.0",
        "note": "No performance comparison. See SQL/logs for actual settings and codecs.",
    }

    def save():
        (out / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    save()
    try:
        run_logged([str(binary), "-init", os.devnull, "--version"], logs / "version")
        manifest["cli_version_stdout"] = (logs / "version.stdout.log").read_text()
        manifest["cli_version_stderr"] = (logs / "version.stderr.log").read_text()
        manifest["binary_sha256"] = digest(binary)
        manifest["adjacent_source"] = source_provenance(binary)
        save()
        print(manifest["cli_version_stdout"].strip(), flush=True)
        phases = [
            ("01-sorted", "01-sorted", 300000),
            ("01-shuffled", "01-shuffled", 300000),
            ("02-bulk", "02-bulk", 300000),
            ("02-append", "02-append", 300000),
            ("03-baseline", "03-churn", 300000),
            ("03-deleted", "03-churn", 132840),
            ("03-refilled", "03-churn", 282840),
        ]
        if args.overflow:
            phases += [("03-overflow-uncompressed", "03-overflow-uncompressed", 1500),
                       ("03-overflow-zstd", "03-overflow-zstd", 1500)]
        for name, working_name, rows in phases:
            database = work / f"{working_name}.duckdb"
            body = (HERE / f"{name}.sql").read_text(encoding="utf-8")
            sql = f"""-- Generated wrapper: explicit storage version and single-thread execution.
ATTACH {sql_string(database)} AS demo (STORAGE_VERSION 'v2.0.0');
USE demo;
SET threads = 1;
SET preserve_insertion_order = true;
SET memory_limit = '512MB';
SET checkpoint_threshold = '1GB';
SET force_compression = 'auto';
{body}
-- Fail the CLI rather than silently recording unexpected logical results.
SELECT CASE WHEN count(*) = {rows} THEN 'row count OK'
            ELSE error('Unexpected live row count') END AS assertion FROM t;
{(HERE / 'inspect.sql').read_text(encoding='utf-8')}
CHECKPOINT;
"""
            # Ignore ~/.duckdbrc; no shell interpolation or extension downloads.
            run_logged([str(binary), "-init", os.devnull, "-batch", "-bail",
                        "-echo", "-csv", ":memory:"], logs / name, sql)
            # subprocess.run has waited for close. Never copy a live connection.
            assert_no_wal(database)
            if database.stat().st_size < 12288:
                raise RuntimeError(f"Database is unexpectedly small: {database}")
            snapshot = snapshots / f"{name}.duckdb"
            with database.open("rb") as source, snapshot.open("xb") as target:
                shutil.copyfileobj(source, target)
            assert_no_wal(database)
            assert_no_wal(snapshot)
            # Reopen the standalone copy read-only: no WAL or source DB required.
            verify_sql = (
                f"SELECT CASE WHEN count(*) = {rows} THEN 'snapshot OK' "
                "ELSE error('Unexpected snapshot row count') END FROM t;\n"
            )
            run_logged([str(binary), "-init", os.devnull, "-batch", "-bail",
                        "-readonly", "-csv", str(snapshot)],
                       logs / f"{name}-verify", verify_sql)
            assert_no_wal(snapshot)
            manifest["snapshots"].append({
                "file": str(snapshot.relative_to(out)),
                "bytes": snapshot.stat().st_size,
                "sha256": digest(snapshot),
                "live_rows": rows,
                "nonempty_wal_absent": True,
                "read_only_reopen": "passed",
                "sql": f"logs/{name}.sql",
                "inspection": f"logs/{name}.stdout.log",
            })
            save()
            print(f"{name}: {rows:,} rows; {snapshot.stat().st_size:,} bytes", flush=True)
        manifest["complete"] = True
        save()
        print(f"Open the files in {snapshots} in Atlas.")
    except BaseException as exc:
        manifest["error"] = f"{type(exc).__name__}: {exc}"
        save()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duckdb", default=default_duckdb(),
                        help="CLI executable (default: ~/repos/duckdb/build/reldebug/duckdb, "
                             "then release/duckdb, then duckdb on PATH)")
    parser.add_argument("--out", required=True, help="NEW output directory; never overwritten")
    parser.add_argument("--overflow", action="store_true",
                        help="also generate the separate forced Uncompressed/ZSTD string pair")
    args = parser.parse_args()
    try:
        generate(args)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"Generation failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
