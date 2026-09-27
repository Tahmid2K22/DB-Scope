"use strict";
// src/mergeAnalyzer/mergeAnalyzer.ts
// Member 3 — Database Merge Conflict Analyzer
// Detects structural conflicts when merging two database schemas.
// Identifies type mismatches, name conflicts, nullable differences,
// and missing tables/columns. Suggests reconciliation SQL.
// Optionally enriches results via IBM Bob Shell for repository-level
// semantic reasoning (rename detection, affected files/symbols, etc.).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MergeAnalyzer = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../utils/logger");
const bobBridge_1 = require("./bobBridge");
class MergeAnalyzer {
    constructor(schemaState) {
        this.schemaState = schemaState;
        this.logger = logger_1.Logger.getInstance();
    }
    // ──────────────────────────────────────────────
    // Entry point: prompt user to select two schema files, then analyze
    // ──────────────────────────────────────────────
    async promptAndAnalyze() {
        const options = {
            canSelectMany: false,
            filters: { 'SQL or JSON Schema': ['sql', 'json'] },
            openLabel: 'Select Schema A',
        };
        const fileAUris = await vscode.window.showOpenDialog(options);
        if (!fileAUris || fileAUris.length === 0) {
            return null;
        }
        const fileBUris = await vscode.window.showOpenDialog({ ...options, openLabel: 'Select Schema B' });
        if (!fileBUris || fileBUris.length === 0) {
            return null;
        }
        const docA = await vscode.workspace.openTextDocument(fileAUris[0]);
        const docB = await vscode.workspace.openTextDocument(fileBUris[0]);
        const schemaA = this.parseSchemaFile(docA.getText(), 'Database_A');
        const schemaB = this.parseSchemaFile(docB.getText(), 'Database_B');
        // Run deterministic analysis first — this always succeeds regardless of Bob
        const deterministicResult = this.analyze(schemaA, schemaB);
        // Attempt Bob enrichment only when there are conflicts worth reasoning about
        const semanticConflicts = (0, bobBridge_1.filterSemanticallyRelevant)(deterministicResult.conflicts);
        if (semanticConflicts.length === 0) {
            return deterministicResult;
        }
        return this.enrichWithBob(deterministicResult, semanticConflicts);
    }
    /**
     * Core analysis: compare schemaA and schemaB and produce a MergeAnalysisResult.
     */
    analyze(schemaA, schemaB) {
        this.logger.info(`MergeAnalyzer: comparing ${Object.keys(schemaA.tables).length} vs ${Object.keys(schemaB.tables).length} tables`);
        const conflicts = [];
        // 1. Tables in A missing from B
        for (const tableName of Object.keys(schemaA.tables)) {
            if (!schemaB.tables[tableName]) {
                conflicts.push({
                    table: tableName,
                    conflictType: 'missing_table',
                    sourceA: `Table "${tableName}" exists in Database A`,
                    sourceB: `Table "${tableName}" does NOT exist in Database B`,
                    suggestion: `Add CREATE TABLE ${tableName} to Database B or merge its definition`,
                    reconciliationSql: this.generateCreateTableSql(schemaA.tables[tableName]),
                });
            }
        }
        // 2. Tables in B missing from A
        for (const tableName of Object.keys(schemaB.tables)) {
            if (!schemaA.tables[tableName]) {
                conflicts.push({
                    table: tableName,
                    conflictType: 'missing_table',
                    sourceA: `Table "${tableName}" does NOT exist in Database A`,
                    sourceB: `Table "${tableName}" exists in Database B`,
                    suggestion: `Add CREATE TABLE ${tableName} to Database A or merge its definition`,
                    reconciliationSql: this.generateCreateTableSql(schemaB.tables[tableName]),
                });
            }
        }
        // 3. Compare columns in shared tables
        for (const tableName of Object.keys(schemaA.tables)) {
            if (!schemaB.tables[tableName]) {
                continue;
            }
            const tableConflicts = this.compareColumns(tableName, schemaA.tables[tableName], schemaB.tables[tableName]);
            conflicts.push(...tableConflicts);
        }
        // 4. Build reconciled schema and SQL
        const unifiedSchema = this.buildUnifiedSchema(schemaA, schemaB);
        const reconciledSql = this.generateReconciledSql(conflicts, unifiedSchema);
        this.logger.info(`MergeAnalyzer: found ${conflicts.length} conflict(s)`);
        return {
            schemaA,
            schemaB,
            conflicts,
            reconciledSql,
            unifiedSchema,
            mergedAt: Date.now(),
        };
    }
    // ──────────────────────────────────────────────
    // Bob enrichment — wraps deterministic result with
    // repository-level semantic analysis from Bob Shell.
    // Gracefully degrades: if Bob is unavailable or fails,
    // the original deterministicResult is returned unchanged.
    // ──────────────────────────────────────────────
    async enrichWithBob(base, semanticConflicts) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            this.logger.warn('MergeAnalyzer: no workspace folder — skipping Bob enrichment');
            return base;
        }
        const prompt = (0, bobBridge_1.buildBobPrompt)(workspaceRoot, semanticConflicts, base.schemaA, base.schemaB);
        let bobResult;
        try {
            bobResult = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'DB-Scope: Bob is analyzing repository references...',
                cancellable: false,
            }, () => (0, bobBridge_1.invokeBobForMergeAnalysis)(prompt, workspaceRoot));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error('MergeAnalyzer: Bob invocation threw unexpectedly', err);
            vscode.window.showWarningMessage(`DB-Scope: Unexpected error during Bob analysis (${msg}). Deterministic results preserved.`);
            return base;
        }
        if (!bobResult.available) {
            this.logger.warn(`MergeAnalyzer: Bob unavailable — ${bobResult.error}`);
            vscode.window.showInformationMessage('DB-Scope: IBM Bob Shell was not found. ' +
                'Deterministic schema analysis complete; repository-level semantic analysis was skipped.');
            return base;
        }
        if (bobResult.error) {
            this.logger.warn(`MergeAnalyzer: Bob error — ${bobResult.error}`);
            vscode.window.showWarningMessage(`DB-Scope: ${bobResult.error}`);
            // Return base — do NOT crash if Bob had a partial failure
            if (bobResult.resolutions.length === 0) {
                return base;
            }
        }
        // Merge Bob's resolutions into the deterministic conflict list
        const enrichedConflicts = this.applyBobResolutions(base.conflicts, bobResult.resolutions);
        // Regenerate reconciled SQL with enriched conflict suggestions
        const enrichedSql = this.generateReconciledSql(enrichedConflicts, base.unifiedSchema);
        this.logger.info(`MergeAnalyzer: Bob enriched ${bobResult.resolutions.length} of ${semanticConflicts.length} semantic conflict(s)`);
        return {
            ...base,
            conflicts: enrichedConflicts,
            reconciledSql: enrichedSql,
            bobResolutions: bobResult.resolutions,
        };
    }
    /**
     * Merges Bob's resolution objects back into the deterministic MergeConflict list.
     * For each conflict that Bob resolved, the suggestion is replaced with Bob's reason
     * and migration plan, and the reconciliation SQL is annotated.
     * All conflicts not covered by Bob are returned unchanged.
     */
    applyBobResolutions(conflicts, resolutions) {
        // Index resolutions by conflictId for O(1) lookup
        const byId = new Map();
        for (const r of resolutions) {
            byId.set(r.conflictId, r);
        }
        return conflicts.map(conflict => {
            const id = (0, bobBridge_1.conflictId)(conflict);
            const r = byId.get(id);
            if (!r) {
                return conflict;
            }
            // Build a richer suggestion from Bob's analysis
            const confidencePct = Math.round(r.confidence * 100);
            const affectedSummary = r.affectedFiles.length > 0
                ? ` Affects ${r.affectedFiles.length} file(s): ${r.affectedFiles.slice(0, 3).map(f => f.path).join(', ')}${r.affectedFiles.length > 3 ? '...' : ''}.`
                : '';
            const migrationSummary = r.migrationPlan.length > 0
                ? `\n-- Migration: ${r.migrationPlan.join(' → ')}`
                : '';
            const enrichedSuggestion = `[Bob ${confidencePct}% confidence — ${r.resolution}] ${r.reason}${affectedSummary}`;
            // Annotate reconciliation SQL with Bob's migration plan
            const enrichedSql = `${migrationSummary}\n${conflict.reconciliationSql}`.trimStart();
            return {
                ...conflict,
                suggestion: enrichedSuggestion,
                reconciliationSql: enrichedSql,
            };
        });
    }
    // ──────────────────────────────────────────────
    // Column-level comparison
    // ──────────────────────────────────────────────
    compareColumns(tableName, tableA, tableB) {
        const conflicts = [];
        // Columns in A not in B
        for (const colName of Object.keys(tableA.columns)) {
            if (!tableB.columns[colName]) {
                conflicts.push({
                    table: tableName,
                    column: colName,
                    conflictType: 'missing_column',
                    sourceA: `Column "${colName}" (${tableA.columns[colName].type}) exists in A`,
                    sourceB: `Column "${colName}" does not exist in B`,
                    suggestion: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableA.columns[colName].type}`,
                    reconciliationSql: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableA.columns[colName].type};`,
                });
                continue;
            }
            const colA = tableA.columns[colName];
            const colB = tableB.columns[colName];
            // Type mismatch
            if (!this.typesCompatible(colA.type, colB.type)) {
                conflicts.push({
                    table: tableName,
                    column: colName,
                    conflictType: 'type_mismatch',
                    sourceA: `${tableName}.${colName} is ${colA.type} in A`,
                    sourceB: `${tableName}.${colName} is ${colB.type} in B`,
                    suggestion: this.suggestTypeResolution(colA.type, colB.type),
                    reconciliationSql: this.generateTypeCastSql(tableName, colName, colA.type, colB.type),
                });
            }
            // Nullable difference
            if (colA.nullable !== colB.nullable) {
                const toNullable = colA.nullable ? 'A (nullable)' : 'B (nullable)';
                conflicts.push({
                    table: tableName,
                    column: colName,
                    conflictType: 'nullable_difference',
                    sourceA: `${tableName}.${colName} is ${colA.nullable ? 'NULLABLE' : 'NOT NULL'} in A`,
                    sourceB: `${tableName}.${colName} is ${colB.nullable ? 'NULLABLE' : 'NOT NULL'} in B`,
                    suggestion: `Use the more permissive definition (NULLABLE) to avoid data loss. Use ${toNullable}.`,
                    reconciliationSql: `ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP NOT NULL;`,
                });
            }
        }
        // Columns in B not in A
        for (const colName of Object.keys(tableB.columns)) {
            if (!tableA.columns[colName]) {
                conflicts.push({
                    table: tableName,
                    column: colName,
                    conflictType: 'missing_column',
                    sourceA: `Column "${colName}" does not exist in A`,
                    sourceB: `Column "${colName}" (${tableB.columns[colName].type}) exists in B`,
                    suggestion: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableB.columns[colName].type}`,
                    reconciliationSql: `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${tableB.columns[colName].type};`,
                });
            }
        }
        return conflicts;
    }
    // ──────────────────────────────────────────────
    // Unified Schema Builder
    // ──────────────────────────────────────────────
    buildUnifiedSchema(a, b) {
        const tables = {};
        // Merge all tables from A
        for (const [name, table] of Object.entries(a.tables)) {
            tables[name] = { ...table, columns: { ...table.columns } };
        }
        // Merge tables from B — add missing columns/tables
        for (const [name, tableB] of Object.entries(b.tables)) {
            if (!tables[name]) {
                tables[name] = { ...tableB, columns: { ...tableB.columns } };
                continue;
            }
            // Merge columns: prefer NULLABLE (more permissive)
            for (const [colName, colB] of Object.entries(tableB.columns)) {
                if (!tables[name].columns[colName]) {
                    tables[name].columns[colName] = colB;
                }
                else {
                    const colA = tables[name].columns[colName];
                    tables[name].columns[colName] = {
                        ...colA,
                        nullable: colA.nullable || colB.nullable, // prefer nullable
                        type: this.preferredType(colA.type, colB.type),
                    };
                }
            }
        }
        return {
            dbType: a.dbType,
            databaseName: `${a.databaseName}_merged_${b.databaseName}`,
            tables,
            extractedAt: Date.now(),
        };
    }
    // ──────────────────────────────────────────────
    // SQL Generators
    // ──────────────────────────────────────────────
    generateCreateTableSql(table) {
        const cols = Object.values(table.columns)
            .map(c => {
            let def = `  ${c.name} ${c.type}`;
            if (!c.nullable) {
                def += ' NOT NULL';
            }
            if (c.isPrimaryKey) {
                def += ' PRIMARY KEY';
            }
            return def;
        })
            .join(',\n');
        return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${cols}\n);`;
    }
    generateTypeCastSql(table, column, typeA, typeB) {
        const preferred = this.preferredType(typeA, typeB);
        return `-- WARNING: Type mismatch detected for ${table}.${column} (${typeA} vs ${typeB})\n` +
            `-- Preferred type: ${preferred}\n` +
            `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${preferred} USING ${column}::${preferred};`;
    }
    generateReconciledSql(conflicts, unified) {
        const lines = [
            '-- ============================================================',
            '-- DB-Scope: Reconciliation SQL (Auto-generated)',
            `-- Generated at: ${new Date().toISOString()}`,
            '-- Review carefully before executing against production!',
            '-- ============================================================',
            '',
        ];
        for (const conflict of conflicts) {
            lines.push(`-- Conflict: [${conflict.conflictType.toUpperCase()}] ${conflict.table}${conflict.column ? '.' + conflict.column : ''}`);
            lines.push(`-- ${conflict.suggestion}`);
            lines.push(conflict.reconciliationSql);
            lines.push('');
        }
        return lines.join('\n');
    }
    // ──────────────────────────────────────────────
    // Type helpers
    // ──────────────────────────────────────────────
    typesCompatible(a, b) {
        const normalize = (t) => t.toLowerCase().replace(/\([^)]+\)/, '').trim();
        const na = normalize(a);
        const nb = normalize(b);
        if (na === nb) {
            return true;
        }
        // Compatible groups
        const intGroup = ['int', 'integer', 'bigint', 'smallint', 'tinyint', 'serial', 'bigserial'];
        const floatGroup = ['float', 'double', 'real', 'decimal', 'numeric'];
        const strGroup = ['varchar', 'text', 'char', 'nvarchar', 'nchar', 'character varying'];
        const groups = [intGroup, floatGroup, strGroup];
        return groups.some(g => g.includes(na) && g.includes(nb));
    }
    preferredType(a, b) {
        // Prefer the more general/larger type
        const order = ['bigint', 'integer', 'smallint', 'text', 'varchar', 'char', 'double', 'float', 'decimal'];
        const na = a.toLowerCase().replace(/\([^)]+\)/, '').trim();
        const nb = b.toLowerCase().replace(/\([^)]+\)/, '').trim();
        const ia = order.indexOf(na);
        const ib = order.indexOf(nb);
        if (ia === -1) {
            return a;
        }
        if (ib === -1) {
            return b;
        }
        return ia <= ib ? a : b; // lower index = more general
    }
    suggestTypeResolution(a, b) {
        const preferred = this.preferredType(a, b);
        return `Use "${preferred}" as the canonical type to avoid data loss. Cast the other side: USING column::${preferred}`;
    }
    // ──────────────────────────────────────────────
    // Schema file parser (SQL or JSON)
    // ──────────────────────────────────────────────
    parseSchemaFile(content, name) {
        // Try JSON first (exported schema format)
        try {
            const parsed = JSON.parse(content);
            if (parsed.tables) {
                return parsed;
            }
        }
        catch {
            // Not JSON — treat as SQL
        }
        // Parse as SQL CREATE TABLE statements
        const tables = {};
        const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([^;]+)\)/gis;
        let match;
        while ((match = createRegex.exec(content)) !== null) {
            const tableName = match[1];
            const columns = this.parseColumnDefs(match[2]);
            tables[tableName] = { name: tableName, columns, indexes: [] };
        }
        return {
            dbType: 'postgresql',
            databaseName: name,
            tables,
            extractedAt: Date.now(),
        };
    }
    parseColumnDefs(defs) {
        const columns = {};
        const lines = defs.split('\n').map(l => l.trim()).filter(l => l && !/^\s*(PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|CONSTRAINT|KEY)/i.test(l));
        for (const line of lines) {
            const m = /["`]?(\w+)["`]?\s+(\w+(?:\([^)]+\))?)/i.exec(line);
            if (!m) {
                continue;
            }
            columns[m[1]] = {
                name: m[1],
                type: m[2],
                nullable: !line.toUpperCase().includes('NOT NULL'),
                isPrimaryKey: line.toUpperCase().includes('PRIMARY KEY'),
                isForeignKey: line.toUpperCase().includes('REFERENCES'),
            };
        }
        return columns;
    }
}
exports.MergeAnalyzer = MergeAnalyzer;
//# sourceMappingURL=mergeAnalyzer.js.map