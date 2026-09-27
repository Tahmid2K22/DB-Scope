// src/contextManager/schemaParsers.ts
// Member 2 — Schema Parser Utilities
// Pure (vscode-free) SQL, Prisma, Django, and TypeORM schema parsers.
// All functions are exported and testable without VS Code.

import { ColumnDefinition, IndexDefinition, TableDefinition, DatabaseSchema, TableConstraint } from '../core/types';

export type MutableSchema = Record<string, TableDefinition>;

// ─────────────────────────────────────────────────────────────────────────────
// Utility: shallow clone a TableDefinition (avoids structuredClone lib issues)
// ─────────────────────────────────────────────────────────────────────────────

function cloneColumn(c: ColumnDefinition): ColumnDefinition {
  return { ...c };
}

function cloneTable(t: TableDefinition): TableDefinition {
  return {
    ...t,
    columns: Object.fromEntries(Object.entries(t.columns).map(([k, v]) => [k, cloneColumn(v)])),
    indexes: t.indexes.map(i => ({ ...i, columns: [...i.columns] })),
    constraints: t.constraints?.map(c => ({ ...c, columns: [...c.columns], referenceColumns: c.referenceColumns ? [...c.referenceColumns] : undefined })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// splitTopLevel — split string on `sep` at depth-0 (ignores content in parens)
// ─────────────────────────────────────────────────────────────────────────────

export function splitTopLevel(input: string, sep = ','): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; current += c; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; current += c; continue; }
    if (inSingle || inDouble) { current += c; continue; }
    if (c === '(') { depth++; current += c; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); current += c; continue; }
    if (depth === 0 && input.startsWith(sep, i)) {
      result.push(current);
      current = '';
      i += sep.length - 1;
      continue;
    }
    current += c;
  }
  if (current.trim()) { result.push(current); }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// splitStatements — split a SQL script into individual statements
// ─────────────────────────────────────────────────────────────────────────────

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let i = 0;
  const n = sql.length;
  type State = 'NORMAL' | 'LINE_COMMENT' | 'BLOCK_COMMENT' | 'SINGLE' | 'DOUBLE' | 'BACKTICK' | 'DOLLAR';
  let state: State = 'NORMAL';
  let dollarTag = '';

  while (i < n) {
    const c = sql[i];
    const two = sql.substr(i, 2);

    switch (state) {
      case 'NORMAL': {
        if (two === '--') { state = 'LINE_COMMENT'; i += 2; continue; }
        if (two === '/*') { state = 'BLOCK_COMMENT'; i += 2; continue; }
        if (c === "'") { state = 'SINGLE'; buf += c; i++; continue; }
        if (c === '"') { state = 'DOUBLE'; buf += c; i++; continue; }
        if (c === '`') { state = 'BACKTICK'; buf += c; i++; continue; }
        // Dollar-quoted string (PostgreSQL): $$...$$  or $tag$...$tag$
        if (c === '$') {
          const tagM = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
          if (tagM) {
            dollarTag = tagM[0];
            state = 'DOLLAR';
            buf += dollarTag;
            i += dollarTag.length;
            continue;
          }
        }
        if (c === '(') { depth++; }
        if (c === ')') { depth = Math.max(0, depth - 1); }
        if (c === ';' && depth === 0) {
          const trimmed = buf.trim();
          if (trimmed) { out.push(trimmed); }
          buf = '';
          i++;
          continue;
        }
        buf += c;
        i++;
        break;
      }
      case 'LINE_COMMENT': {
        if (c === '\n') { state = 'NORMAL'; buf += '\n'; }
        i++;
        break;
      }
      case 'BLOCK_COMMENT': {
        if (two === '*/') { state = 'NORMAL'; i += 2; continue; }
        i++;
        break;
      }
      case 'SINGLE': {
        buf += c;
        if (c === "'" && sql[i + 1] === "'") { buf += "'"; i += 2; continue; }
        if (c === "'") { state = 'NORMAL'; }
        i++;
        break;
      }
      case 'DOUBLE': {
        buf += c;
        if (c === '"' && sql[i + 1] === '"') { buf += '"'; i += 2; continue; }
        if (c === '"') { state = 'NORMAL'; }
        i++;
        break;
      }
      case 'BACKTICK': {
        buf += c;
        if (c === '`' && sql[i + 1] === '`') { buf += '`'; i += 2; continue; }
        if (c === '`') { state = 'NORMAL'; }
        i++;
        break;
      }
      case 'DOLLAR': {
        if (sql.startsWith(dollarTag, i)) {
          buf += dollarTag;
          i += dollarTag.length;
          state = 'NORMAL';
          dollarTag = '';
          continue;
        }
        buf += c;
        i++;
        break;
      }
    }
  }
  const trimmed = buf.trim();
  if (trimmed) { out.push(trimmed); }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeIdentifier — strips quotes, schema prefix; folds to lowercase
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeIdentifier(raw: string): string {
  let s = raw.trim();
  // Backtick-quoted (MySQL)
  if (s.startsWith('`') && s.endsWith('`')) { return s.slice(1, -1); }
  // Double-quoted (standard SQL / PG)
  if (s.startsWith('"') && s.endsWith('"')) { return s.slice(1, -1); }
  // Bracket-quoted (SQL Server)
  if (s.startsWith('[') && s.endsWith(']')) { return s.slice(1, -1); }
  // Strip trailing semicolon/whitespace
  s = s.replace(/;+$/, '').trim();
  // Strip surrounding quotes (if any remained)
  s = s.replace(/^["'`]|["'`]$/g, '');
  // schema.table → table (take last dot-segment)
  const dot = s.lastIndexOf('.');
  if (dot >= 0) { s = s.slice(dot + 1); }
  return s.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// snakeCase / pluralize — helpers for ORM table name inference
// ─────────────────────────────────────────────────────────────────────────────

export function snakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export function pluralize(word: string): string {
  if (!word) { return word; }
  const lw = word.toLowerCase();
  if (lw.endsWith('ies')) { return word; }
  if (lw.endsWith('s') && !lw.endsWith('ss')) { return word; }
  if (lw.endsWith('y') && !/[aeiou]y$/i.test(word)) {
    return word.slice(0, -1) + 'ies';
  }
  if (lw.endsWith('s') || lw.endsWith('sh') || lw.endsWith('ch') || lw.endsWith('x') || lw.endsWith('z')) {
    return word + 'es';
  }
  return word + 's';
}

// ─────────────────────────────────────────────────────────────────────────────
// RE_TYPE_START — matches SQL column type tokens
// ─────────────────────────────────────────────────────────────────────────────

const RE_TYPE_START = /^(?:DOUBLE\s+PRECISION|CHARACTER\s+VARYING|TIMESTAMP\s+(?:WITH|WITHOUT)\s+TIME\s+ZONE|TIMESTAMPTZ|TIMETZ|BIGSERIAL|SMALLSERIAL|SERIAL|BIGINT|SMALLINT|MEDIUMINT|TINYINT|INT(?:EGER)?|REAL|FLOAT8?|DOUBLE|DECIMAL|NUMERIC|CHAR|VARCHAR|NVARCHAR|TEXT|LONGTEXT|MEDIUMTEXT|TINYTEXT|BLOB|LONGBLOB|MEDIUMBLOB|TINYBLOB|BYTEA|BOOLEAN|BOOL|JSONB|JSON|UUID|DATE|TIME|DATETIME|TIMESTAMP|XML|ENUM|ARRAY|INET|CIDR|MACADDR|MONEY|BIT|VARBIT|INTERVAL|POINT|LINE|LSEG|BOX|PATH|POLYGON|CIRCLE|GEOGRAPHY|GEOMETRY)(?:\s*\([^)]*\))?(?:\s+(?:UNSIGNED|ZEROFILL|VARYING|PRECISION))?/i;

// ─────────────────────────────────────────────────────────────────────────────
// parseOneColumnDefinition — parse a single column definition chunk
// ─────────────────────────────────────────────────────────────────────────────

function parseOneColumnDefinition(raw: string): ColumnDefinition | null {
  const trimmed = raw.trim();
  if (!trimmed) { return null; }
  // Skip table-level constraint declarations
  if (/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY|CONSTRAINT|LIKE|EXCLUDE)\b/i.test(trimmed)) { return null; }

  // Match column name (quoted or unquoted) followed by the rest
  const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_$][\w$]*))\s+([\s\S]+)$/.exec(trimmed);
  if (!m) { return null; }
  const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
  if (!name) { return null; }
  let rest = m[5];

  // Extract type
  const typeM = RE_TYPE_START.exec(rest);
  let type: string;
  if (typeM) {
    type = typeM[0].replace(/\s+/g, ' ').trim();
    rest = rest.slice(typeM[0].length);
  } else {
    // Fallback: first token + optional paren group
    const fallback = /^([^\s,]+(?:\s*\([^)]*\))?)/.exec(rest);
    type = fallback ? fallback[0].trim() : 'text';
    rest = rest.slice(type.length);
  }

  const upper = rest.toUpperCase();
  const isPk = /\bPRIMARY\s+KEY\b/.test(upper);
  const isFk = /\bREFERENCES\b/.test(upper);
  const notNull = /\bNOT\s+NULL\b/.test(upper);
  const ref = /REFERENCES\s+(?:"([^"]+)"|`([^`]+)`|([\w.]+))\s*\(\s*(?:"([^"]+)"|`([^`]+)"|(\w+))\s*\)/i.exec(rest);
  const defM = /\bDEFAULT\s+((?:'(?:[^']|'')*')|"[^"]*"|\$\$[^$]*\$\$|[^,\s(]+(?:\([^)]*\))?)/i.exec(rest);

  return {
    name,
    type,
    nullable: !notNull && !isPk,
    isPrimaryKey: isPk,
    isForeignKey: isFk,
    referencesTable: ref ? normalizeIdentifier(ref[1] ?? ref[2] ?? ref[3] ?? '') : undefined,
    referencesColumn: ref ? (ref[4] ?? ref[5] ?? ref[6] ?? undefined) : undefined,
    defaultValue: defM ? defM[1] : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseColumnDefinitions — parse comma-separated column defs from CREATE TABLE body
// ─────────────────────────────────────────────────────────────────────────────

export function parseColumnDefinitions(defs: string): Record<string, ColumnDefinition> {
  const columns: Record<string, ColumnDefinition> = {};
  for (const chunk of splitTopLevel(defs)) {
    const col = parseOneColumnDefinition(chunk);
    if (col) { columns[col.name] = col; }
  }
  return columns;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseTableConstraint — parse a table-level constraint chunk
// ─────────────────────────────────────────────────────────────────────────────

export function parseTableConstraint(chunk: string): TableConstraint | null {
  const c = chunk.trim();
  if (!c) { return null; }

  // Extract optional CONSTRAINT name
  const nameM = /^CONSTRAINT\s+(?:"([^"]+)"|`([^`]+)`|(\w+))\s+/i.exec(c);
  const name = nameM ? (nameM[1] ?? nameM[2] ?? nameM[3]) : undefined;
  const body = nameM ? c.slice(nameM[0].length) : c;

  // PRIMARY KEY (col, ...)
  const pkM = /^PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(body);
  if (pkM) {
    const columns = splitTopLevel(pkM[1]).map(s => normalizeIdentifier(s.trim()));
    return { name, type: 'primary_key', columns, raw: c };
  }

  // FOREIGN KEY (col) REFERENCES table (col)
  const fkM = /^FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([\w."'`[\]]+)\s*\(([^)]+)\)/i.exec(body);
  if (fkM) {
    const columns = splitTopLevel(fkM[1]).map(s => normalizeIdentifier(s.trim()));
    const referencesTable = normalizeIdentifier(fkM[2]);
    const referenceColumns = splitTopLevel(fkM[3]).map(s => normalizeIdentifier(s.trim()));
    return { name, type: 'foreign_key', columns, referencesTable, referenceColumns, raw: c };
  }

  // UNIQUE (col, ...)
  const uqM = /^UNIQUE(?:\s+(?:KEY|INDEX))?\s*(?:\w+\s*)?\(([^)]+)\)/i.exec(body);
  if (uqM) {
    const columns = splitTopLevel(uqM[1]).map(s => normalizeIdentifier(s.trim()));
    return { name, type: 'unique', columns, raw: c };
  }

  // CHECK (...)
  if (/^CHECK\b/i.test(body)) {
    return { name, type: 'check', columns: [], raw: c };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyConstraintsToColumns — back-propagate table-level constraints onto columns
// ─────────────────────────────────────────────────────────────────────────────

function applyConstraintsToColumns(table: TableDefinition): void {
  for (const con of table.constraints ?? []) {
    if (con.type === 'primary_key') {
      for (const col of con.columns) {
        if (table.columns[col]) {
          table.columns[col].isPrimaryKey = true;
          table.columns[col].nullable = false;
        }
      }
    } else if (con.type === 'foreign_key') {
      const srcCol = con.columns[0];
      if (srcCol && table.columns[srcCol]) {
        table.columns[srcCol].isForeignKey = true;
        table.columns[srcCol].referencesTable = con.referencesTable;
        table.columns[srcCol].referencesColumn = con.referenceColumns?.[0];
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// parseSqlScript — parse a full SQL script into a MutableSchema
// ─────────────────────────────────────────────────────────────────────────────

export function parseSqlScript(sql: string, into?: MutableSchema): MutableSchema {
  const tables: MutableSchema = into ?? {};
  for (const stmt of splitStatements(sql)) {
    const upper = stmt.trimStart().toUpperCase();
    if (/^CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(stmt)) {
      applyCreateTable(stmt, tables);
    } else if (/^ALTER\s+TABLE\b/i.test(stmt)) {
      applyAlterTable(stmt, tables);
    } else if (/^DROP\s+TABLE\b/i.test(stmt)) {
      const m = /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?([\w"'`[\].]+)/i.exec(stmt);
      if (m) {
        const tName = normalizeIdentifier(m[1]);
        delete tables[tName];
      }
    } else if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt)) {
      applyCreateIndex(stmt, tables);
    }
    void upper; // suppress unused warning
  }
  return tables;
}

function applyCreateTable(stmt: string, tables: MutableSchema): void {
  // Capture table name and body between outermost parens
  const m = /^CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'`[\].]+)\s*\(([\s\S]+)\)\s*(?:ENGINE\s*=\s*\w+|DEFAULT\s+CHARSET|CHARSET|COLLATE|AUTO_INCREMENT|ROW_FORMAT|COMMENT|;|$)/i.exec(stmt);
  if (!m) {
    // Try simpler match that just grabs content between first ( and last )
    const m2 = /^CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'`[\].]+)\s*\(([\s\S]+)\)/i.exec(stmt);
    if (!m2) { return; }
    const tName = normalizeIdentifier(m2[1]);
    const body = m2[2];
    buildTable(tName, body, tables);
    return;
  }
  const tName = normalizeIdentifier(m[1]);
  buildTable(tName, m[2], tables);
}

function buildTable(tName: string, body: string, tables: MutableSchema): void {
  const columns = parseColumnDefinitions(body);
  const constraints: TableConstraint[] = splitTopLevel(body)
    .map(chunk => parseTableConstraint(chunk.trim()))
    .filter((c): c is TableConstraint => c !== null);
  const table: TableDefinition = { name: tName, columns, indexes: [], constraints };
  applyConstraintsToColumns(table);
  // Add unique indexes from constraints
  for (const con of constraints) {
    if (con.type === 'unique' && con.columns.length > 0) {
      table.indexes.push({ name: con.name ?? `uq_${tName}_${con.columns.join('_')}`, columns: con.columns, isUnique: true });
    }
  }
  tables[tName] = table;
}

function applyCreateIndex(stmt: string, tables: MutableSchema): void {
  const m = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\s+)?ON\s+([\w"'`[\].]+)\s*\(([^)]+)\)/i.exec(stmt);
  if (!m) { return; }
  const isUnique = !!m[1];
  const idxName = m[2] ?? `idx_${normalizeIdentifier(m[3])}_${Date.now()}`;
  const tName = normalizeIdentifier(m[3]);
  const columns = splitTopLevel(m[4]).map(s => normalizeIdentifier(s.trim().split(/\s+/)[0]));
  if (tables[tName]) {
    tables[tName].indexes.push({ name: idxName, columns, isUnique });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// applyAlterTable — incremental schema mutation from ALTER TABLE statements
// ─────────────────────────────────────────────────────────────────────────────

const RE_ALTER_TABLE_HEADER = /^ALTER\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w"'`[\].]+)\s+([\s\S]+)$/i;

export function applyAlterTable(statement: string, tables: MutableSchema): void {
  const m = RE_ALTER_TABLE_HEADER.exec(statement.trim().replace(/;$/, ''));
  if (!m) { return; }
  const tableName = normalizeIdentifier(m[1]);
  const rest = m[2].trim().replace(/;$/, '');

  // RENAME TO — table rename (checked before column operations)
  const rnTable = /^RENAME\s+(?:TO|AS)\s+([\w"'`[\]]+)\s*$/i.exec(rest);
  if (rnTable) {
    const table = tables[tableName];
    if (!table) { return; }
    const newName = normalizeIdentifier(rnTable[1]);
    delete tables[tableName];
    table.name = newName;
    tables[newName] = table;
    return;
  }

  const table = tables[tableName];
  if (!table) { return; } // unknown table — skip silently

  // Process comma-separated clauses
  for (const clause of splitTopLevel(rest)) {
    applyAlterClause(clause.trim(), table, tableName);
  }
}

function applyAlterClause(c: string, table: TableDefinition, tableName: string): void {
  if (!c) { return; }

  // 1. DROP CONSTRAINT / DROP FOREIGN KEY / DROP PRIMARY KEY / DROP INDEX/KEY
  if (/^DROP\s+(?:CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY|INDEX|KEY)\b/i.test(c)) {
    const conNameM = /^DROP\s+(?:CONSTRAINT|FOREIGN\s+KEY|INDEX|KEY)\s+(?:IF\s+EXISTS\s+)?([\w"'`[\]]+)/i.exec(c);
    if (/^DROP\s+PRIMARY\s+KEY/i.test(c)) {
      for (const col of Object.values(table.columns)) { col.isPrimaryKey = false; }
      if (table.constraints) {
        table.constraints = table.constraints.filter(con => con.type !== 'primary_key');
      }
    } else if (conNameM) {
      const dropName = normalizeIdentifier(conNameM[1]);
      if (table.constraints) {
        table.constraints = table.constraints.filter(con => con.name !== dropName);
      }
      table.indexes = table.indexes.filter(idx => idx.name !== dropName);
    }
    return;
  }

  // 2. ADD CONSTRAINT / ADD PRIMARY KEY / ADD FOREIGN KEY / ADD UNIQUE
  if (/^ADD\s+(?:CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\b)/i.test(c)) {
    const body = c.replace(/^ADD\s+/i, '');
    const con = parseTableConstraint(body);
    if (con) {
      if (!table.constraints) { table.constraints = []; }
      table.constraints.push(con);
      applyConstraintsToColumns(table);
      if (con.type === 'unique' && con.columns.length > 0) {
        table.indexes.push({ name: con.name ?? `uq_${tableName}_${con.columns.join('_')}`, columns: con.columns, isUnique: true });
      }
    }
    return;
  }

  // 3. RENAME COLUMN a TO b (PG, MySQL 8, Oracle)
  const rnCol = /^RENAME\s+(?:COLUMN\s+)?([\w"'`[\]]+)\s+TO\s+([\w"'`[\]]+)\s*$/i.exec(c);
  if (rnCol) {
    const oldName = normalizeIdentifier(rnCol[1]);
    const newName = normalizeIdentifier(rnCol[2]);
    const col = table.columns[oldName];
    if (col) {
      delete table.columns[oldName];
      col.name = newName;
      table.columns[newName] = col;
      // Update constraint/index references
      for (const con of table.constraints ?? []) {
        const idx = con.columns.indexOf(oldName);
        if (idx >= 0) { con.columns[idx] = newName; }
      }
      for (const idx of table.indexes) {
        const i = idx.columns.indexOf(oldName);
        if (i >= 0) { idx.columns[i] = newName; }
      }
    }
    return;
  }

  // 4. CHANGE [COLUMN] old new definition (MySQL)
  const changeCol = /^CHANGE\s+(?:COLUMN\s+)?([\w"'`[\]]+)\s+([\w"'`[\]]+)\s+([\s\S]+)$/i.exec(c);
  if (changeCol) {
    const oldName = normalizeIdentifier(changeCol[1]);
    const newName = normalizeIdentifier(changeCol[2]);
    const parsed = parseColumnDefinitions(`${newName} ${changeCol[3]}`);
    const newDef = parsed[newName];
    if (newDef) {
      const prev = table.columns[oldName];
      delete table.columns[oldName];
      newDef.isPrimaryKey = newDef.isPrimaryKey || (prev?.isPrimaryKey ?? false);
      newDef.isForeignKey = newDef.isForeignKey || (prev?.isForeignKey ?? false);
      if (!newDef.referencesTable && prev?.referencesTable) { newDef.referencesTable = prev.referencesTable; newDef.referencesColumn = prev.referencesColumn; }
      table.columns[newName] = newDef;
    }
    return;
  }

  // 5. ALTER COLUMN ... (PG sub-forms)
  const altCol = /^ALTER\s+COLUMN\s+([\w"'`[\]]+)\s+([\s\S]+)$/i.exec(c);
  if (altCol) {
    const colName = normalizeIdentifier(altCol[1]);
    const sub = altCol[2].trim();
    const col = table.columns[colName];
    if (!col) { return; }

    const typeM = /^(?:SET\s+DATA\s+)?TYPE\s+([\s\S]+?)(?:\s+USING\s+[\s\S]+)?$/i.exec(sub);
    if (typeM) { const newType = typeM[1].trim().replace(/\s+/g, ' '); if (newType) { col.type = newType; } return; }
    if (/^SET\s+NOT\s+NULL\s*$/i.test(sub)) { col.nullable = false; return; }
    if (/^DROP\s+NOT\s+NULL\s*$/i.test(sub)) { col.nullable = true; return; }
    const setDef = /^SET\s+DEFAULT\s+([\s\S]+)$/i.exec(sub);
    if (setDef) { col.defaultValue = setDef[1].trim(); return; }
    if (/^DROP\s+DEFAULT\s*$/i.test(sub)) { delete col.defaultValue; return; }
    return;
  }

  // 6. MODIFY [COLUMN] ... (MySQL/Oracle)
  const modCol = /^MODIFY\s+(?:COLUMN\s+)?([\s\S]+)$/i.exec(c);
  if (modCol) {
    const body = modCol[1].trim();
    // Strip outer parens if present (Oracle: MODIFY (col type))
    const inner = /^\((.+)\)$/.exec(body);
    const defText = inner ? inner[1] : body;
    const parsed = parseColumnDefinitions(defText);
    for (const [n, def] of Object.entries(parsed)) {
      const prev = table.columns[n];
      table.columns[n] = {
        ...def,
        isPrimaryKey: def.isPrimaryKey || (prev?.isPrimaryKey ?? false),
        isForeignKey: def.isForeignKey || (prev?.isForeignKey ?? false),
        referencesTable: def.referencesTable ?? prev?.referencesTable,
        referencesColumn: def.referencesColumn ?? prev?.referencesColumn,
      };
    }
    return;
  }

  // 7. ADD [COLUMN] [IF NOT EXISTS] definition
  const addCol = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(c);
  if (addCol) {
    let body = addCol[1].trim();
    // MySQL: ADD COLUMN (...) multi-column
    const outer = /^\((.+)\)$/.exec(body);
    if (outer) { body = outer[1]; }
    const newCols = parseColumnDefinitions(body);
    for (const [n, def] of Object.entries(newCols)) {
      if (!table.columns[n]) { table.columns[n] = def; }
    }
    return;
  }

  // 8. DROP [COLUMN] [IF EXISTS] name
  const dropCol = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([\w"'`[\]]+)\s*$/i.exec(c);
  if (dropCol) {
    const colName = normalizeIdentifier(dropCol[1]);
    delete table.columns[colName];
    // Remove from constraints/indexes
    if (table.constraints) {
      table.constraints = table.constraints.filter(con => !con.columns.includes(colName));
    }
    table.indexes = table.indexes.filter(idx => !idx.columns.includes(colName));
    return;
  }
  // Unhandled clause — log nothing (tests may have noise)
}

// ─────────────────────────────────────────────────────────────────────────────
// mergeInto — existing-wins merge of addition into target
// ─────────────────────────────────────────────────────────────────────────────

export function mergeInto(target: MutableSchema, addition: MutableSchema): void {
  for (const [name, t] of Object.entries(addition)) {
    const existing = target[name];
    if (!existing) {
      target[name] = cloneTable(t);
      continue;
    }
    // Merge columns (existing wins)
    for (const [cn, col] of Object.entries(t.columns)) {
      if (!existing.columns[cn]) { existing.columns[cn] = cloneColumn(col); }
    }
    // Merge indexes (by name)
    for (const idx of t.indexes) {
      if (!existing.indexes.some(i => i.name === idx.name)) {
        existing.indexes.push({ ...idx, columns: [...idx.columns] });
      }
    }
    // Merge constraints (by name or raw)
    for (const con of t.constraints ?? []) {
      if (!(existing.constraints ??= []).some(ec => (ec.name && ec.name === con.name) || ec.raw === con.raw)) {
        existing.constraints.push({ ...con, columns: [...con.columns] });
      }
    }
    if (existing.rowCount === undefined && t.rowCount !== undefined) {
      existing.rowCount = t.rowCount;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// mergeSchemas — merge live schema with codebase schema (live wins)
// ─────────────────────────────────────────────────────────────────────────────

export function mergeSchemas(live: DatabaseSchema, codebase: DatabaseSchema): DatabaseSchema {
  const tables: MutableSchema = {};
  for (const [name, t] of Object.entries(live.tables)) {
    tables[name] = cloneTable(t);
  }
  mergeInto(tables, codebase.tables);
  return { ...live, tables, source: 'merged', extractedAt: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseDjangoModels — parse Django model classes from Python source
// ─────────────────────────────────────────────────────────────────────────────

const DJANGO_CLASS_RE = /^class\s+(\w+)\s*\(\s*(?:[\w.]*Model)\s*\)\s*:/gm;
const DJANGO_FIELD_RE = /^(\w+)\s*=\s*models\.(\w+)\s*\(([\s\S]*?)\)\s*$/;
const DJANGO_DB_TABLE_RE = /db_table\s*=\s*['"]([^'"]+)['"]/;
const DJANGO_MAX_LENGTH_RE = /max_length\s*=\s*(\d+)/;
const DJANGO_DIGITS_RE = /max_digits\s*=\s*(\d+)/;
const DJANGO_DECIMAL_RE = /decimal_places\s*=\s*(\d+)/;
const DJANGO_NULL_RE = /(?:^|,\s*)null\s*=\s*True/i;
const DJANGO_PK_RE = /(?:^|,\s*)primary_key\s*=\s*True/i;
const DJANGO_UNIQUE_RE = /(?:^|,\s*)unique\s*=\s*True/i;
const DJANGO_DEFAULT_RE = /(?:^|,\s*)default\s*=\s*([^,)]+)/;

const DJANGO_TYPE_MAP: Record<string, (args: string) => string> = {
  AutoField: () => 'integer',
  BigAutoField: () => 'bigint',
  SmallAutoField: () => 'smallint',
  CharField: (a) => { const ml = DJANGO_MAX_LENGTH_RE.exec(a); return `varchar(${ml ? ml[1] : '255'})`; },
  TextField: () => 'text',
  IntegerField: () => 'integer',
  PositiveIntegerField: () => 'integer',
  PositiveSmallIntegerField: () => 'smallint',
  BigIntegerField: () => 'bigint',
  SmallIntegerField: () => 'smallint',
  FloatField: () => 'double precision',
  DecimalField: (a) => { const d = DJANGO_DIGITS_RE.exec(a); const dp = DJANGO_DECIMAL_RE.exec(a); return `decimal(${d ? d[1] : '10'},${dp ? dp[1] : '0'})`; },
  BooleanField: () => 'boolean',
  DateField: () => 'date',
  DateTimeField: () => 'timestamptz',
  TimeField: () => 'time',
  EmailField: (a) => { const ml = DJANGO_MAX_LENGTH_RE.exec(a); return `varchar(${ml ? ml[1] : '254'})`; },
  URLField: (a) => { const ml = DJANGO_MAX_LENGTH_RE.exec(a); return `varchar(${ml ? ml[1] : '200'})`; },
  SlugField: (a) => { const ml = DJANGO_MAX_LENGTH_RE.exec(a); return `varchar(${ml ? ml[1] : '50'})`; },
  UUIDField: () => 'uuid',
  JSONField: () => 'jsonb',
  BinaryField: () => 'bytea',
  FileField: (a) => { const ml = DJANGO_MAX_LENGTH_RE.exec(a); return `varchar(${ml ? ml[1] : '100'})`; },
  ImageField: (a) => { const ml = DJANGO_MAX_LENGTH_RE.exec(a); return `varchar(${ml ? ml[1] : '100'})`; },
  ForeignKey: () => 'integer',
  OneToOneField: () => 'integer',
  ManyToManyField: () => '', // skip
  ManyToManyRel: () => '',  // skip
};

/** Join Python logical lines (handle open parens across lines) */
function joinPythonLines(lines: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const rawLine of lines) {
    const line = rawLine; // preserving # comments naive — ceiling noted
    if (!cur && !line.trim()) { continue; }
    cur += (cur ? ' ' : '') + line.trim();
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') { depth++; }
      if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); }
    }
    if (depth <= 0) { out.push(cur); cur = ''; depth = 0; }
  }
  if (cur.trim()) { out.push(cur); }
  return out;
}

/** Extract indented class body lines (lines more indented than class declaration) */
function extractClassBody(content: string, classStart: number): string[] {
  const after = content.slice(classStart);
  const lines = after.split('\n');
  // First line is the class declaration itself; find body indent from next indented line
  let bodyIndent = -1;
  const bodyLines: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { bodyLines.push(''); continue; }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (bodyIndent === -1) {
      if (indent === 0) { break; } // class ended
      bodyIndent = indent;
    }
    if (indent < bodyIndent) { break; } // dedented — class ended
    bodyLines.push(line);
  }
  return bodyLines;
}

export function parseDjangoModels(content: string, modelTableMap?: Record<string, string>): MutableSchema {
  const tables: MutableSchema = {};

  // Pass 1: collect class names → table names
  const classTableMap: Record<string, string> = { ...modelTableMap };
  {
    const re = new RegExp(DJANGO_CLASS_RE.source, 'gm');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const className = m[1];
      const bodyLines = extractClassBody(content, m.index);
      const joined = joinPythonLines(bodyLines);
      const metaBlock = joined.find(l => /^class\s+Meta\s*:/i.test(l));
      let tableName: string | undefined;
      if (metaBlock) {
        const metaIdx = joined.indexOf(metaBlock);
        for (let i = metaIdx + 1; i < joined.length; i++) {
          const dbM = DJANGO_DB_TABLE_RE.exec(joined[i]);
          if (dbM) { tableName = dbM[1]; break; }
        }
      }
      classTableMap[className] = tableName ?? pluralize(snakeCase(className));
    }
  }

  // Pass 2: parse columns
  const re = new RegExp(DJANGO_CLASS_RE.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const className = m[1];
    const tableName = classTableMap[className] ?? pluralize(snakeCase(className));
    const bodyLines = extractClassBody(content, m.index);
    const joined = joinPythonLines(bodyLines);
    const columns: Record<string, ColumnDefinition> = {};
    const indexes: IndexDefinition[] = [];

    for (const line of joined) {
      if (/^class\s+Meta\s*:/i.test(line)) { break; }
      if (/^def\s+/.test(line) || /^__/.test(line) || /^objects\s*=/.test(line)) { continue; }

      const fM = DJANGO_FIELD_RE.exec(line);
      if (!fM) { continue; }
      const fieldName = fM[1];
      const fieldType = fM[2];
      const args = fM[3];

      const typeBuilder = DJANGO_TYPE_MAP[fieldType];
      if (!typeBuilder) { continue; }
      const sqlType = typeBuilder(args);
      if (!sqlType) { continue; } // ManyToMany — skip

      const isPk = DJANGO_PK_RE.test(args) || fieldType === 'AutoField' || fieldType === 'BigAutoField' || fieldType === 'SmallAutoField';
      const isNullable = DJANGO_NULL_RE.test(args) && !isPk;
      const isUnique = DJANGO_UNIQUE_RE.test(args);
      const defM = DJANGO_DEFAULT_RE.exec(args);

      let referencesTable: string | undefined;
      if (fieldType === 'ForeignKey' || fieldType === 'OneToOneField') {
        const pos = args.trim().split(',')[0].trim();
        const refClass = pos.replace(/['"]/g, '').split('.').pop() ?? '';
        if (refClass && refClass !== 'self') {
          referencesTable = classTableMap[refClass] ?? pluralize(snakeCase(refClass));
        } else if (refClass === 'self') {
          referencesTable = tableName;
        }
      }

      const colName = (fieldType === 'ForeignKey' || fieldType === 'OneToOneField') ? `${fieldName}_id` : fieldName;
      columns[colName] = {
        name: colName,
        type: sqlType,
        nullable: isNullable,
        isPrimaryKey: isPk,
        isForeignKey: !!(fieldType === 'ForeignKey' || fieldType === 'OneToOneField'),
        referencesTable,
        referencesColumn: referencesTable ? 'id' : undefined,
        defaultValue: defM ? defM[1].trim() : undefined,
      };

      if (isUnique) {
        indexes.push({ name: `uq_${tableName}_${colName}`, columns: [colName], isUnique: true });
      }
    }

    tables[tableName] = { name: tableName, columns, indexes };
  }

  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseTypeOrmEntities — parse TypeORM entity classes from TypeScript source
// ─────────────────────────────────────────────────────────────────────────────

const TS_TYPE_MAP: Record<string, string> = {
  string: 'character varying',
  number: 'integer',
  boolean: 'boolean',
  Date: 'timestamp',
  bigint: 'bigint',
};

function inferTypeFromTs(tsType: string): string {
  const base = tsType.replace(/[?!]|\[\]$/g, '').trim();
  return TS_TYPE_MAP[base] ?? 'text';
}

/** Extract balanced braces starting from position `from` in `str` */
function extractBraceBlock(str: string, from: number): string {
  let depth = 0;
  let start = -1;
  for (let i = from; i < str.length; i++) {
    const c = str[i];
    if (c === '{') { if (start === -1) { start = i; } depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start !== -1) { return str.slice(start + 1, i); } }
  }
  return '';
}

/** Extract balanced parens content starting from position `from` */
function extractParenContent(str: string, from: number): string {
  let depth = 0;
  let start = -1;
  for (let i = from; i < str.length; i++) {
    const c = str[i];
    if (c === '(') { if (start === -1) { start = i; } depth++; }
    else if (c === ')') { depth--; if (depth === 0 && start !== -1) { return str.slice(start + 1, i); } }
  }
  return '';
}

/** Parse simple JS/TS object literal like { type: 'varchar', length: 255, nullable: true } */
function parseTsObjectLiteral(src: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!src.trim()) { return result; }
  // Strip outer { } if present
  const inner = src.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const part of splitTopLevel(inner)) {
    const kv = part.trim();
    const colonIdx = kv.indexOf(':');
    if (colonIdx < 0) { continue; }
    const key = kv.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
    const val = kv.slice(colonIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

function buildColumnFromDecorators(
  decorators: string[],
  propName: string,
  tsType: string,
): ColumnDefinition | null {
  let sqlType = '';
  let colName = propName;
  let nullable = tsType.includes('?') || tsType.includes(' | null') || tsType.includes('| undefined');
  let isPk = false;
  let isFk = false;
  let defaultValue: string | undefined;
  let referencesTable: string | undefined;
  let isColumn = false;

  for (const dec of decorators) {
    const decName = /^@(\w+)/.exec(dec)?.[1] ?? '';
    const args = extractParenContent(dec, dec.indexOf('(') >= 0 ? dec.indexOf('@' + decName) : 0);

    switch (decName) {
      case 'PrimaryGeneratedColumn': {
        isPk = true; isColumn = true;
        const kindM = /['"](\w+)['"]/.exec(args);
        const kind = kindM ? kindM[1] : 'increment';
        sqlType = kind === 'uuid' ? 'uuid' : kind === 'rowid' ? 'bigint' : 'integer';
        break;
      }
      case 'PrimaryColumn': {
        isPk = true; isColumn = true;
        const opts = parseTsObjectLiteral(args);
        sqlType = opts['type'] ? opts['type'].replace(/['"]/g, '') : inferTypeFromTs(tsType);
        break;
      }
      case 'Column': {
        isColumn = true;
        // args could be 'varchar' or { type: 'varchar', ... }
        const trimmedArgs = args.trim();
        if (trimmedArgs.startsWith('{')) {
          const opts = parseTsObjectLiteral(trimmedArgs);
          sqlType = opts['type'] ? opts['type'].replace(/['"]/g, '') : '';
          if (opts['length']) { sqlType += `(${opts['length']})`; }
          else if (opts['precision'] && opts['scale']) { sqlType += `(${opts['precision']},${opts['scale']})`; }
          else if (opts['precision']) { sqlType += `(${opts['precision']})`; }
          if (opts['nullable'] === 'true') { nullable = true; }
          if (opts['default'] !== undefined) { defaultValue = opts['default'].replace(/^['"]|['"]$/g, ''); }
          if (opts['name']) { colName = opts['name'].replace(/^['"]|['"]$/g, ''); }
        } else if (trimmedArgs.startsWith("'") || trimmedArgs.startsWith('"')) {
          sqlType = trimmedArgs.replace(/['"]/g, '');
        }
        if (!sqlType) { sqlType = inferTypeFromTs(tsType); }
        break;
      }
      case 'CreateDateColumn':
      case 'UpdateDateColumn':
      case 'DeleteDateColumn': {
        isColumn = true;
        sqlType = 'timestamptz';
        const opts = parseTsObjectLiteral(args);
        if (opts['name']) { colName = opts['name'].replace(/^['"]|['"]$/g, ''); }
        if (decName === 'DeleteDateColumn') { nullable = true; }
        break;
      }
      case 'VersionColumn': {
        isColumn = true;
        sqlType = 'integer';
        break;
      }
      case 'ManyToOne':
      case 'OneToOne': {
        isColumn = true;
        isFk = true;
        sqlType = sqlType || 'integer';
        // Extract target entity from arrow function () => TargetEntity
        const targetM = /\(\s*\)\s*=>\s*([A-Za-z_]\w*)/.exec(args);
        if (targetM) { referencesTable = pluralize(snakeCase(targetM[1])); }
        break;
      }
      case 'JoinColumn': {
        const opts = parseTsObjectLiteral(args);
        if (opts['name']) { colName = opts['name'].replace(/^['"]|['"]$/g, ''); }
        break;
      }
      // OneToMany, ManyToMany — no column
    }
  }

  if (!isColumn) { return null; }
  if (!sqlType) { sqlType = inferTypeFromTs(tsType); }

  return {
    name: colName,
    type: sqlType,
    nullable,
    isPrimaryKey: isPk,
    isForeignKey: isFk,
    referencesTable,
    referencesColumn: referencesTable ? 'id' : undefined,
    defaultValue,
  };
}

export function parseTypeOrmEntities(content: string, entityTables: Record<string, string> = {}): MutableSchema {
  const tables: MutableSchema = {};

  const ENTITY_RE = /@Entity\s*(?:\(([\s\S]*?)\))?\s*\n?\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  let em: RegExpExecArray | null;

  while ((em = ENTITY_RE.exec(content)) !== null) {
    const entityArgs = em[1] ?? '';
    const className = em[2];

    // Determine table name
    let tableName: string;
    const nameM = /^['"]([^'"]+)['"]/.exec(entityArgs.trim()) ??
      /name\s*:\s*['"]([^'"]+)['"]/.exec(entityArgs);
    if (nameM) {
      tableName = nameM[1];
    } else {
      tableName = entityTables[className] ?? pluralize(snakeCase(className));
    }

    // Find class body
    const classKeywordIdx = content.indexOf(`class ${className}`, em.index);
    if (classKeywordIdx < 0) { continue; }
    const openBrace = content.indexOf('{', classKeywordIdx);
    if (openBrace < 0) { continue; }
    const body = extractBraceBlock(content, openBrace);

    const columns: Record<string, ColumnDefinition> = {};
    const indexes: IndexDefinition[] = [];

    // Split body into ';'-terminated members
    for (const member of splitTopLevel(body, ';')) {
      const m = member.trim();
      if (!m) { continue; }

      // Extract all decorators
      const decMatches: string[] = [];
      const decRe = /@(\w+)(?:\s*\()?/g;
      let dm: RegExpExecArray | null;
      while ((dm = decRe.exec(m)) !== null) {
        // Grab decorator including its args
        const decStart = dm.index;
        const parenStart = m.indexOf('(', decStart);
        if (parenStart >= 0 && parenStart < decStart + dm[0].length + 5) {
          const argsContent = extractParenContent(m, decStart);
          decMatches.push(`@${dm[1]}(${argsContent})`);
        } else {
          decMatches.push(`@${dm[1]}`);
        }
      }

      // Extract property declaration (last non-decorator part)
      const propM = /([A-Za-z_]\w*)\??!?\s*(?::\s*([\w|<>[\] .]+?))?(?:\s*=|\s*;|$)/.exec(
        m.replace(/@\w+(?:\s*\([^)]*\))?/g, '')
      );
      if (!propM) { continue; }
      const propName = propM[1];
      const tsType = propM[2] ?? 'any';

      const col = buildColumnFromDecorators(decMatches, propName, tsType);
      if (col) { columns[col.name] = col; }
    }

    tables[tableName] = { name: tableName, columns, indexes };
  }

  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// parsePrismaSchema — parse a Prisma schema file
// ─────────────────────────────────────────────────────────────────────────────

const PRISMA_SCALAR_MAP: Record<string, string> = {
  String: 'text',
  Int: 'integer',
  BigInt: 'bigint',
  Float: 'double precision',
  Decimal: 'decimal',
  Boolean: 'boolean',
  DateTime: 'timestamptz',
  Json: 'jsonb',
  Bytes: 'bytea',
};

export function parsePrismaSchema(content: string): MutableSchema {
  const tables: MutableSchema = {};

  // Pass 1: collect enum names and model-to-table map and field @map values
  const enumNames = new Set<string>();
  {
    const re = /\benum\s+(\w+)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) { enumNames.add(m[1]); }
  }

  // Collect model names → table name (@@map or model name verbatim per Prisma default)
  const modelTableMap: Record<string, string> = {};
  const modelFieldMaps: Record<string, Record<string, string>> = {}; // modelName → { fieldName → dbName }
  {
    const re = /\bmodel\s+(\w+)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const modelName = m[1];
      const body = extractBraceBlock(content, m.index + m[0].length - 1);
      const mapM = /@@map\s*\(\s*"([^"]+)"\s*\)/.exec(body);
      modelTableMap[modelName] = mapM ? mapM[1] : modelName;
      // Collect field @map
      const fieldMaps: Record<string, string> = {};
      for (const line of body.split('\n')) {
        const fmM = /^\s*(\w+)\s+\w+[\w\s[\]?]*@map\s*\(\s*"([^"]+)"\s*\)/.exec(line);
        if (fmM) { fieldMaps[fmM[1]] = fmM[2]; }
      }
      modelFieldMaps[modelName] = fieldMaps;
    }
  }

  // Pass 2: parse model bodies
  const modelRe = /\bmodel\s+(\w+)\s*\{/g;
  let mm: RegExpExecArray | null;
  while ((mm = modelRe.exec(content)) !== null) {
    const modelName = mm[1];
    const tableName = modelTableMap[modelName] ?? modelName;
    const body = extractBraceBlock(content, mm.index + mm[0].length - 1);
    const fieldMaps = modelFieldMaps[modelName] ?? {};

    const columns: Record<string, ColumnDefinition> = {};
    const indexes: IndexDefinition[] = [];

    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) { continue; }

      // Field line: name Type[]? attrs
      const fM = /^(\w+)\s+(\w+)(\[\])?([?!])?\s*(.*)$/.exec(trimmed);
      if (!fM) { continue; }
      const fieldName = fM[1];
      const prismaType = fM[2];
      const isList = !!fM[3];
      const isOptional = fM[4] === '?';
      const attrs = fM[5] ?? '';

      // Skip relation fields (type is a model name or enum handled below)
      if (modelTableMap[prismaType] !== undefined) {
        // Relation back-reference — set FK info on the owning side
        // Check if @relation has fields: [...] — if yes, it's back-ref, skip
        const relM = /@relation\s*\(([^)]*)\)/.exec(attrs);
        if (relM) {
          const relArgs = relM[1];
          if (!/fields\s*:/.test(relArgs)) {
            continue; // back-reference, no column
          }
          // Skip back-references: if fields: present, it's the owning side (column created separately below via field parsing loop — but we need the actual scalar field)
          continue;
        }
        continue;
      }

      // Map column name
      const colName = fieldMaps[fieldName] ?? fieldName;

      // Map type
      let sqlType: string;
      if (enumNames.has(prismaType)) {
        sqlType = `enum(${prismaType})`;
      } else {
        sqlType = PRISMA_SCALAR_MAP[prismaType] ?? prismaType.toLowerCase();
      }
      if (isList) { sqlType += '[]'; }

      // Attributes
      const isPk = /@id\b/.test(attrs);
      const isUniq = /@unique\b/.test(attrs);
      const defM = /@default\s*\(([^)]+)\)/.exec(attrs);
      let defaultValue: string | undefined;
      if (defM) {
        defaultValue = defM[1].trim().replace(/^["']|["']$/g, '');
      }

      columns[colName] = {
        name: colName,
        type: sqlType,
        nullable: isOptional,
        isPrimaryKey: isPk,
        isForeignKey: false,
        defaultValue,
      };

      if (isUniq) {
        indexes.push({ name: `uq_${tableName}_${colName}`, columns: [colName], isUnique: true });
      }
    }

    // Process @@id, @@unique, @@index
    const compositeIdM = /@@id\s*\(\s*\[([^\]]+)\]/.exec(body);
    if (compositeIdM) {
      for (const f of compositeIdM[1].split(',')) {
        const fn = f.trim();
        const cn = fieldMaps[fn] ?? fn;
        if (columns[cn]) { columns[cn].isPrimaryKey = true; columns[cn].nullable = false; }
      }
    }
    for (const m2 of body.matchAll(/@@unique\s*\(\s*\[([^\]]+)\]/g)) {
      const cols = m2[1].split(',').map(f => fieldMaps[f.trim()] ?? f.trim());
      indexes.push({ name: `uq_${tableName}_${cols.join('_')}`, columns: cols, isUnique: true });
    }
    for (const m2 of body.matchAll(/@@index\s*\(\s*\[([^\]]+)\]/g)) {
      const cols = m2[1].split(',').map(f => fieldMaps[f.trim()] ?? f.trim());
      indexes.push({ name: `idx_${tableName}_${cols.join('_')}`, columns: cols, isUnique: false });
    }

    // Process @relation fields to set FK on scalar fields
    for (const line of body.split('\n')) {
      const relM = /@relation\s*\(\s*fields\s*:\s*\[([^\]]+)\]\s*,\s*references\s*:\s*\[([^\]]+)\]/.exec(line);
      if (!relM) { continue; }
      const srcFields = relM[1].split(',').map(f => f.trim());
      const refFields = relM[2].split(',').map(f => f.trim());
      // Extract target model name from the line's type
      const typeM = /^\s*\w+\s+(\w+)/.exec(line);
      const targetModel = typeM ? typeM[1] : '';
      const targetTable = modelTableMap[targetModel] ?? targetModel;
      for (let i = 0; i < srcFields.length; i++) {
        const srcF = srcFields[i];
        const refF = refFields[i] ?? refFields[0];
        const srcCol = fieldMaps[srcF] ?? srcF;
        const refCol = modelFieldMaps[targetModel]?.[refF] ?? refF;
        if (columns[srcCol]) {
          columns[srcCol].isForeignKey = true;
          columns[srcCol].referencesTable = targetTable;
          columns[srcCol].referencesColumn = refCol;
        }
      }
    }

    tables[tableName] = { name: tableName, columns, indexes };
  }

  return tables;
}
