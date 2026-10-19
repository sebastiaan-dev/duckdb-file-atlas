import { expect, test } from "bun:test";
import { splitStatements } from "../src/lib/sql-statements";

test("splits on top-level semicolons and reports each statement's first line", () => {
  expect(
    splitStatements(`CREATE TABLE t AS SELECT 1;
-- a comment; with a semicolon
INSERT INTO t VALUES (2);

SELECT count(*) FROM t`),
  ).toEqual([
    { text: "CREATE TABLE t AS SELECT 1", line: 1 },
    {
      text: "-- a comment; with a semicolon\nINSERT INTO t VALUES (2)",
      line: 3,
    },
    { text: "SELECT count(*) FROM t", line: 5 },
  ]);
});

test("quotes, dollar quotes and comments never split", () => {
  const script = [
    "SELECT 'a;b', 'it''s; fine', \"odd;name\";",
    // In E'…' strings a backslash escapes the quote.
    "SELECT E'back\\';slash';",
    "CREATE MACRO m() AS $$ SELECT 1; $$;",
    "SELECT /* ; */ 1;",
    "SELECT $1;",
  ].join("\n");
  expect(splitStatements(script).map((s) => s.text)).toEqual([
    "SELECT 'a;b', 'it''s; fine', \"odd;name\"",
    "SELECT E'back\\';slash'",
    "CREATE MACRO m() AS $$ SELECT 1; $$",
    "SELECT /* ; */ 1",
    "SELECT $1",
  ]);
});

test("empty and comment-only scripts have no statements", () => {
  expect(splitStatements("")).toEqual([]);
  expect(splitStatements(" ;; -- nothing\n/* here */ ;")).toEqual([]);
});
