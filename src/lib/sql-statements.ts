export interface SqlStatement {
  /** Statement text without its terminating semicolon, trimmed. */
  text: string;
  /** 1-based line of the statement's first character in the script. */
  line: number;
}

/**
 * Split a SQL script into statements on top-level semicolons. Quoted strings
 * ('…' with '' escapes, E'…' with backslash escapes), quoted identifiers
 * ("…"), dollar-quoted strings ($tag$…$tag$) and comments (-- … and /* … *\/)
 * never split. Statements consisting only of comments are dropped.
 */
export function splitStatements(script: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = 0;
  // Index of the statement's first non-comment character, or -1.
  let codeStart = -1;
  let i = 0;
  const n = script.length;
  const lineAt = (index: number) => {
    let line = 1;
    for (let j = 0; j < index; j++) if (script[j] === "\n") line++;
    return line;
  };
  const mark = (index: number) => {
    if (codeStart < 0) codeStart = index;
  };
  const push = (end: number) => {
    if (codeStart >= 0)
      statements.push({
        text: script.slice(start, end).trim(),
        line: lineAt(codeStart),
      });
    codeStart = -1;
  };
  while (i < n) {
    const c = script[i];
    const next = script[i + 1];
    if (c === "-" && next === "-") {
      const end = script.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      // E'…' strings allow backslash escapes.
      const escapes = c === "'" && /[eE]/.test(script[i - 1] ?? "");
      mark(i);
      i++;
      while (i < n) {
        if (escapes && script[i] === "\\") i += 2;
        else if (script[i] === c) {
          if (script[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(script.slice(i));
      // `$1` parameters are not dollar quotes.
      if (tag) {
        const end = script.indexOf(tag[0], i + tag[0].length);
        mark(i);
        i = end < 0 ? n : end + tag[0].length;
        continue;
      }
    }
    if (c === ";") {
      push(i);
      start = i + 1;
      i++;
      continue;
    }
    if (!/\s/.test(c)) mark(i);
    i++;
  }
  push(n);
  return statements;
}
