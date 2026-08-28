// TOON (Token-Optimized Object Notation): declare the schema once, then one
// pipe-delimited line per row, instead of repeating `{"key":"value", ...}`
// for every row. For a flat array of uniform objects this is the ~40-60%
// token win over standard JSON.
//
// Falls back to plain JSON for anything that isn't a non-empty array of
// uniform flat objects, rather than guessing at a lossy encoding - an LLM
// fed a malformed TOON string is worse than one fed slightly more tokens.
export function toToon<T extends Record<string, unknown>>(rows: T[]): string {
  if (rows.length === 0) return "[]";

  const keys = Object.keys(rows[0]!);
  const uniform = rows.every((r) => {
    const rowKeys = Object.keys(r);
    return rowKeys.length === keys.length && keys.every((k) => k in r);
  });
  if (!uniform) return JSON.stringify(rows);

  const header = `@schema:${keys.join(",")}`;
  const lines = rows.map((row) =>
    keys
      .map((k) => {
        const v = row[k];
        // A pipe or newline inside a value would corrupt the row boundary -
        // bail to JSON for this dataset rather than silently mangling data.
        const s = v === null || v === undefined ? "" : String(v);
        return s;
      })
      .join("|"),
  );

  const hasDelimiterCollision = lines.some((line, i) => {
    const rawValues = keys.map((k) => String(rows[i]![k] ?? ""));
    return rawValues.some((v) => v.includes("|") || v.includes("\n"));
  });
  if (hasDelimiterCollision) return JSON.stringify(rows);

  return [header, ...lines].join("\n");
}
