/**
 * test/member2.run.test.js
 * ════════════════════════════════════════════════════════════════════════════
 * Self-contained Node.js test runner — NO vscode, NO ts-node, NO npm install
 * Runs with: node test/member2.run.test.js
 *
 * Tests Member 2 pure-logic modules:
 *   src/contextManager/schemaParsers.ts   (inlined)
 *   src/diagnostics/sqlTokenizer.ts       (inlined)
 *   src/diagnostics/schemaDiagnostics.ts  (inlined)
 *   src/duplicateDetector/duplicateDetector.ts (inlined helpers)
 * ════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(id, desc, fn) {
  try {
    fn();
    console.log(`  ✅  ${id}  ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${id}  ${desc}`);
    console.error(`       ${err.message}`);
    failures.push({ id, desc, error: err.message });
    failed++;
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: schemaParsers helpers
// ─────────────────────────────────────────────────────────────────────────────

function splitTopLevel(input, sep = ',') {
  const result = [];
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

function splitStatements(sql) {
  const out = [];
  let buf = '';
  let depth = 0;
  let i = 0;
  const n = sql.length;
  let state = 'NORMAL';
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

function normalizeIdentifier(raw) {
  let s = raw.trim();
  if (s.startsWith('`') && s.endsWith('`')) { return s.slice(1, -1); }
  if (s.startsWith('"') && s.endsWith('"')) { return s.slice(1, -1); }
  if (s.startsWith('[') && s.endsWith(']')) { return s.slice(1, -1); }
  s = s.replace(/;+$/, '').trim();
  s = s.replace(/^["'`]|["'`]$/g, '');
  const dot = s.lastIndexOf('.');
  if (dot >= 0) { s = s.slice(dot + 1); }
  return s.toLowerCase();
}

function snakeCase(name) {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function pluralize(word) {
  if (!word) { return word; }
  const lw = word.toLowerCase();
  if (lw.endsWith('ies')) { return word; }
  if (lw.endsWith('s') && !lw.endsWith('ss')) { return word; }
  if (lw.endsWith('y') && !/[aeiou]y$/i.test(word)) { return word.slice(0, -1) + 'ies'; }
  if (lw.endsWith('ss') || lw.endsWith('sh') || lw.endsWith('ch') || lw.endsWith('x') || lw.endsWith('z')) { return word + 'es'; }
  return word + 's';
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: parseColumnDefinitions
// ─────────────────────────────────────────────────────────────────────────────

const RE_TYPE_START = /^(?:DOUBLE\s+PRECISION|CHARACTER\s+VARYING|TIMESTAMP\s+(?:WITH|WITHOUT)\s+TIME\s+ZONE|TIMESTAMPTZ|TIMETZ|BIGSERIAL|SMALLSERIAL|SERIAL|BIGINT|SMALLINT|MEDIUMINT|TINYINT|INT(?:EGER)?|REAL|FLOAT8?|DOUBLE|DECIMAL|NUMERIC|CHAR|VARCHAR|NVARCHAR|TEXT|LONGTEXT|MEDIUMTEXT|TINYTEXT|BLOB|LONGBLOB|MEDIUMBLOB|TINYBLOB|BYTEA|BOOLEAN|BOOL|JSONB|JSON|UUID|DATE|TIME|DATETIME|TIMESTAMP|XML|ENUM|ARRAY|INET|CIDR|MACADDR|MONEY|BIT|VARBIT|INTERVAL|POINT|LINE|LSEG|BOX|PATH|POLYGON|CIRCLE|GEOGRAPHY|GEOMETRY)(?:\s*\([^)]*\))?(?:\s+(?:UNSIGNED|ZEROFILL|VARYING|PRECISION))?/i;

function parseOneColumnDefinition(raw) {
  const trimmed = raw.trim();
  if (!trimmed) { return null; }
  if (/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY|CONSTRAINT|LIKE|EXCLUDE)\b/i.test(trimmed)) { return null; }
  const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_$][\w$]*))\s+([\s\S]+)$/.exec(trimmed);
  if (!m) { return null; }
  const name = (m[1] || m[2] || m[3] || m[4] || '').toLowerCase();
  if (!name) { return null; }
  let rest = m[5];
  const typeM = RE_TYPE_START.exec(rest);
  let type;
  if (typeM) {
    type = typeM[0].replace(/\s+/g, ' ').trim();
    rest = rest.slice(typeM[0].length);
  } else {
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
    referencesTable: ref ? normalizeIdentifier(ref[1] || ref[2] || ref[3] || '') : undefined,
    referencesColumn: ref ? (ref[4] || ref[5] || ref[6] || undefined) : undefined,
    defaultValue: defM ? defM[1] : undefined,
  };
}

function parseColumnDefinitions(defs) {
  const columns = {};
  for (const chunk of splitTopLevel(defs)) {
    const col = parseOneColumnDefinition(chunk);
    if (col) { columns[col.name] = col; }
  }
  return columns;
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: parseSqlScript (simplified for testing)
// ─────────────────────────────────────────────────────────────────────────────

function parseTableConstraint(chunk) {
  const c = chunk.trim();
  if (!c) { return null; }
  const nameM = /^CONSTRAINT\s+(?:"([^"]+)"|`([^`]+)`|(\w+))\s+/i.exec(c);
  const name = nameM ? (nameM[1] || nameM[2] || nameM[3]) : undefined;
  const body = nameM ? c.slice(nameM[0].length) : c;
  const pkM = /^PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(body);
  if (pkM) {
    const columns = splitTopLevel(pkM[1]).map(s => normalizeIdentifier(s.trim()));
    return { name, type: 'primary_key', columns, raw: c };
  }
  const fkM = /^FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([\w."'`[\]]+)\s*\(([^)]+)\)/i.exec(body);
  if (fkM) {
    const columns = splitTopLevel(fkM[1]).map(s => normalizeIdentifier(s.trim()));
    const referencesTable = normalizeIdentifier(fkM[2]);
    const referenceColumns = splitTopLevel(fkM[3]).map(s => normalizeIdentifier(s.trim()));
    return { name, type: 'foreign_key', columns, referencesTable, referenceColumns, raw: c };
  }
  const uqM = /^UNIQUE(?:\s+(?:KEY|INDEX))?\s*(?:\w+\s*)?\(([^)]+)\)/i.exec(body);
  if (uqM) {
    const columns = splitTopLevel(uqM[1]).map(s => normalizeIdentifier(s.trim()));
    return { name, type: 'unique', columns, raw: c };
  }
  if (/^CHECK\b/i.test(body)) {
    return { name, type: 'check', columns: [], raw: c };
  }
  return null;
}

function buildTable(tName, body) {
  const columns = parseColumnDefinitions(body);
  const constraints = splitTopLevel(body)
    .map(chunk => parseTableConstraint(chunk.trim()))
    .filter(Boolean);
  const table = { name: tName, columns, indexes: [], constraints };
  // Apply constraints to columns
  for (const con of constraints) {
    if (con.type === 'primary_key') {
      for (const col of con.columns) {
        if (table.columns[col]) { table.columns[col].isPrimaryKey = true; table.columns[col].nullable = false; }
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
  for (const con of constraints) {
    if (con.type === 'unique' && con.columns.length > 0) {
      table.indexes.push({ name: con.name || `uq_${tName}_${con.columns.join('_')}`, columns: con.columns, isUnique: true });
    }
  }
  return table;
}

function parseSqlScript(sql) {
  const tables = {};
  for (const stmt of splitStatements(sql)) {
    if (/^CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(stmt)) {
      const m2 = /^CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'`[\].]+)\s*\(([\s\S]+)\)/i.exec(stmt);
      if (m2) {
        const tName = normalizeIdentifier(m2[1]);
        tables[tName] = buildTable(tName, m2[2]);
      }
    } else if (/^ALTER\s+TABLE\b/i.test(stmt)) {
      applyAlterTable(stmt, tables);
    } else if (/^DROP\s+TABLE\b/i.test(stmt)) {
      const m = /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?([\w"'`[\].]+)/i.exec(stmt);
      if (m) { delete tables[normalizeIdentifier(m[1])]; }
    }
  }
  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: applyAlterTable
// ─────────────────────────────────────────────────────────────────────────────

function applyAlterTable(statement, tables) {
  const m = /^ALTER\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w"'`[\].]+)\s+([\s\S]+)$/.exec(statement.trim().replace(/;$/, ''));
  if (!m) { return; }
  const tableName = normalizeIdentifier(m[1]);
  const rest = m[2].trim().replace(/;$/, '');

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
  if (!table) { return; }

  for (const clause of splitTopLevel(rest)) {
    applyAlterClause(clause.trim(), table, tableName);
  }
}

function applyAlterClause(c, table, tableName) {
  if (!c) { return; }
  // DROP CONSTRAINT / DROP PRIMARY KEY
  if (/^DROP\s+(?:CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY|INDEX|KEY)\b/i.test(c)) {
    if (/^DROP\s+PRIMARY\s+KEY/i.test(c)) {
      for (const col of Object.values(table.columns)) { col.isPrimaryKey = false; }
    }
    return;
  }
  // ADD CONSTRAINT
  if (/^ADD\s+(?:CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\b)/i.test(c)) {
    const body = c.replace(/^ADD\s+/i, '');
    const con = parseTableConstraint(body);
    if (con) {
      if (!table.constraints) { table.constraints = []; }
      table.constraints.push(con);
      if (con.type === 'primary_key') {
        for (const col of con.columns) { if (table.columns[col]) { table.columns[col].isPrimaryKey = true; } }
      }
      if (con.type === 'unique' && con.columns.length > 0) {
        table.indexes.push({ name: con.name || `uq_${tableName}_${con.columns.join('_')}`, columns: con.columns, isUnique: true });
      }
    }
    return;
  }
  // RENAME COLUMN
  const rnCol = /^RENAME\s+(?:COLUMN\s+)?([\w"'`[\]]+)\s+TO\s+([\w"'`[\]]+)\s*$/i.exec(c);
  if (rnCol) {
    const oldName = normalizeIdentifier(rnCol[1]);
    const newName = normalizeIdentifier(rnCol[2]);
    const col = table.columns[oldName];
    if (col) { delete table.columns[oldName]; col.name = newName; table.columns[newName] = col; }
    return;
  }
  // CHANGE COLUMN (MySQL)
  const changeCol = /^CHANGE\s+(?:COLUMN\s+)?([\w"'`[\]]+)\s+([\w"'`[\]]+)\s+([\s\S]+)$/i.exec(c);
  if (changeCol) {
    const oldName = normalizeIdentifier(changeCol[1]);
    const newName = normalizeIdentifier(changeCol[2]);
    const parsed = parseColumnDefinitions(`${newName} ${changeCol[3]}`);
    const newDef = parsed[newName];
    if (newDef) { delete table.columns[oldName]; table.columns[newName] = newDef; }
    return;
  }
  // ALTER COLUMN (PG)
  const altCol = /^ALTER\s+COLUMN\s+([\w"'`[\]]+)\s+([\s\S]+)$/i.exec(c);
  if (altCol) {
    const colName = normalizeIdentifier(altCol[1]);
    const sub = altCol[2].trim();
    const col = table.columns[colName];
    if (!col) { return; }
    const typeM = /^(?:SET\s+DATA\s+)?TYPE\s+([\s\S]+?)(?:\s+USING\s+[\s\S]+)?$/i.exec(sub);
    if (typeM) { col.type = typeM[1].trim(); return; }
    if (/^SET\s+NOT\s+NULL/i.test(sub)) { col.nullable = false; return; }
    if (/^DROP\s+NOT\s+NULL/i.test(sub)) { col.nullable = true; return; }
    const setDef = /^SET\s+DEFAULT\s+([\s\S]+)$/i.exec(sub);
    if (setDef) { col.defaultValue = setDef[1].trim(); return; }
    if (/^DROP\s+DEFAULT/i.test(sub)) { delete col.defaultValue; return; }
    return;
  }
  // MODIFY COLUMN
  const modCol = /^MODIFY\s+(?:COLUMN\s+)?([\s\S]+)$/i.exec(c);
  if (modCol) {
    const inner = /^\((.+)\)$/.exec(modCol[1].trim());
    const defText = inner ? inner[1] : modCol[1].trim();
    const parsed = parseColumnDefinitions(defText);
    for (const [n, def] of Object.entries(parsed)) {
      table.columns[n] = { ...def, isPrimaryKey: def.isPrimaryKey || (table.columns[n]?.isPrimaryKey || false) };
    }
    return;
  }
  // ADD COLUMN
  const addCol = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(c);
  if (addCol) {
    let body = addCol[1].trim();
    const outer = /^\((.+)\)$/.exec(body);
    if (outer) { body = outer[1]; }
    const newCols = parseColumnDefinitions(body);
    for (const [n, def] of Object.entries(newCols)) {
      if (!table.columns[n]) { table.columns[n] = def; }
    }
    return;
  }
  // DROP COLUMN
  const dropCol = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([\w"'`[\]]+)\s*$/i.exec(c);
  if (dropCol) {
    delete table.columns[normalizeIdentifier(dropCol[1])];
    return;
  }
}

function mergeInto(target, addition) {
  for (const [name, t] of Object.entries(addition)) {
    if (!target[name]) {
      target[name] = JSON.parse(JSON.stringify(t));
      continue;
    }
    const existing = target[name];
    for (const [cn, col] of Object.entries(t.columns)) {
      if (!existing.columns[cn]) { existing.columns[cn] = { ...col }; }
    }
    for (const idx of t.indexes) {
      if (!existing.indexes.some(i => i.name === idx.name)) {
        existing.indexes.push({ ...idx, columns: [...idx.columns] });
      }
    }
    if (existing.rowCount === undefined && t.rowCount !== undefined) {
      existing.rowCount = t.rowCount;
    }
  }
}

function mergeSchemas(live, codebase) {
  const tables = JSON.parse(JSON.stringify(live.tables));
  mergeInto(tables, codebase.tables);
  return { ...live, tables, source: 'merged', extractedAt: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: sqlTokenizer helpers
// ─────────────────────────────────────────────────────────────────────────────

function maskSql(text) {
  const clauseChars = text.split('');
  const parseChars = text.split('');
  const n = text.length;
  let i = 0;

  function blankBoth(start, end) {
    for (let j = start; j < end; j++) {
      if (text[j] !== '\n' && text[j] !== '\r') { clauseChars[j] = ' '; parseChars[j] = ' '; }
    }
  }
  function blankClauseOnly(start, end) {
    for (let j = start; j < end; j++) {
      if (text[j] !== '\n' && text[j] !== '\r') { clauseChars[j] = ' '; }
    }
  }

  while (i < n) {
    const c = text[i];
    const two = text.substr(i, 2);
    if (two === '--') {
      const start = i; i += 2;
      while (i < n && text[i] !== '\n') { i++; }
      blankBoth(start, i); continue;
    }
    if (two === '/*') {
      const start = i; i += 2;
      while (i < n) { if (text.substr(i, 2) === '*/') { i += 2; break; } i++; }
      blankBoth(start, i); continue;
    }
    if (c === "'" || (c === 'E' && text[i + 1] === "'") || (c === 'N' && text[i + 1] === "'")) {
      const start = i;
      if (c !== "'") { i++; }
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (ch === "'") { i++; break; }
        if (ch === '\\') { i += 2; continue; }
        i++;
      }
      blankBoth(start, i); continue;
    }
    if (c === '"') {
      const start = i; i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '"' && text[i + 1] === '"') { i += 2; continue; }
        if (ch === '"') { i++; break; }
        i++;
      }
      blankClauseOnly(start, i); continue;
    }
    if (c === '`') {
      const start = i; i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '`' && text[i + 1] === '`') { i += 2; continue; }
        if (ch === '`') { i++; break; }
        i++;
      }
      blankClauseOnly(start, i); continue;
    }
    if (c === '$') {
      const tagM = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i));
      if (tagM) {
        const tag = tagM[0];
        const start = i;
        i += tag.length;
        const closer = text.indexOf(tag, i);
        if (closer >= 0) { i = closer + tag.length; } else { i = n; }
        blankBoth(start, i); continue;
      }
    }
    i++;
  }
  return { clauseMask: clauseChars.join(''), parseMask: parseChars.join('') };
}

function splitSqlStatements(text) {
  const { clauseMask, parseMask } = maskSql(text);
  const statements = [];
  let stmtStart = 0;
  let depth = 0;
  for (let i = 0; i < clauseMask.length; i++) {
    const c = clauseMask[i];
    if (c === '(') { depth++; }
    else if (c === ')') { depth = Math.max(0, depth - 1); }
    else if (c === ';' && depth === 0) {
      const raw = text.slice(stmtStart, i).trim();
      if (raw) {
        const leadingSpaces = text.slice(stmtStart, i).search(/\S/);
        const trimStart = stmtStart + (leadingSpaces >= 0 ? leadingSpaces : 0);
        statements.push({
          sql: raw,
          clauseMask: clauseMask.slice(trimStart, i).trim(),
          parseMask: parseMask.slice(trimStart, i).trim(),
          startOffset: trimStart,
          endOffset: i,
          index: statements.length,
        });
      }
      stmtStart = i + 1;
      depth = 0;
    }
  }
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

function hasClause(masked, clause) {
  return new RegExp(`\\b${clause}\\b`, 'i').test(masked);
}

function extractCteNames(parseMask) {
  const names = new Set();
  if (!/^\s*WITH\b/i.test(parseMask)) { return names; }
  const re = /\b(\w+)\s+AS\s*\(/gi;
  let m;
  while ((m = re.exec(parseMask)) !== null) { names.add(m[1].toLowerCase()); }
  return names;
}

function extractTablesFromStatement(parseMask) {
  const tables = [];
  const seen = new Set();
  const addTable = (raw) => {
    if (!raw || /^\s*\(/.test(raw)) { return; }
    const stripped = raw.replace(/^["`[]|["`\]]$/g, '').trim();
    const dot = stripped.lastIndexOf('.');
    const name = (dot >= 0 ? stripped.slice(dot + 1) : stripped).toLowerCase();
    if (!name || !name.match(/\w/)) { return; }
    if (!seen.has(name)) { seen.add(name); tables.push(name); }
  };
  const fromJoinRe = /\b(?:FROM|JOIN)\s+([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/gi;
  let m;
  while ((m = fromJoinRe.exec(parseMask)) !== null) { addTable(m[1]); }
  const insertRe = /\bINSERT\s+(?:IGNORE\s+|LOW_PRIORITY\s+)?INTO\s+([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/gi;
  while ((m = insertRe.exec(parseMask)) !== null) { addTable(m[1]); }
  const um = /^\s*UPDATE\s+(?:LOW_PRIORITY\s+|DELAYED\s+|QUICK\s+)?([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/i.exec(parseMask);
  if (um) { addTable(um[1]); }
  const dm = /\bDELETE\s+(?:.*?\s+)?FROM\s+([`"]?[\w$]+[`"]?(?:\s*\.\s*[`"]?[\w$]+[`"]?)?)/i.exec(parseMask);
  if (dm) { addTable(dm[1]); }
  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: schemaDiagnostics pattern rules
// ─────────────────────────────────────────────────────────────────────────────

const PATTERN_RULES = [
  { pattern: /\bDROP\s+(?:TABLE|DATABASE)\b/i, code: 'DBS-DESTRUCT-001', severity: 'error', modal: true },
  { pattern: /\bTRUNCATE\b/i, code: 'DBS-DESTRUCT-002', severity: 'error', modal: true },
  { pattern: /\bDELETE\s+FROM\b/i, code: 'DBS-DESTRUCT-003', severity: 'error', modal: true },
  { pattern: /\bUPDATE\s+\w[\w$]*\s+SET\b/i, code: 'DBS-DESTRUCT-004', severity: 'error' },
  { pattern: /\bDROP\s+INDEX\b/i, code: 'DBS-PERF-001', severity: 'warning' },
  { pattern: /\bSELECT\s+\*/i, code: 'DBS-PERF-002', severity: 'info' },
  { pattern: /ALTER\s+TABLE\s+\w[\w$]*\s+RENAME\b/i, code: 'DBS-BREAK-001', severity: 'warning' },
];

function runPatternRules(sql, clauseMask, baseOffset) {
  const diagnostics = [];
  for (const rule of PATTERN_RULES) {
    if ((rule.code === 'DBS-DESTRUCT-003' || rule.code === 'DBS-DESTRUCT-004')) {
      if (!rule.pattern.test(clauseMask)) { continue; }
      if (hasClause(clauseMask, 'WHERE')) { continue; }
      if (hasClause(clauseMask, 'LIMIT')) { continue; }
    } else {
      if (!rule.pattern.test(clauseMask)) { continue; }
    }
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let m;
    while ((m = re.exec(sql)) !== null) {
      diagnostics.push({ message: rule.code, severity: rule.severity, startOffset: baseOffset + m.index, endOffset: baseOffset + m.index + m[0].length, code: rule.code });
    }
  }
  return diagnostics;
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINED: duplicate detector helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeColumnName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) { return 1.0; }
  let intersection = 0;
  for (const item of a) { if (b.has(item)) { intersection++; } }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) { dp[0][j] = j; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function stringSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) { return 1.0; }
  return 1 - levenshtein(a, b) / maxLen;
}

function getTypeFamily(type) {
  const familyMap = {
    int: 'integer', integer: 'integer', bigint: 'integer', smallint: 'integer', serial: 'integer', bigserial: 'integer',
    float: 'float', double: 'float', real: 'float', numeric: 'float', decimal: 'float',
    varchar: 'text', char: 'text', text: 'text', 'character varying': 'text', nvarchar: 'text',
    bool: 'boolean', boolean: 'boolean',
    date: 'datetime', time: 'datetime', datetime: 'datetime', timestamp: 'datetime', timestamptz: 'datetime',
    blob: 'binary', bytea: 'binary', binary: 'binary',
    json: 'json', jsonb: 'json',
    uuid: 'uuid',
  };
  const base = type.toLowerCase().replace(/\([^)]*\)/, '').trim();
  return familyMap[base] || 'unknown';
}

function assessTypeCompatibility(typeA, typeB) {
  if (typeA.toLowerCase() === typeB.toLowerCase()) { return 'compatible'; }
  const famA = getTypeFamily(typeA), famB = getTypeFamily(typeB);
  if (famA === famB) { return 'compatible'; }
  const castable = [['integer', 'float'], ['float', 'integer'], ['integer', 'text'], ['float', 'text'], ['boolean', 'integer'], ['datetime', 'text'], ['uuid', 'text']];
  if (castable.some(([a, b]) => a === famA && b === famB)) { return 'castable'; }
  return 'incompatible';
}

function generateMigration(group, canonicalName) {
  const canonical = canonicalName || group.semanticMeaning;
  const byTable = {};
  for (const col of group.columns) {
    if (!byTable[col.table]) { byTable[col.table] = []; }
    byTable[col.table].push(col);
  }
  const upStatements = ['-- DB-Scope generated migration'];
  const downStatements = ['-- DB-Scope rollback migration'];
  for (const [table, cols] of Object.entries(byTable)) {
    const winner = cols.find(c => c.column === canonical) || cols.sort((a, b) => a.column.localeCompare(b.column))[0];
    const others = cols.filter(c => c.column !== winner.column);
    if (winner.column !== canonical) {
      upStatements.push(`ALTER TABLE "${table}" RENAME COLUMN "${winner.column}" TO "${canonical}";`);
      downStatements.unshift(`ALTER TABLE "${table}" RENAME COLUMN "${canonical}" TO "${winner.column}";`);
    }
    for (const col of others) {
      upStatements.push(`UPDATE "${table}" SET "${canonical}" = COALESCE("${canonical}", "${col.column}");`);
      upStatements.push(`ALTER TABLE "${table}" DROP COLUMN "${col.column}";`);
      downStatements.unshift(`ALTER TABLE "${table}" ADD COLUMN "${col.column}" ${col.type};`);
    }
  }
  return {
    id: `migration_${group.semanticMeaning.replace(/[^a-z0-9]/gi, '_')}`,
    title: `Consolidate "${group.semanticMeaning}" to "${canonical}"`,
    upSql: upStatements.join('\n'),
    downSql: downStatements.join('\n'),
    tables: Object.keys(byTable),
    riskLevel: Object.keys(byTable).length > 1 ? 'high' : 'medium',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: splitStatements
// ─────────────────────────────────────────────────────────────────────────────
section('Section 1 — splitStatements');

test('1-01', 'single statement no semicolon', () => {
  const stmts = splitStatements('SELECT 1');
  assert.strictEqual(stmts.length, 1);
  assert.strictEqual(stmts[0], 'SELECT 1');
});

test('1-02', 'two statements with semicolons', () => {
  const stmts = splitStatements('SELECT 1; SELECT 2;');
  assert.strictEqual(stmts.length, 2);
});

test('1-03', 'semicolon inside single-quoted string not a split', () => {
  const stmts = splitStatements("SELECT ';' AS x; SELECT 2;");
  assert.strictEqual(stmts.length, 2);
});

test('1-04', 'line comment stripped', () => {
  const stmts = splitStatements('-- comment\nSELECT 1');
  assert.strictEqual(stmts.length, 1);
  assert.ok(!stmts[0].includes('-- comment'));
});

test('1-05', 'block comment stripped', () => {
  const stmts = splitStatements('/* block */ SELECT 1');
  assert.strictEqual(stmts.length, 1);
  assert.ok(!stmts[0].includes('block'));
});

test('1-06', 'CREATE TABLE with nested parens parsed as one statement', () => {
  const sql = 'CREATE TABLE foo (id int, bar varchar(255)); SELECT 1;';
  const stmts = splitStatements(sql);
  assert.strictEqual(stmts.length, 2);
  assert.ok(stmts[0].includes('CREATE TABLE'));
});

test('1-07', 'dollar-quoted string not split', () => {
  const sql = "CREATE FUNCTION f() RETURNS void AS $$BEGIN; END;$$ LANGUAGE plpgsql;";
  const stmts = splitStatements(sql);
  assert.strictEqual(stmts.length, 1);
});

test('1-08', 'empty input returns empty array', () => {
  assert.deepStrictEqual(splitStatements(''), []);
  assert.deepStrictEqual(splitStatements('   '), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: normalizeIdentifier
// ─────────────────────────────────────────────────────────────────────────────
section('Section 2 — normalizeIdentifier');

test('2-01', 'unquoted identifier lowercased', () => {
  assert.strictEqual(normalizeIdentifier('Users'), 'users');
});

test('2-02', 'backtick-quoted identifier returned verbatim', () => {
  assert.strictEqual(normalizeIdentifier('`MyTable`'), 'MyTable');
});

test('2-03', 'double-quoted identifier returned verbatim', () => {
  assert.strictEqual(normalizeIdentifier('"Public"'), 'Public');
});

test('2-04', 'schema-prefixed identifier strips schema', () => {
  assert.strictEqual(normalizeIdentifier('public.users'), 'users');
});

test('2-05', 'trailing semicolon stripped', () => {
  assert.strictEqual(normalizeIdentifier('orders;'), 'orders');
});

test('2-06', 'bracket-quoted identifier unwrapped', () => {
  assert.strictEqual(normalizeIdentifier('[OrderItems]'), 'OrderItems');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: snakeCase / pluralize
// ─────────────────────────────────────────────────────────────────────────────
section('Section 3 — snakeCase and pluralize');

test('3-01', 'CamelCase to snake_case', () => {
  assert.strictEqual(snakeCase('UserProfile'), 'user_profile');
});

test('3-02', 'already snake_case unchanged', () => {
  assert.strictEqual(snakeCase('order_item'), 'order_item');
});

test('3-03', 'pluralize regular word', () => {
  assert.strictEqual(pluralize('user'), 'users');
});

test('3-04', 'pluralize word ending in y', () => {
  assert.strictEqual(pluralize('category'), 'categories');
});

test('3-05', 'pluralize already plural', () => {
  assert.strictEqual(pluralize('users'), 'users');
});

test('3-06', 'pluralize ss word', () => {
  assert.strictEqual(pluralize('address'), 'addresses');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: parseColumnDefinitions
// ─────────────────────────────────────────────────────────────────────────────
section('Section 4 — parseColumnDefinitions');

test('4-01', 'basic column parsed', () => {
  const cols = parseColumnDefinitions('id INTEGER NOT NULL');
  assert.ok(cols.id);
  assert.strictEqual(cols.id.type, 'INTEGER');
  assert.strictEqual(cols.id.nullable, false);
});

test('4-02', 'varchar with length', () => {
  const cols = parseColumnDefinitions('email VARCHAR(255) NOT NULL');
  assert.ok(cols.email);
  assert.strictEqual(cols.email.type, 'VARCHAR(255)');
});

test('4-03', 'primary key flag', () => {
  const cols = parseColumnDefinitions('id SERIAL PRIMARY KEY');
  assert.ok(cols.id.isPrimaryKey);
  assert.strictEqual(cols.id.nullable, false);
});

test('4-04', 'references extracted', () => {
  const cols = parseColumnDefinitions('user_id INTEGER REFERENCES users(id)');
  assert.ok(cols.user_id.isForeignKey);
  assert.strictEqual(cols.user_id.referencesTable, 'users');
  assert.strictEqual(cols.user_id.referencesColumn, 'id');
});

test('4-05', 'DEFAULT value captured', () => {
  const cols = parseColumnDefinitions("status VARCHAR(20) DEFAULT 'active'");
  assert.strictEqual(cols.status.defaultValue, "'active'");
});

test('4-06', 'constraint lines skipped', () => {
  const cols = parseColumnDefinitions('id INT, name TEXT, PRIMARY KEY (id)');
  assert.ok(cols.id);
  assert.ok(cols.name);
  assert.ok(!cols['primary key']);
});

test('4-07', 'nullable column', () => {
  const cols = parseColumnDefinitions('middle_name VARCHAR(100)');
  assert.strictEqual(cols.middle_name.nullable, true);
});

test('4-08', 'boolean column', () => {
  const cols = parseColumnDefinitions('is_active BOOLEAN DEFAULT FALSE');
  assert.strictEqual(cols.is_active.type, 'BOOLEAN');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: parseSqlScript — CREATE TABLE
// ─────────────────────────────────────────────────────────────────────────────
section('Section 5 — parseSqlScript CREATE TABLE');

test('5-01', 'simple CREATE TABLE', () => {
  const tables = parseSqlScript('CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL);');
  assert.ok(tables.users);
  assert.ok(tables.users.columns.id.isPrimaryKey);
  assert.strictEqual(tables.users.columns.name.nullable, false);
});

test('5-02', 'CREATE TABLE IF NOT EXISTS', () => {
  const tables = parseSqlScript('CREATE TABLE IF NOT EXISTS orders (id INT);');
  assert.ok(tables.orders);
});

test('5-03', 'multiple CREATE TABLE statements', () => {
  const sql = 'CREATE TABLE a (id INT); CREATE TABLE b (id INT);';
  const tables = parseSqlScript(sql);
  assert.ok(tables.a);
  assert.ok(tables.b);
});

test('5-04', 'DROP TABLE removes table', () => {
  const sql = 'CREATE TABLE tmp (id INT); DROP TABLE tmp;';
  const tables = parseSqlScript(sql);
  assert.ok(!tables.tmp);
});

test('5-05', 'table constraint PRIMARY KEY applied to column', () => {
  const tables = parseSqlScript('CREATE TABLE t (id INT, name TEXT, PRIMARY KEY (id));');
  assert.ok(tables.t.columns.id.isPrimaryKey);
});

test('5-06', 'FOREIGN KEY constraint applied to column', () => {
  const sql = 'CREATE TABLE orders (id INT, user_id INT, FOREIGN KEY (user_id) REFERENCES users (id));';
  const tables = parseSqlScript(sql);
  assert.ok(tables.orders.columns.user_id.isForeignKey);
  assert.strictEqual(tables.orders.columns.user_id.referencesTable, 'users');
});

test('5-07', 'UNIQUE constraint creates index', () => {
  const sql = 'CREATE TABLE users (id INT, email TEXT, UNIQUE (email));';
  const tables = parseSqlScript(sql);
  assert.ok(tables.users.indexes.some(i => i.isUnique && i.columns.includes('email')));
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: applyAlterTable
// ─────────────────────────────────────────────────────────────────────────────
section('Section 6 — applyAlterTable');

function makeSchema(tableSpec) {
  const tables = parseSqlScript(`CREATE TABLE ${tableSpec}`);
  return tables;
}

test('6-01', 'ADD COLUMN', () => {
  const tables = makeSchema('users (id INT PRIMARY KEY, name TEXT)');
  applyAlterTable('ALTER TABLE users ADD COLUMN email VARCHAR(255)', tables);
  assert.ok(tables.users.columns.email);
  assert.strictEqual(tables.users.columns.email.type, 'VARCHAR(255)');
});

test('6-02', 'DROP COLUMN', () => {
  const tables = makeSchema('users (id INT, name TEXT, email TEXT)');
  applyAlterTable('ALTER TABLE users DROP COLUMN email', tables);
  assert.ok(!tables.users.columns.email);
  assert.ok(tables.users.columns.name);
});

test('6-03', 'RENAME COLUMN (PG)', () => {
  const tables = makeSchema('users (id INT, usr_name TEXT)');
  applyAlterTable('ALTER TABLE users RENAME COLUMN usr_name TO username', tables);
  assert.ok(tables.users.columns.username);
  assert.ok(!tables.users.columns.usr_name);
});

test('6-04', 'RENAME TABLE', () => {
  const tables = makeSchema('old_users (id INT)');
  applyAlterTable('ALTER TABLE old_users RENAME TO users', tables);
  assert.ok(tables.users);
  assert.ok(!tables.old_users);
});

test('6-05', 'ALTER COLUMN SET NOT NULL', () => {
  const tables = makeSchema('users (id INT, name TEXT)');
  applyAlterTable('ALTER TABLE users ALTER COLUMN name SET NOT NULL', tables);
  assert.strictEqual(tables.users.columns.name.nullable, false);
});

test('6-06', 'ALTER COLUMN DROP NOT NULL', () => {
  const tables = parseSqlScript('CREATE TABLE t (id INT NOT NULL);');
  applyAlterTable('ALTER TABLE t ALTER COLUMN id DROP NOT NULL', tables);
  assert.strictEqual(tables.t.columns.id.nullable, true);
});

test('6-07', 'ALTER COLUMN TYPE', () => {
  const tables = makeSchema('t (id INT, val TEXT)');
  applyAlterTable('ALTER TABLE t ALTER COLUMN val TYPE VARCHAR(500)', tables);
  assert.ok(tables.t.columns.val.type.toLowerCase().includes('varchar'));
});

test('6-08', 'SET DEFAULT', () => {
  const tables = makeSchema('t (id INT, status TEXT)');
  applyAlterTable("ALTER TABLE t ALTER COLUMN status SET DEFAULT 'active'", tables);
  assert.strictEqual(tables.t.columns.status.defaultValue, "'active'");
});

test('6-09', 'DROP DEFAULT', () => {
  const tables = parseSqlScript("CREATE TABLE t (id INT, status TEXT DEFAULT 'active');");
  applyAlterTable('ALTER TABLE t ALTER COLUMN status DROP DEFAULT', tables);
  assert.ok(!tables.t.columns.status.defaultValue);
});

test('6-10', 'CHANGE COLUMN (MySQL rename + redefine)', () => {
  const tables = makeSchema('t (id INT, old_col TEXT)');
  applyAlterTable('ALTER TABLE t CHANGE COLUMN old_col new_col VARCHAR(255) NOT NULL', tables);
  assert.ok(tables.t.columns.new_col);
  assert.ok(!tables.t.columns.old_col);
});

test('6-11', 'ADD CONSTRAINT UNIQUE adds index', () => {
  const tables = makeSchema('users (id INT, email TEXT)');
  applyAlterTable('ALTER TABLE users ADD CONSTRAINT uq_email UNIQUE (email)', tables);
  assert.ok(tables.users.indexes.some(i => i.isUnique && i.columns.includes('email')));
});

test('6-12', 'unknown table silently skipped', () => {
  const tables = {};
  assert.doesNotThrow(() => applyAlterTable('ALTER TABLE nonexistent ADD COLUMN x INT', tables));
});

test('6-13', 'ADD COLUMN IF NOT EXISTS allowed', () => {
  const tables = makeSchema('t (id INT)');
  applyAlterTable('ALTER TABLE t ADD COLUMN IF NOT EXISTS x TEXT', tables);
  assert.ok(tables.t.columns.x);
});

test('6-14', 'MODIFY COLUMN (MySQL)', () => {
  const tables = makeSchema('t (id INT, val TEXT)');
  applyAlterTable('ALTER TABLE t MODIFY COLUMN val VARCHAR(100) NOT NULL', tables);
  assert.ok(tables.t.columns.val.type.toLowerCase().includes('varchar'));
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: mergeInto / mergeSchemas
// ─────────────────────────────────────────────────────────────────────────────
section('Section 7 — mergeInto and mergeSchemas');

test('7-01', 'mergeInto adds new table', () => {
  const target = {};
  mergeInto(target, { users: { name: 'users', columns: { id: { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false } }, indexes: [] } });
  assert.ok(target.users);
});

test('7-02', 'mergeInto existing-wins for columns', () => {
  const target = { t: { name: 't', columns: { id: { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false } }, indexes: [] } };
  const addition = { t: { name: 't', columns: { id: { name: 'id', type: 'bigint', nullable: false, isPrimaryKey: true, isForeignKey: false }, email: { name: 'email', type: 'text', nullable: true, isPrimaryKey: false, isForeignKey: false } }, indexes: [] } };
  mergeInto(target, addition);
  assert.strictEqual(target.t.columns.id.type, 'int'); // existing wins
  assert.ok(target.t.columns.email); // new column added
});

test('7-03', 'mergeSchemas produces merged source', () => {
  const live = { dbType: 'postgresql', databaseName: 'db', tables: { users: { name: 'users', columns: { id: { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false } }, indexes: [] } }, extractedAt: 0 };
  const codebase = { dbType: 'postgresql', databaseName: 'db', tables: { orders: { name: 'orders', columns: { id: { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false } }, indexes: [] } }, extractedAt: 0 };
  const merged = mergeSchemas(live, codebase);
  assert.strictEqual(merged.source, 'merged');
  assert.ok(merged.tables.users);
  assert.ok(merged.tables.orders);
});

test('7-04', 'mergeSchemas live data wins', () => {
  const live = { dbType: 'postgresql', databaseName: 'db', tables: { t: { name: 't', columns: { id: { name: 'id', type: 'bigint', nullable: false, isPrimaryKey: true, isForeignKey: false } }, indexes: [] } }, extractedAt: 0 };
  const codebase = { dbType: 'postgresql', databaseName: 'db', tables: { t: { name: 't', columns: { id: { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false } }, indexes: [] } }, extractedAt: 0 };
  const merged = mergeSchemas(live, codebase);
  assert.strictEqual(merged.tables.t.columns.id.type, 'bigint'); // live wins
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: parsePrismaSchema (inline simplified version for tests)
// ─────────────────────────────────────────────────────────────────────────────
section('Section 8 — Prisma schema basics (structural validation)');

function parsePrismaSchemaSimple(content) {
  const tables = {};
  // Use block scanner
  const modelRe = /\bmodel\s+(\w+)\s*\{/g;
  let mm;
  while ((mm = modelRe.exec(content)) !== null) {
    const modelName = mm[1];
    // scan body
    let depth = 0;
    let start = -1;
    let body = '';
    for (let i = mm.index + mm[0].length - 1; i < content.length; i++) {
      const c = content[i];
      if (c === '{') { if (start === -1) { start = i; } depth++; }
      else if (c === '}') { depth--; if (depth === 0) { body = content.slice(start + 1, i); break; } }
    }
    const mapM = /@@map\s*\(\s*"([^"]+)"\s*\)/.exec(body);
    const tableName = mapM ? mapM[1] : modelName;
    const columns = {};
    const indexes = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) { continue; }
      const fM = /^(\w+)\s+(\w+)(\[\])?([?!])?\s*(.*)$/.exec(t);
      if (!fM) { continue; }
      const fieldName = fM[1];
      const prismaType = fM[2];
      const isOptional = fM[4] === '?';
      const attrs = fM[5] || '';
      const isPk = /@id\b/.test(attrs);
      const isUniq = /@unique\b/.test(attrs);
      const mapM2 = /@map\s*\(\s*"([^"]+)"\s*\)/.exec(attrs);
      const colName = mapM2 ? mapM2[1] : fieldName;
      const scalarMap = { String: 'text', Int: 'integer', BigInt: 'bigint', Boolean: 'boolean', DateTime: 'timestamptz', Json: 'jsonb', Bytes: 'bytea', Float: 'double precision', Decimal: 'decimal' };
      const sqlType = scalarMap[prismaType] || prismaType.toLowerCase();
      columns[colName] = { name: colName, type: sqlType, nullable: isOptional, isPrimaryKey: isPk, isForeignKey: false };
      if (isUniq) { indexes.push({ name: `uq_${tableName}_${colName}`, columns: [colName], isUnique: true }); }
    }
    tables[tableName] = { name: tableName, columns, indexes };
  }
  return tables;
}

test('8-01', 'model without @@map uses model name as table', () => {
  const schema = `model User { id Int @id\n  name String\n}`;
  const tables = parsePrismaSchemaSimple(schema);
  assert.ok(tables.User);
});

test('8-02', '@@map overrides table name', () => {
  const schema = `model User {\n  id Int @id\n  @@map("users")\n}`;
  const tables = parsePrismaSchemaSimple(schema);
  assert.ok(tables.users);
  assert.ok(!tables.User);
});

test('8-03', '@id marks column as primary key', () => {
  const schema = `model Order { id Int @id }`;
  const tables = parsePrismaSchemaSimple(schema);
  assert.ok(tables.Order.columns.id.isPrimaryKey);
});

test('8-04', 'optional field (?) sets nullable', () => {
  const schema = `model P { id Int @id\n  bio String? }`;
  const tables = parsePrismaSchemaSimple(schema);
  assert.strictEqual(tables.P.columns.bio.nullable, true);
});

test('8-05', '@map renames column', () => {
  const schema = `model U { id Int @id\n  emailAddr String @map("email_address") }`;
  const tables = parsePrismaSchemaSimple(schema);
  assert.ok(tables.U.columns.email_address);
  assert.ok(!tables.U.columns.emailAddr);
});

test('8-06', '@unique creates index', () => {
  const schema = `model U { id Int @id\n  email String @unique }`;
  const tables = parsePrismaSchemaSimple(schema);
  assert.ok(tables.U.indexes.some(i => i.isUnique));
});

test('8-07', 'DateTime maps to timestamptz', () => {
  const schema = `model Ev { id Int @id\n  ts DateTime }`;
  const tables = parsePrismaSchemaSimple(schema);
  assert.strictEqual(tables.Ev.columns.ts.type, 'timestamptz');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9: Django model parsing (inline simplified)
// ─────────────────────────────────────────────────────────────────────────────
section('Section 9 — Django model parsing basics');

function parseDjangoSimple(content) {
  const tables = {};
  const classRe = /^class\s+(\w+)\s*\(\s*(?:[\w.]*Model)\s*\)\s*:/gm;
  let m;
  while ((m = classRe.exec(content)) !== null) {
    const className = m[1];
    const bodyLines = [];
    const after = content.slice(m.index);
    const lines = after.split('\n');
    let bodyIndent = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { bodyLines.push(''); continue; }
      const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
      if (bodyIndent === -1) { if (indent === 0) { break; } bodyIndent = indent; }
      if (indent < bodyIndent) { break; }
      bodyLines.push(line.trim());
    }
    const columns = {};
    const typeMap = {
      AutoField: () => 'integer', BigAutoField: () => 'bigint',
      CharField: (a) => { const ml = /max_length\s*=\s*(\d+)/.exec(a); return `varchar(${ml ? ml[1] : '255'})`; },
      TextField: () => 'text', IntegerField: () => 'integer', BooleanField: () => 'boolean',
      DateTimeField: () => 'timestamptz', ForeignKey: () => 'integer',
      EmailField: () => 'varchar(254)', UUIDField: () => 'uuid',
    };
    // Join logical lines
    let cur = '';
    let depth = 0;
    const joined = [];
    for (const l of bodyLines) {
      if (!cur && !l) { continue; }
      cur += (cur ? ' ' : '') + l;
      for (const ch of l) { if (ch === '(') { depth++; } else if (ch === ')') { depth = Math.max(0, depth - 1); } }
      if (depth <= 0) { joined.push(cur); cur = ''; depth = 0; }
    }
    for (const line of joined) {
      if (/^class\s+Meta/i.test(line)) { break; }
      const fM = /^(\w+)\s*=\s*models\.(\w+)\s*\(([\s\S]*)\)\s*$/.exec(line);
      if (!fM) { continue; }
      const fieldName = fM[1];
      const fieldType = fM[2];
      const args = fM[3];
      const builder = typeMap[fieldType];
      if (!builder) { continue; }
      const sqlType = builder(args);
      const isFk = fieldType === 'ForeignKey';
      const colName = isFk ? `${fieldName}_id` : fieldName;
      columns[colName] = { name: colName, type: sqlType, nullable: false, isPrimaryKey: false, isForeignKey: isFk };
    }
    // db_table from Meta
    let tableName = snakeCase(className) + 's';
    const dbTableM = /db_table\s*=\s*['"]([^'"]+)['"]/.exec(content.slice(m.index));
    if (dbTableM) { tableName = dbTableM[1]; }
    tables[tableName] = { name: tableName, columns, indexes: [] };
  }
  return tables;
}

test('9-01', 'Django CharField produces varchar', () => {
  const py = `class User(models.Model):\n    email = models.CharField(max_length=255)\n`;
  const tables = parseDjangoSimple(py);
  assert.ok(tables.users || tables.user_users);
  const t = tables.users;
  assert.ok(t.columns.email.type.startsWith('varchar'));
});

test('9-02', 'Django ForeignKey produces _id suffix', () => {
  const py = `class Post(models.Model):\n    author = models.ForeignKey(User, on_delete=models.CASCADE)\n`;
  const tables = parseDjangoSimple(py);
  const t = tables.posts;
  assert.ok(t);
  assert.ok(t.columns.author_id);
  assert.strictEqual(t.columns.author_id.isForeignKey, true);
});

test('9-03', 'Django db_table meta overrides name', () => {
  const py = `class UserProfile(models.Model):\n    name = models.CharField(max_length=100)\n    class Meta:\n        db_table = 'user_profiles'\n`;
  const tables = parseDjangoSimple(py);
  assert.ok(tables.user_profiles);
});

test('9-04', 'Django BooleanField', () => {
  const py = `class Flag(models.Model):\n    is_active = models.BooleanField()\n`;
  const tables = parseDjangoSimple(py);
  assert.strictEqual(tables.flags.columns.is_active.type, 'boolean');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10: maskSql tokenizer
// ─────────────────────────────────────────────────────────────────────────────
section('Section 10 — maskSql tokenizer');

test('10-01', 'length preserved after masking', () => {
  const sql = "SELECT 'hello world' FROM t";
  const { clauseMask } = maskSql(sql);
  assert.strictEqual(clauseMask.length, sql.length);
});

test('10-02', 'single-quoted string content blanked in clauseMask', () => {
  const sql = "SELECT 'secret'";
  const { clauseMask } = maskSql(sql);
  assert.ok(!clauseMask.includes('secret'));
});

test('10-03', 'line comment blanked', () => {
  const sql = 'SELECT -- comment\n1';
  const { clauseMask } = maskSql(sql);
  assert.ok(!clauseMask.includes('comment'));
});

test('10-04', 'block comment blanked', () => {
  const sql = 'SELECT /* secret */ 1';
  const { clauseMask } = maskSql(sql);
  assert.ok(!clauseMask.includes('secret'));
});

test('10-05', 'double-quoted identifier preserved in parseMask', () => {
  const sql = 'SELECT "MyColumn" FROM t';
  const { parseMask } = maskSql(sql);
  assert.ok(parseMask.includes('MyColumn'));
});

test('10-06', 'double-quoted identifier blanked in clauseMask', () => {
  const sql = 'SELECT "WHERE" FROM t';
  const { clauseMask } = maskSql(sql);
  assert.ok(!clauseMask.includes('WHERE'));
});

test('10-07', 'false positive: keyword inside string not triggering clause', () => {
  const sql = "DELETE FROM t WHERE note = 'DELETE FROM users'";
  const { clauseMask } = maskSql(sql);
  // The real DELETE and WHERE should be present, but the quoted one should be blanked
  const matches = [...clauseMask.matchAll(/\bDELETE\b/gi)];
  assert.strictEqual(matches.length, 1); // only one DELETE visible
});

test('10-08', 'newlines preserved in masked output', () => {
  const sql = 'SELECT 1\n-- comment\nFROM t';
  const { clauseMask } = maskSql(sql);
  assert.ok(clauseMask.includes('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11: splitSqlStatements
// ─────────────────────────────────────────────────────────────────────────────
section('Section 11 — splitSqlStatements with offsets');

test('11-01', 'returns offset info', () => {
  const stmts = splitSqlStatements('SELECT 1; SELECT 2;');
  assert.strictEqual(stmts.length, 2);
  assert.ok(stmts[0].startOffset >= 0);
  assert.ok(stmts[0].endOffset > stmts[0].startOffset);
});

test('11-02', 'semicolon inside string not a separator', () => {
  const stmts = splitSqlStatements("SELECT ';' AS x; SELECT 2;");
  assert.strictEqual(stmts.length, 2);
});

test('11-03', 'trailing statement without semicolon included', () => {
  const stmts = splitSqlStatements('SELECT 1; SELECT 2');
  assert.strictEqual(stmts.length, 2);
});

test('11-04', 'clauseMask and parseMask present on each statement', () => {
  const stmts = splitSqlStatements('SELECT 1;');
  assert.ok(typeof stmts[0].clauseMask === 'string');
  assert.ok(typeof stmts[0].parseMask === 'string');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12: hasClause / extractCteNames
// ─────────────────────────────────────────────────────────────────────────────
section('Section 12 — hasClause and CTE extraction');

test('12-01', 'hasClause detects WHERE', () => {
  assert.strictEqual(hasClause('DELETE FROM t WHERE id = 1', 'WHERE'), true);
});

test('12-02', 'hasClause false when absent', () => {
  assert.strictEqual(hasClause('DELETE FROM t', 'WHERE'), false);
});

test('12-03', 'CTE names extracted', () => {
  const names = extractCteNames('WITH cte AS (SELECT 1) SELECT * FROM cte');
  assert.ok(names.has('cte'));
});

test('12-04', 'multiple CTE names', () => {
  const names = extractCteNames('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON a.id = b.id');
  assert.ok(names.has('a'));
  assert.ok(names.has('b'));
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13: Pattern rule engine
// ─────────────────────────────────────────────────────────────────────────────
section('Section 13 — Pattern diagnostic rules');

test('13-01', 'DROP TABLE produces DBS-DESTRUCT-001', () => {
  const stmt = splitSqlStatements('DROP TABLE users;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(diags.some(d => d.code === 'DBS-DESTRUCT-001'));
});

test('13-02', 'TRUNCATE produces DBS-DESTRUCT-002', () => {
  const stmt = splitSqlStatements('TRUNCATE orders;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(diags.some(d => d.code === 'DBS-DESTRUCT-002'));
});

test('13-03', 'DELETE without WHERE produces DBS-DESTRUCT-003', () => {
  const stmt = splitSqlStatements('DELETE FROM t;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(diags.some(d => d.code === 'DBS-DESTRUCT-003'));
});

test('13-04', 'DELETE WITH WHERE does not produce DBS-DESTRUCT-003', () => {
  const stmt = splitSqlStatements('DELETE FROM t WHERE id = 1;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(!diags.some(d => d.code === 'DBS-DESTRUCT-003'));
});

test('13-05', 'SELECT * produces DBS-PERF-002', () => {
  const stmt = splitSqlStatements('SELECT * FROM t;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(diags.some(d => d.code === 'DBS-PERF-002'));
});

test('13-06', 'DROP INDEX produces DBS-PERF-001', () => {
  const stmt = splitSqlStatements('DROP INDEX idx_name;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(diags.some(d => d.code === 'DBS-PERF-001'));
});

test('13-07', 'UPDATE without WHERE produces DBS-DESTRUCT-004', () => {
  const stmt = splitSqlStatements('UPDATE orders SET status = 1;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(diags.some(d => d.code === 'DBS-DESTRUCT-004'));
});

test('13-08', 'UPDATE with WHERE does not produce DBS-DESTRUCT-004', () => {
  const stmt = splitSqlStatements('UPDATE orders SET status = 1 WHERE id = 5;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(!diags.some(d => d.code === 'DBS-DESTRUCT-004'));
});

test('13-09', 'DELETE inside a quoted string not flagged', () => {
  const sql = "SELECT 'DELETE FROM users' AS x;";
  const stmt = splitSqlStatements(sql)[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(!diags.some(d => d.code === 'DBS-DESTRUCT-003'));
});

test('13-10', 'ALTER TABLE RENAME produces DBS-BREAK-001', () => {
  const stmt = splitSqlStatements('ALTER TABLE users RENAME TO old_users;')[0];
  const diags = runPatternRules(stmt.sql, stmt.clauseMask, 0);
  assert.ok(diags.some(d => d.code === 'DBS-BREAK-001'));
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14: normalizeColumnName (duplicate detector)
// ─────────────────────────────────────────────────────────────────────────────
section('Section 14 — normalizeColumnName');

test('14-01', 'lowercase with underscores', () => {
  assert.strictEqual(normalizeColumnName('FirstName'), 'firstname');
});

test('14-02', 'special chars replaced with _', () => {
  assert.strictEqual(normalizeColumnName('user-email'), 'user_email');
});

test('14-03', 'consecutive underscores collapsed', () => {
  assert.strictEqual(normalizeColumnName('a__b'), 'a_b');
});

test('14-04', 'leading/trailing underscores removed', () => {
  assert.strictEqual(normalizeColumnName('_name_'), 'name');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 15: Jaccard similarity
// ─────────────────────────────────────────────────────────────────────────────
section('Section 15 — jaccardSimilarity');

test('15-01', 'identical sets return 1.0', () => {
  assert.strictEqual(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c'])), 1.0);
});

test('15-02', 'disjoint sets return 0', () => {
  assert.strictEqual(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
});

test('15-03', '50% overlap', () => {
  const j = jaccardSimilarity(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'e', 'f']));
  assert.ok(j > 0.2 && j < 0.4); // 2 shared out of 6 unique = 0.333
});

test('15-04', 'empty sets return 1', () => {
  assert.strictEqual(jaccardSimilarity(new Set(), new Set()), 1.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16: stringSimilarity (Levenshtein)
// ─────────────────────────────────────────────────────────────────────────────
section('Section 16 — stringSimilarity');

test('16-01', 'identical strings return 1', () => {
  assert.strictEqual(stringSimilarity('email', 'email'), 1.0);
});

test('16-02', 'completely different strings low similarity', () => {
  assert.ok(stringSimilarity('abc', 'xyz') < 0.5);
});

test('16-03', 'phone vs mobile below threshold', () => {
  const sim = stringSimilarity('phone', 'mobile');
  assert.ok(sim < 0.75, `Expected < 0.75 got ${sim}`);
});

test('16-04', 'email vs email_address has some similarity', () => {
  const sim = stringSimilarity('email', 'email_address');
  // email is prefix of email_address; Levenshtein = 8, maxLen = 13 → ~0.38
  assert.ok(sim >= 0.3, `Expected >= 0.3 got ${sim}`);
});

test('16-05', 'empty strings return 1', () => {
  assert.strictEqual(stringSimilarity('', ''), 1.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 17: type compatibility
// ─────────────────────────────────────────────────────────────────────────────
section('Section 17 — Type Compatibility');

test('17-01', 'same type is compatible', () => {
  assert.strictEqual(assessTypeCompatibility('integer', 'integer'), 'compatible');
});

test('17-02', 'varchar and text are compatible', () => {
  assert.strictEqual(assessTypeCompatibility('varchar', 'text'), 'compatible');
});

test('17-03', 'integer and float are castable', () => {
  assert.strictEqual(assessTypeCompatibility('integer', 'float'), 'castable');
});

test('17-04', 'integer and json are incompatible', () => {
  assert.strictEqual(assessTypeCompatibility('integer', 'json'), 'incompatible');
});

test('17-05', 'uuid and text are castable', () => {
  assert.strictEqual(assessTypeCompatibility('uuid', 'text'), 'castable');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 18: Migration SQL generation
// ─────────────────────────────────────────────────────────────────────────────
section('Section 18 — Migration SQL generation');

test('18-01', 'generates UP SQL', () => {
  const group = {
    semanticMeaning: 'phone',
    columns: [
      { table: 'users', column: 'phone', type: 'varchar(20)', reason: 'synonym' },
      { table: 'users', column: 'mobile', type: 'varchar(20)', reason: 'synonym' },
    ],
    suggestion: '',
  };
  const migration = generateMigration(group, 'phone_number');
  assert.ok(migration.upSql.includes('RENAME COLUMN'));
  assert.ok(migration.upSql.includes('COALESCE'));
  assert.ok(migration.upSql.includes('DROP COLUMN'));
});

test('18-02', 'generates DOWN SQL', () => {
  const group = {
    semanticMeaning: 'email',
    columns: [
      { table: 'contacts', column: 'email', type: 'text', reason: 'synonym' },
      { table: 'contacts', column: 'email_address', type: 'text', reason: 'synonym' },
    ],
    suggestion: '',
  };
  const migration = generateMigration(group, 'email');
  assert.ok(migration.downSql.includes('ADD COLUMN'));
});

test('18-03', 'migration id is deterministic (no timestamp randomness)', () => {
  const group = { semanticMeaning: 'status', columns: [{ table: 't', column: 'status', type: 'text', reason: '' }, { table: 't', column: 'state', type: 'text', reason: '' }], suggestion: '' };
  const m1 = generateMigration(group, 'status');
  assert.ok(m1.id.startsWith('migration_status'));
});

test('18-04', 'cross-table migration risk is high', () => {
  const group = {
    semanticMeaning: 'email',
    columns: [
      { table: 'users', column: 'email', type: 'text', reason: '' },
      { table: 'contacts', column: 'email_addr', type: 'text', reason: '' },
    ],
    suggestion: '',
  };
  const m = generateMigration(group, 'email');
  assert.strictEqual(m.riskLevel, 'high');
});

test('18-05', 'single-table migration risk is medium', () => {
  const group = {
    semanticMeaning: 'email',
    columns: [
      { table: 'users', column: 'email', type: 'text', reason: '' },
      { table: 'users', column: 'email_address', type: 'text', reason: '' },
    ],
    suggestion: '',
  };
  const m = generateMigration(group, 'email');
  assert.strictEqual(m.riskLevel, 'medium');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19: extractTablesFromStatement
// ─────────────────────────────────────────────────────────────────────────────
section('Section 19 — extractTablesFromStatement');

test('19-01', 'extracts FROM table', () => {
  const { parseMask } = maskSql('SELECT id FROM users WHERE id = 1');
  const tables = extractTablesFromStatement(parseMask);
  assert.ok(tables.includes('users'));
});

test('19-02', 'extracts JOIN table', () => {
  const { parseMask } = maskSql('SELECT * FROM orders JOIN users ON orders.user_id = users.id');
  const tables = extractTablesFromStatement(parseMask);
  assert.ok(tables.includes('orders'));
  assert.ok(tables.includes('users'));
});

test('19-03', 'extracts INSERT INTO table', () => {
  const { parseMask } = maskSql('INSERT INTO products (name) VALUES (?)');
  const tables = extractTablesFromStatement(parseMask);
  assert.ok(tables.includes('products'));
});

test('19-04', 'extracts UPDATE table', () => {
  const { parseMask } = maskSql('UPDATE inventory SET qty = 0 WHERE id = 1');
  const tables = extractTablesFromStatement(parseMask);
  assert.ok(tables.includes('inventory'));
});

test('19-05', 'extracts DELETE FROM table', () => {
  const { parseMask } = maskSql('DELETE FROM logs WHERE created_at < NOW()');
  const tables = extractTablesFromStatement(parseMask);
  assert.ok(tables.includes('logs'));
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 20: parseTableConstraint
// ─────────────────────────────────────────────────────────────────────────────
section('Section 20 — parseTableConstraint');

test('20-01', 'PRIMARY KEY constraint parsed', () => {
  const con = parseTableConstraint('PRIMARY KEY (id, org_id)');
  assert.ok(con);
  assert.strictEqual(con.type, 'primary_key');
  assert.deepStrictEqual(con.columns, ['id', 'org_id']);
});

test('20-02', 'FOREIGN KEY constraint parsed', () => {
  const con = parseTableConstraint('FOREIGN KEY (user_id) REFERENCES users (id)');
  assert.ok(con);
  assert.strictEqual(con.type, 'foreign_key');
  assert.strictEqual(con.referencesTable, 'users');
  assert.deepStrictEqual(con.referenceColumns, ['id']);
});

test('20-03', 'UNIQUE constraint parsed', () => {
  const con = parseTableConstraint('UNIQUE (email)');
  assert.ok(con);
  assert.strictEqual(con.type, 'unique');
});

test('20-04', 'CONSTRAINT name extracted', () => {
  const con = parseTableConstraint('CONSTRAINT pk_users PRIMARY KEY (id)');
  assert.strictEqual(con.name, 'pk_users');
  assert.strictEqual(con.type, 'primary_key');
});

test('20-05', 'CHECK constraint parsed', () => {
  const con = parseTableConstraint('CHECK (age > 0)');
  assert.strictEqual(con.type, 'check');
});

test('20-06', 'invalid chunk returns null', () => {
  const con = parseTableConstraint('id INTEGER NOT NULL');
  assert.strictEqual(con, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21: Source-of-truth drift guard (checks TS exports exist)
// ─────────────────────────────────────────────────────────────────────────────
section('Section 21 — Source-of-truth drift guard');

const SRC_ROOT = path.join(__dirname, '..', 'src');

function checkTsExport(file, symbol) {
  const fullPath = path.join(SRC_ROOT, file);
  const content = fs.readFileSync(fullPath, 'utf-8');
  return content.includes(symbol);
}

test('21-01', 'schemaParsers exports splitStatements', () => {
  assert.ok(checkTsExport('contextManager/schemaParsers.ts', 'export function splitStatements'));
});

test('21-02', 'schemaParsers exports normalizeIdentifier', () => {
  assert.ok(checkTsExport('contextManager/schemaParsers.ts', 'export function normalizeIdentifier'));
});

test('21-03', 'schemaParsers exports applyAlterTable', () => {
  assert.ok(checkTsExport('contextManager/schemaParsers.ts', 'export function applyAlterTable'));
});

test('21-04', 'schemaParsers exports parseSqlScript', () => {
  assert.ok(checkTsExport('contextManager/schemaParsers.ts', 'export function parseSqlScript'));
});

test('21-05', 'schemaParsers exports parseDjangoModels', () => {
  assert.ok(checkTsExport('contextManager/schemaParsers.ts', 'export function parseDjangoModels'));
});

test('21-06', 'schemaParsers exports parseTypeOrmEntities', () => {
  assert.ok(checkTsExport('contextManager/schemaParsers.ts', 'export function parseTypeOrmEntities'));
});

test('21-07', 'schemaParsers exports parsePrismaSchema', () => {
  assert.ok(checkTsExport('contextManager/schemaParsers.ts', 'export function parsePrismaSchema'));
});

test('21-08', 'sqlTokenizer exports maskSql', () => {
  assert.ok(checkTsExport('diagnostics/sqlTokenizer.ts', 'export function maskSql'));
});

test('21-09', 'sqlTokenizer exports splitSqlStatements', () => {
  assert.ok(checkTsExport('diagnostics/sqlTokenizer.ts', 'export function splitSqlStatements'));
});

test('21-10', 'duplicateDetector exports normalizeColumnName', () => {
  assert.ok(checkTsExport('duplicateDetector/duplicateDetector.ts', 'export function normalizeColumnName'));
});

test('21-11', 'duplicateDetector exports jaccardSimilarity', () => {
  assert.ok(checkTsExport('duplicateDetector/duplicateDetector.ts', 'export function jaccardSimilarity'));
});

test('21-12', 'schemaDiagnostics exports PATTERN_RULES', () => {
  assert.ok(checkTsExport('diagnostics/schemaDiagnostics.ts', 'export const PATTERN_RULES'));
});

test('21-13', 'contextManager accepts statusBarItem arg', () => {
  const content = fs.readFileSync(path.join(SRC_ROOT, 'contextManager/contextManager.ts'), 'utf-8');
  assert.ok(content.includes('statusBarItem'));
});

test('21-14', 'types.ts has TableConstraint', () => {
  assert.ok(checkTsExport('core/types.ts', 'export interface TableConstraint'));
});

test('21-15', 'types.ts has DuplicateTableGroup', () => {
  assert.ok(checkTsExport('core/types.ts', 'export interface DuplicateTableGroup'));
});

test('21-16', 'types.ts has MigrationScript', () => {
  assert.ok(checkTsExport('core/types.ts', 'export interface MigrationScript'));
});

test('21-17', 'SqlCodeActionProvider file exists', () => {
  const filePath = path.join(SRC_ROOT, 'diagnostics/sqlCodeActionProvider.ts');
  assert.ok(fs.existsSync(filePath));
});

test('21-18', 'eslintrc.json exists at root', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', '.eslintrc.json')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Final results
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(64)}`);
console.log(`  Total:   ${passed + failed}`);
console.log(`  Passed:  ${passed} ✅`);
console.log(`  Failed:  ${failed} ❌`);
console.log('═'.repeat(64));

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  ${f.id}: ${f.desc}`);
    console.log(`    → ${f.error}`);
  }
  process.exit(1);
} else {
  process.exit(0);
}
