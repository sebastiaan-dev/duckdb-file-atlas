#!/usr/bin/env python3
"""Real CLI integration and generator safety checks; all artifacts are temporary."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import generate


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duckdb", default=generate.default_duckdb())
    args = parser.parse_args()
    script = Path(__file__).with_name("generate.py")
    with tempfile.TemporaryDirectory(prefix="atlas-workshop-test-") as temporary:
        root = Path(temporary)
        out = root / "quoted ' output"
        home = root / "home"
        home.mkdir()
        (home / ".duckdbrc").write_text("SELECT error('User startup file must not run');\n")
        env = dict(os.environ, HOME=str(home))
        command = [sys.executable, str(script), "--duckdb", args.duckdb,
                   "--out", str(out), "--overflow"]
        subprocess.run(command, check=True, env=env)
        manifest_path = out / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        require(manifest["complete"] and len(manifest["snapshots"]) == 9,
                "Expected nine completed snapshots")
        require(manifest["cli_version_stdout"].strip(), "Missing CLI version stdout")
        require(len(manifest["binary_sha256"]) == 64, "Missing executable fingerprint")
        require(manifest["source_reference"] == generate.SOURCE_PIN,
                "Wrong source reference")
        before = generate.digest(manifest_path)
        for item in manifest["snapshots"]:
            database = out / item["file"]
            require(generate.digest(database) == item["sha256"], "Snapshot hash mismatch")
            generate.assert_no_wal(database)
            require(item["read_only_reopen"] == "passed", "Snapshot not verified")
            require((out / item["sql"]).is_file(), "Missing generated SQL")
            require((out / item["inspection"]).stat().st_size > 0, "Missing query output")

        # Compare full multisets, not a lossy checksum. No layout/codec assertions.
        sql = "SET threads=1; SET memory_limit='512MB';\n"
        for index, item in enumerate(manifest["snapshots"]):
            sql += (f"ATTACH {generate.sql_string(out / item['file'])} "
                    f"AS d{index} (READ_ONLY);\n")
            sql += (f"SELECT CASE WHEN bool_and(persistent) THEN 'persistent OK' "
                    "ELSE error('Transient segment in snapshot') END "
                    f"FROM pragma_storage_info('d{index}.t');\n")

        def compare(left, right):
            return (
                "SELECT CASE WHEN count(*) = 0 THEN 'multiset OK' "
                "ELSE error('Multiset mismatch') END FROM ("
                f"(({left}) EXCEPT ALL ({right})) UNION ALL "
                f"(({right}) EXCEPT ALL ({left})));\n"
            )

        sql += compare("SELECT * FROM d0.t", "SELECT * FROM d1.t")
        sql += compare("SELECT * FROM d0.t",
                       "SELECT i AS id, (i % 1000)::INTEGER AS value FROM range(300000) r(i)")
        sql += compare("SELECT * FROM d2.t", "SELECT * FROM d3.t")
        sql += compare("SELECT * FROM d2.t",
                       "SELECT i AS id, (i % 1000)::INTEGER AS value, md5(i::VARCHAR) AS payload "
                       "FROM range(300000) r(i)")
        sql += compare("SELECT * FROM d7.t", "SELECT * FROM d8.t")
        sql += compare("SELECT * FROM d7.t",
                       "SELECT i AS id, repeat(md5(i::VARCHAR), 256) AS payload "
                       "FROM range(1500) r(i)")
        expected = ("SELECT i AS id, repeat(md5(i::VARCHAR), 2) AS payload "
                    "FROM range(300000) r(i)")
        sql += compare("SELECT * FROM d4.t", expected)
        remaining = expected + " WHERE i >= 122880 AND i % 4 != 0"
        sql += compare("SELECT * FROM d5.t", remaining)
        sql += compare("SELECT * FROM d6.t", remaining + " UNION ALL "
                       "SELECT i, repeat(md5(i::VARCHAR), 2) "
                       "FROM range(300000, 450000) r(i)")
        subprocess.run([args.duckdb, "-init", os.devnull, "-batch", "-bail", ":memory:"],
                       input=sql, text=True, check=True, env=env)

        # Re-running must fail without changing any existing output.
        rerun = subprocess.run(command, capture_output=True, text=True, env=env)
        require(rerun.returncode != 0, "Existing output was accepted")
        require(generate.digest(manifest_path) == before, "Refusal changed manifest")
        for item in manifest["snapshots"]:
            require(generate.digest(out / item["file"]) == item["sha256"],
                    "Refusal changed a snapshot")
        for name in ("empty", "symlink"):
            destination = root / name
            if name == "empty":
                destination.mkdir()
            else:
                destination.symlink_to(out, target_is_directory=True)
            rejected = subprocess.run(command[:-3] + ["--out", str(destination)],
                                      capture_output=True, text=True, env=env)
            require(rejected.returncode != 0, f"Accepted existing {name}")

        # Portable failing executable: Python rejects the DuckDB CLI flags,
        # so generation fails and keeps an incomplete manifest.
        failed = root / "failed"
        failure = subprocess.run([sys.executable, str(script), "--duckdb", sys.executable,
                                  "--out", str(failed)], capture_output=True, text=True)
        require(failure.returncode != 0, "Expected CLI failure")
        require(json.loads((failed / "manifest.json").read_text())["complete"] is False,
                "Failed generation marked complete")

        # Directly exercise every nonempty-WAL guard (zero-length WAL is safe).
        fake_db = root / "guard.duckdb"
        for suffix in generate.WAL_SUFFIXES:
            wal = Path(str(fake_db) + suffix)
            wal.write_bytes(b"pending")
            try:
                generate.assert_no_wal(fake_db)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"Accepted nonempty {suffix}")
            wal.write_bytes(b"")
            generate.assert_no_wal(fake_db)
            wal.unlink()
    print("PASS: nine CLI snapshots, logical equality, persistence, provenance/logs, "
          "quoted paths, ignored startup file, overwrite refusal, failed CLI, WAL guards")


if __name__ == "__main__":
    main()
