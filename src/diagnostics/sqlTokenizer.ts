// src/diagnostics/sqlTokenizer.ts
// Member 2 — SQL Multi-Statement Tokenizer
// Pure (vscode-free) module that masks SQL comments/strings and splits statements.
// Produces two mask views:
//   clauseMask — all comments, string literals, and quoted identifiers blanked (for clause detection)
//   parseMask  — comments and single-quoted strings blanked; quoted identifiers preserved (for table/col extraction)

export interface MaskedSql {
  /** Same length as original; comments and string contents replaced with spaces (newlines preserved) */
  clauseMask: string;
  /** Same length as original; comments and single-quoted contents blanked; double-quoted/backtick preserved */
  parseMask: string;
}

export interface SqlStatement {
  /** Original text (no masking) */
  sql: string;
  /** clauseMask slice */
  clauseMask: string;
  /** parseMask slice */
  parseMask: string;
  /** Start offset in the full document */
  startOffset: number;
  /** End offset (exclusive) in the full document */
  endOffset: number;
  /** 0-based index in the statements array */
  index: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// maskSql — single-pass tokenizer producing both mask views
// ─────────────────────────────────────────────────────────────────────────────

export function maskSql(text: string): MaskedSql {
  const clauseChars = text.split('');
  const parseChars = text.split('');
  const n = text.length;
  let i = 0;

  function blankBoth(start: number, end: number): void {
    for (let j = start; j < end; j++) {
      if (text[j] !== '\n' && text[j] !== '\r') {
        clauseChars[j] = ' ';
        parseChars[j] = ' ';
      }
    }
  }

  function blankClauseOnly(start: number, end: number): void {
    for (let j = start; j < end; j++) {
      if (text[j] !== '\n' && text[j] !== '\r') {
        clauseChars[j] = ' ';
        // parseChars preserved
      }
    }
  }

  while (i < n) {
    const c = text[i];
    const two = text.substr(i, 2);

    // Line comment: -- until newline
    if (two === '--') {
      const start = i;
      i += 2;
      while (i < n && text[i] !== '\n') { i++; }
      blankBoth(start, i);
      continue;
    }

    // Block comment: /* ... */ (non-nested)
    if (two === '/*') {
      const start = i;
      i += 2;
      while (i < n) {
        if (text.substr(i, 2) === '*/') { i += 2; break; }
        i++;
      }
      blankBoth(start, i);
      continue;
    }

    // Single-quoted string literal: '...' with '' escape
    if (c === "'" || (c === 'E' && text[i + 1] === "'") || (c === 'N' && text[i + 1] === "'") ||
        (c === 'e' && text[i + 1] === "'") || (c === 'n' && text[i + 1] === "'")) {
      const start = i;
      if (c !== "'") { i++; } // skip E/N prefix
      i++; // opening quote
      while (i < n) {
        const ch = text[i];
        if (ch === "'" && text[i + 1] === "'") { i += 2; continue; } // '' escape
        if (ch === "'" ) { i++; break; }
        if (ch === '\\') { i += 2; continue; } // backslash escape (MySQL)
        i++;
      }
      blankBoth(start, i);
      continue;
    }

    // Double-quoted identifier or string (mask both for clauseMask; preserve for parseMask)
    if (c === '"') {
      const start = i;
      i++; // opening "
      while (i < n) {
        const ch = text[i];
        if (ch === '"' && text[i + 1] === '"') { i += 2; continue; } // "" escape
        if (ch === '"') { i++; break; }
        i++;
      }
      // blankClauseOnly: clauseMask gets spaces, parseMask keeps original
      blankClauseOnly(start, i);
      continue;
    }

    // Backtick identifier (MySQL)
    if (c === '`') {
      const start = i;
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '`' && text[i + 1] === '`') { i += 2; continue; }
        if (ch === '`') { i++; break; }
        i++;
      }
      blankClauseOnly(start, i);
      continue;
    }

    // Dollar-quoted string (PostgreSQL): $$...$$ or $tag$...$tag$
    if (c === '$') {
      const tagM = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i));
      if (tagM) {
        const tag = tagM[0];
        const start = i;
        i += tag.length;
        const closer = text.indexOf(tag, i);
        if (closer >= 0) {
          i = closer + tag.length;
        } else {
          i = n; // unterminated
        }
        blankBoth(start, i);
        continue;
      }
    }

    i++;
  }

  return {
    clauseMask: clauseChars.join(''),
    parseMask: parseChars.join(''),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// splitSqlStatements — split into statements, each carrying both mask views
// ─────────────────────────────────────────────────────────────────────────────

export function splitSqlStatements(text: string): SqlStatement[] {
  const { clauseMask, parseMask } = maskSql(text);
  const statements: SqlStatement[] = [];
  let stmtStart = 0;
  let depth = 0;

  for (let i = 0; i < clauseMask.length; i++) {
    const c = clauseMask[i];
    if (c === '(') { depth++; }
    else if (c === ')') { depth = Math.max(0, depth - 1); }
    else if (c === ';' && depth === 0) {
      const raw = text.slice(stmtStart, i).trim();
      if (raw) {
        // Compute trimmed offsets
        const leadingSpaces = text.slice(stmtStart, i).search(/\S/);
        const trimStart = stmtStart + (leadingSpaces >= 0 ? leadingSpaces : 0);
        const trimEnd = i; // up to semicolon (exclusive)
        statements.push({
          sql: raw,
          clauseMask: clauseMask.slice(trimStart, trimEnd).trim(),
          parseMask: parseMask.slice(trimStart, trimEnd).trim(),
          startOffset: trimStart,
          endOffset: trimEnd,
          index: statements.length,
        });
      }
      stmtStart = i + 1;
      depth = 0;
    }
  }

  // Trailing statement without semicolon
  const trailing = text.slice(stmtStart).trim();
  if (trailing) {
    const leadingSpaces = text.slice(stmtStart).search(/\S/);
    const trimStart = stmtStart + (leadingSpaces >= 0 ? leadingSpaces : 0);
    statements.push({
      sql: trailing,
      clauseMask: clauseMask.slice(trimStart).trim(),
      parseMask: parseMask.slice(trimStart).trim(),
      startOffset: trimStart,
      endOffset: text.length,
      index: statements.length,
    });
  }

  return statements;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clause detection helpers (operate on clauseMask)
// ─────────────────────────────────────────────────────────────────────────────

export function hasClause(masked: string, clause: string): boolean {
  return new RegExp(`\\b${clause}\\b`, 'i').test(masked);
}

export function hasWhereClause(masked: string): boolean {
  return hasClause(masked, 'WHERE');
}

export function hasLimitClause(masked: string): boolean {
  return /\bLIMIT\s+\d/i.test(masked);
}

export function extractFirstKeyword(masked: string): string {
  const m = /^\s*(\w+)/.exec(masked);
  return m ? m[1].toUpperCase() : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// CTE name extraction — prevents false "table not found" for WITH aliases
// ─────────────────────────────────────────────────────────────────────────────

export function extractCteNames(parseMask: string): Set<string> {
  const names = new Set<string>();
  if (!/^\s*WITH\b/i.test(parseMask)) { return names; }
  const re = /\b(\w+)\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(parseMask)) !== null) {
    names.add(m[1].toLowerCase());
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table name extraction from parseMask
// ─────────────────────────────────────────────────────────────────────────────

function stripQuotes(s: string): string {
  return s.replace(/^["`[]|["`\]]$/g, '');
}

function normalizeTableRef(raw: string): string {
  const stripped = stripQuotes(raw.trim());
  const dot = stripped.lastIndexOf('.');
  return (dot >= 0 ? stripped.slice(dot + 1) : stripped).toLowerCase();
}

export function extractTablesFromStatement(parseMask: string): string[] {
  const tables: string[] = [];
  const seen = new Set<string>();

  const addTable = (raw: string): void => {
    if (!raw || /^\s*\(/.test(raw)) { return; } // subquery
    const name = normalizeTableRef(raw);
    if (!name || /^\s*$/.test(name)) { return; }
    if (!seen.has(name)) { seen.add(name); tables.push(name); }
  };

  // FROM / JOIN
  const fromJoinRe = /\b(?:FROM|JOIN)\s+([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = fromJoinRe.exec(parseMask)) !== null) { addTable(m[1]); }

  // INSERT INTO
  const insertRe = /\bINSERT\s+(?:IGNORE\s+|LOW_PRIORITY\s+)?INTO\s+([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/gi;
  while ((m = insertRe.exec(parseMask)) !== null) { addTable(m[1]); }

  // UPDATE
  const updateRe = /^\s*UPDATE\s+(?:LOW_PRIORITY\s+|DELAYED\s+|QUICK\s+)?([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/i;
  const um = updateRe.exec(parseMask);
  if (um) { addTable(um[1]); }

  // DELETE FROM
  const deleteRe = /\bDELETE\s+(?:LOW_PRIORITY\s+|QUICK\s+|IGNORE\s+)?(?:.*?\s+)?FROM\s+([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/i;
  const dm = deleteRe.exec(parseMask);
  if (dm) { addTable(dm[1]); }

  // ALTER TABLE / DROP TABLE / CREATE TABLE
  const ddlRe = /\b(?:ALTER|DROP|TRUNCATE)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/gi;
  while ((m = ddlRe.exec(parseMask)) !== null) { addTable(m[1]); }

  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// Column name extraction from WHERE/SET/SELECT clauses
// ─────────────────────────────────────────────────────────────────────────────

/** Extract simple identifier-like tokens from WHERE conditions (LHS of comparisons) */
export function extractWhereColumns(parseMask: string): string[] {
  const cols: string[] = [];
  // After WHERE keyword, find identifier op value patterns
  const whereIdx = parseMask.search(/\bWHERE\b/i);
  if (whereIdx < 0) { return cols; }
  const whereClause = parseMask.slice(whereIdx);
  const re = /\b([A-Za-z_][\w$]*)\s*(?:=|!=|<>|<=|>=|<|>|LIKE|IN|IS|BETWEEN)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(whereClause)) !== null) {
    const name = m[1].toLowerCase();
    if (!SQL_KEYWORDS_SET.has(name)) { cols.push(name); }
  }
  return cols;
}

/** Extract column names from SELECT projection list */
export function extractSelectColumns(parseMask: string): string[] {
  const cols: string[] = [];
  const m = /^\s*SELECT\s+(?:DISTINCT\s+|ALL\s+)?([\s\S]+?)\s+FROM\b/i.exec(parseMask);
  if (!m) { return cols; }
  const projection = m[1];
  if (/^\s*\*\s*$/.test(projection)) { return ['*']; }
  for (const part of projection.split(',')) {
    const col = part.trim().split(/\s+/)[0].replace(/^[`"[\]]|[`"[\]]$/g, '');
    if (col && col !== '*' && !SQL_KEYWORDS_SET.has(col.toLowerCase())) {
      // Skip function calls (name followed by open paren)
      if (!/\s*\(/.test(part.trim().slice(col.length))) {
        cols.push(col.toLowerCase());
      }
    }
  }
  return cols;
}

/** Extract column names from SET clause of UPDATE */
export function extractSetColumns(parseMask: string): string[] {
  const cols: string[] = [];
  const setIdx = parseMask.search(/\bSET\b/i);
  if (setIdx < 0) { return cols; }
  const setClause = parseMask.slice(setIdx);
  const re = /\b([A-Za-z_][\w$]*)\s*=/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(setClause)) !== null) {
    const name = m[1].toLowerCase();
    if (!SQL_KEYWORDS_SET.has(name)) { cols.push(name); }
  }
  return cols;
}

/** Extract column names from INSERT INTO t (col1, col2) */
export function extractInsertColumns(parseMask: string): string[] {
  const cols: string[] = [];
  const m = /\bINSERT\s+(?:IGNORE\s+|LOW_PRIORITY\s+)?INTO\s+[^\s(]+\s*\(([^)]+)\)/i.exec(parseMask);
  if (!m) { return cols; }
  for (const col of m[1].split(',')) {
    const name = col.trim().replace(/^[`"[\]]|[`"[\]]$/g, '').toLowerCase();
    if (name) { cols.push(name); }
  }
  return cols;
}

// SQL keywords to skip during column extraction
const SQL_KEYWORDS_SET = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'using',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all', 'except', 'intersect',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'truncate',
  'create', 'alter', 'drop', 'table', 'index', 'view', 'database', 'schema',
  'primary', 'key', 'foreign', 'references', 'constraint', 'unique', 'check',
  'default', 'auto_increment', 'serial', 'cascade', 'with', 'as', 'case', 'when',
  'then', 'else', 'end', 'between', 'like', 'ilike', 'exists', 'any', 'some',
  'distinct', 'top', 'over', 'partition', 'row_number', 'rank', 'dense_rank',
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'cast', 'convert',
]);
