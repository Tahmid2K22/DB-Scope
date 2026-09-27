// src/blastRadius/blastRadiusAnalyzer.ts
// Member 1 — AI-Powered Blast Radius Analyzer
// Every analysis decision is made by IBM watsonx.ai Granite (ibm/granite-3-3-8b-instruct).
// Deterministic regex has been removed — AI understands context, dialect, and nuance.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  BlastRadiusResult,
  AppDependency,
  DataIntegrityRisk,
  DocumentationDrift,
  SchemaImpact,
  RiskLevel,
  RollbackSuggestion,
  DimensionConfidence,
  AnalysisConfidence,
} from '../core/types';
import { SchemaStateMap } from '../core/schemaStateMap';
import { parseSqlAI } from '../utils/sqlParser';
import { Logger } from '../utils/logger';
import { WatsonxClient, getWatsonxClient } from '../ai/watsonxClient';
import { createAdapter, DbConfig } from '../core/dbAdapters';
import { TableDefinition } from '../core/types';

// ── Fallback confidence when AI is unavailable ─────────────────────────────
const UNAVAILABLE: DimensionConfidence = {
  confidenceScore: 0,
  confidenceReason: 'AI unavailable — configure watsonx.ai credentials in DB-Scope settings',
};

export class BlastRadiusAnalyzer {
  private readonly logger = Logger.getInstance();
  private readonly ai: WatsonxClient;
  private analysisCache = new Map<string, BlastRadiusResult>();

  constructor(
    private readonly schemaState: SchemaStateMap,
    ai?: WatsonxClient,
  ) {
    this.ai = ai ?? getWatsonxClient();
  }

  // ──────────────────────────────────────────────
  // Main entry point
  // ──────────────────────────────────────────────

  async analyze(sql: string): Promise<BlastRadiusResult> {
    this.logger.info(`BlastRadius: analyzing SQL (${sql.length} chars)`);

    // Step 2: AI-powered parser — handles CTEs, MERGE, stored procs
    const parsed = await parseSqlAI(sql, this.ai);

    // Fetch live schema if connection string is configured
    const config = vscode.workspace.getConfiguration('dbscope');
    const connStr = config.get<string>('connectionString');
    const dbType = config.get<string>('dbType') as DbConfig['dbType'] ?? 'postgresql';

    let liveTables: Record<string, TableDefinition> = {};
    if (connStr && parsed.tables.length > 0) {
      try {
        const adapter = createAdapter({ dbType, connectionString: connStr });
        if (adapter) {
          liveTables = await adapter.extractTablesSchema(parsed.tables);
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch live schema: ${err}`);
      }
    }

    const activeSchema = {
      getTable: (name: string) => liveTables[name] || this.schemaState.getTable(name)
    };

    const prunedSchema: Record<string, TableDefinition> = {};
    for (const tableName of parsed.tables) {
      const t = activeSchema.getTable(tableName);
      if (t) prunedSchema[tableName] = t;
    }

    const cacheKey = sql + "||" + JSON.stringify(prunedSchema);
    if (this.analysisCache.has(cacheKey)) {
      this.logger.info(`BlastRadius: cache hit for SQL`);
      return this.analysisCache.get(cacheKey)!;
    }

    // Dimensions 2 and 4 run in parallel
    const [appDepsResult, docDrift] = await Promise.all([
      this.findAppDependencies(parsed.tables),
      this.detectDocumentationDrift(parsed.tables),
    ]);

    const contextStats = {
        filesScanned:    appDepsResult.filesScanned,
        totalFilesEst:   appDepsResult.totalFilesEst,
        schemaLoaded:    parsed.tables.some(t => !!activeSchema.getTable(t)),
        rowCountsKnown:  parsed.tables.some(t => activeSchema.getTable(t)?.rowCount !== undefined),
        docFilesFound:   docDrift.length === 0,
    };

    const consolidated = await this.performConsolidatedAnalysis(
      parsed,
      prunedSchema,
      appDepsResult.deps,
      docDrift,
      contextStats,
      dbType
    );

    const riskLevel = this.scoreToLevel(consolidated.score);

    const result: BlastRadiusResult = {
      sql,
      riskScore:          consolidated.score,
      riskLevel,
      affectedTables:     parsed.tables,
      schemaImpact:       consolidated.schemaImpact,
      appDependencies:    appDepsResult.deps,
      dataIntegrityRisks: consolidated.dataRisks,
      documentationDrift: docDrift,
      suggestions:        consolidated.suggestions,
      rollbackSuggestions: consolidated.rollbacks,
      riskExplanation:    consolidated.explanation,
      confidence:         consolidated.confidence,
      generatedAt:        Date.now(),
    };

    this.analysisCache.set(cacheKey, result);
    if (this.analysisCache.size > 50) {
      const firstKey = this.analysisCache.keys().next().value;
      this.analysisCache.delete(firstKey!);
    }

    return result;
  }

  // ──────────────────────────────────────────────
  // Consolidated AI Analysis (Replaces D1, D3, Score, Rollbacks)
  // ──────────────────────────────────────────────

  private async performConsolidatedAnalysis(
    parsed: Awaited<ReturnType<typeof parseSqlAI>>,
    prunedSchema: Record<string, TableDefinition>,
    deps: AppDependency[],
    docs: DocumentationDrift[],
    context: {
      filesScanned: number;
      totalFilesEst: number;
      schemaLoaded: boolean;
      rowCountsKnown: boolean;
      docFilesFound: boolean;
    },
    dbType: string
  ): Promise<{
    schemaImpact: SchemaImpact;
    dataRisks: DataIntegrityRisk[];
    rollbacks: RollbackSuggestion[];
    score: number;
    explanation: string;
    suggestions: string[];
    confidence: AnalysisConfidence;
  }> {
    const activeSchema = { getTable: (name: string) => prunedSchema[name] || null };
    const schemaContext = this.buildSchemaContext(parsed.tables, activeSchema);
    
    const rowInfo = parsed.tables.map(t => {
      const tbl = activeSchema.getTable(t);
      return tbl?.rowCount !== undefined ? `${t}: ${tbl.rowCount.toLocaleString()} rows` : `${t}: row count unknown`;
    }).join('; ');

    const system = `You are a senior DBA, migration risk expert, and database reliability engineer.
Analyze this SQL migration holistically and return a consolidated JSON payload.
Consider schema impact (breaking vs non-breaking), data integrity risks, and rollback generation.
For rollbacks, use safetyLevel: "safe", "manual_review", or "destructive".
Score risk from 1 (trivial) to 10 (catastrophic).
Score confidence from 0 (no context) to 100 (full context).
Return ONLY valid JSON with no extra text or markdown fences:
{
  "schemaImpact": {
    "breakingChanges": ["..."],
    "nonBreakingChanges": ["..."],
    "cascadeEffects": ["..."]
  },
  "dataRisks": [
    { "description": "...", "severity": "critical|high|medium|low" }
  ],
  "rollbacks": [
    { "description": "...", "sql": "...", "safetyLevel": "safe|manual_review|destructive" }
  ],
  "score": 7,
  "explanation": "<2-3 sentences explaining the score>",
  "suggestions": ["<actionable suggestion 1>"],
  "confidence": {
    "overall":            { "confidenceScore": 62, "confidenceReason": "..." },
    "schemaImpact":       { "confidenceScore": 90, "confidenceReason": "..." },
    "appDependencies":    { "confidenceScore": 55, "confidenceReason": "..." },
    "dataIntegrityRisks": { "confidenceScore": 40, "confidenceReason": "..." },
    "documentationDrift": { "confidenceScore": 70, "confidenceReason": "..." }
  }
}`;

    const user = `SQL: ${parsed.rawSql}
Database type: ${dbType}
${schemaContext}

App dependencies found: ${deps.length} files (Critical: ${deps.filter(d => d.severity === 'critical').length})
Files scanned: ${context.filesScanned} of ~${context.totalFilesEst}
Documentation drift: ${docs.length} tables undocumented
Table sizes: ${rowInfo || 'none available'}`;

    try {
      const raw  = await this.ai.ask(system, user, 2048);
      const json = this.extractJson(raw);
      const d    = JSON.parse(json);

      return {
        schemaImpact: {
          breakingChanges: d.schemaImpact?.breakingChanges || [],
          nonBreakingChanges: d.schemaImpact?.nonBreakingChanges || [],
          cascadeEffects: d.schemaImpact?.cascadeEffects || []
        },
        dataRisks: (d.dataRisks || []).map((r: any) => ({
          description: r.description,
          severity: this.normalizeRiskLevel(r.severity)
        })),
        rollbacks: (d.rollbacks || []).map((r: any) => ({
          description: r.description,
          sql: r.sql,
          safetyLevel: ['safe', 'manual_review', 'destructive'].includes(r.safetyLevel) ? r.safetyLevel : 'manual_review'
        })),
        score: Math.min(Math.max(Math.round(d.score ?? 5), 1), 10),
        explanation: d.explanation ?? '',
        suggestions: d.suggestions ?? [],
        confidence: {
          overall: d.confidence?.overall ?? UNAVAILABLE,
          schemaImpact: d.confidence?.schemaImpact ?? UNAVAILABLE,
          appDependencies: d.confidence?.appDependencies ?? UNAVAILABLE,
          dataIntegrityRisks: d.confidence?.dataIntegrityRisks ?? UNAVAILABLE,
          documentationDrift: d.confidence?.documentationDrift ?? UNAVAILABLE,
        }
      };
    } catch (err) {
      this.logger.warn(`Consolidated AI error: ${err}`);
      let score = Math.min(deps.filter(d => d.severity === 'critical').length, 2);
      return {
        schemaImpact: { breakingChanges: [], nonBreakingChanges: [], cascadeEffects: [] },
        dataRisks: [],
        rollbacks: [{ description: 'AI unavailable', sql: '-- Configure credentials', safetyLevel: 'manual_review' }],
        score: Math.min(Math.max(Math.round(score || 1), 1), 10),
        explanation: 'AI unavailable — score computed from rule-based heuristics.',
        suggestions: [],
        confidence: { overall: UNAVAILABLE, schemaImpact: UNAVAILABLE, appDependencies: UNAVAILABLE, dataIntegrityRisks: UNAVAILABLE, documentationDrift: UNAVAILABLE }
      };
    }
  }

  // ──────────────────────────────────────────────
  // Dimension 2: AI App Dependency Classification
  // ──────────────────────────────────────────────

  private async findAppDependencies(
    tables: string[]
  ): Promise<{ deps: AppDependency[]; filesScanned: number; totalFilesEst: number }> {
    if (tables.length === 0) { return { deps: [], filesScanned: 0, totalFilesEst: 0 }; }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return { deps: [], filesScanned: 0, totalFilesEst: 0 }; }

    // Phase 1 (deterministic I/O): find candidate files containing any table name or model class
    const sourceGlob = '**/*.{ts,js,py,java,rb,go,cs}';
    const files = await vscode.workspace.findFiles(sourceGlob, '**/node_modules/**', 200);

    const candidates: { filePath: string; lineNumber: number; tableName: string; lineText: string }[] = [];

    for (const file of files) {
      try {
        const doc  = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        for (const tableName of tables) {
          const searchTerms = [tableName, this.deriveModelName(tableName)];
          for (const term of searchTerms) {
            const pattern = new RegExp(`\\b${term}\\b`, 'gi');
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text)) !== null) {
              const line     = doc.positionAt(match.index).line;
              const lineText = doc.lineAt(line).text.trim();
              candidates.push({
                filePath:   vscode.workspace.asRelativePath(file),
                lineNumber: line + 1,
                tableName,
                lineText:   lineText.slice(0, 120),
              });
              break; // one candidate per (term + file) pair
            }
          }
        }
      } catch { /* skip unreadable files */ }
    }

    if (candidates.length === 0) {
      return { deps: [], filesScanned: files.length, totalFilesEst: files.length };
    }

    // Phase 2 (AI): batch classify all candidates in one Granite call
    const batchSize = 20;
    const deps: AppDependency[] = [];

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);

      const system = `You are a code reviewer analyzing database dependencies.
For each code snippet, decide if it is a REAL runtime dependency on the specified table
(e.g. a query, ORM call, or write operation at runtime) or a false positive
(comment, test fixture, migration script, documentation, import statement).
Return ONLY valid JSON with no extra text or markdown fences:
{
  "results": [
    {
      "filePath": "<same as input>",
      "lineNumber": <same as input>,
      "tableName": "<same as input>",
      "isDependency": true,
      "severity": "critical|high|medium|low",
      "reason": "<brief explanation>"
    }
  ]
}
Severity guide: critical=DELETE/DROP/TRUNCATE, high=UPDATE/INSERT, medium=SELECT/fetch, low=indirect.`;

      const snippets = batch
        .map((c, idx) => `${idx + 1}. ${c.filePath}:${c.lineNumber} [table: ${c.tableName}]\n   ${c.lineText}`)
        .join('\n');
      const user = `Classify these code snippets:\n${snippets}`;

      try {
        const raw  = await this.ai.ask(system, user, 1024);
        const json = this.extractJson(raw);
        const data = JSON.parse(json) as {
          results: {
            filePath: string; lineNumber: number; tableName: string;
            isDependency: boolean; severity: string; reason: string;
          }[];
        };
        for (const r of data.results ?? []) {
          if (r.isDependency) {
            deps.push({
              filePath:   r.filePath,
              lineNumber: r.lineNumber,
              tableName:  r.tableName,
              usage:      r.reason,
              severity:   this.normalizeRiskLevel(r.severity),
            });
          }
        }
      } catch (err) {
        this.logger.warn(`findAppDependencies AI error: ${err}`);
        // Fallback: include all candidates from this batch as medium severity
        for (const c of batch) {
          deps.push({
            filePath:   c.filePath,
            lineNumber: c.lineNumber,
            tableName:  c.tableName,
            usage:      c.lineText,
            severity:   'medium',
          });
        }
      }
    }

    return {
      deps:          deps.slice(0, 50),
      filesScanned:  files.length,
      totalFilesEst: files.length,
    };
  }

  // ──────────────────────────────────────────────
  // Dimension 4: Documentation Drift (kept as I/O scan, AI classifies confidence)
  // ──────────────────────────────────────────────

  private async detectDocumentationDrift(tables: string[]): Promise<DocumentationDrift[]> {
    const drifts: DocumentationDrift[] = [];
    if (tables.length === 0) { return []; }

    const docFiles = await vscode.workspace.findFiles('**/*.{md,yaml,yml,json}', '**/node_modules/**', 50);

    for (const file of docFiles) {
      try {
        const relPath   = vscode.workspace.asRelativePath(file);
        const isDocFile = /readme|api|schema/i.test(relPath);
        if (!isDocFile) { continue; }

        const doc  = await vscode.workspace.openTextDocument(file);
        const text = doc.getText().toLowerCase();

        for (const tableName of tables) {
          if (!text.includes(tableName.toLowerCase())) {
            drifts.push({
              filePath:   relPath,
              issue:      `Table "${tableName}" is not documented in ${path.basename(file.fsPath)}`,
              suggestion: `Add documentation for the ${tableName} table to ${relPath}`,
            });
          }
        }
      } catch { /* skip unreadable files */ }
    }

    return drifts.slice(0, 20);
  }

  // ──────────────────────────────────────────────
  // Export to JSON file
  // ──────────────────────────────────────────────

  async exportResult(result: BlastRadiusResult, targetDir: string): Promise<string> {
    const tableSlug = (result.affectedTables[0] ?? 'unknown').replace(/[^a-z0-9]/gi, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename  = `blast-radius-${tableSlug}-${timestamp}.json`;
    const filePath  = path.join(targetDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    this.logger.info(`BlastRadius: exported analysis to ${filePath}`);
    return filePath;
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private buildSchemaContext(tables: string[], activeSchema: { getTable(name: string): TableDefinition | null }): string {
    const parts: string[] = [];
    for (const tableName of tables) {
      const table = activeSchema.getTable(tableName);
      if (table) {
        const cols = Object.values(table.columns)
          .map(c => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.isPrimaryKey ? ' PK' : ''}${c.isForeignKey ? ` FK->${c.referencesTable}.${c.referencesColumn}` : ''}`)
          .join(', ');
        const rowInfo = table.rowCount !== undefined ? ` (${table.rowCount.toLocaleString()} rows)` : '';
        parts.push(`${tableName}${rowInfo}: [${cols}]`);
      }
    }
    return parts.length > 0
      ? `Schema:\n${parts.map(p => `  ${p}`).join('\n')}`
      : 'Schema: not loaded — run "DB-Scope: Fetch Database Context" for higher confidence';
  }

  /** Extract the first JSON object from a Granite response that may contain markdown fences. */
  private extractJson(raw: string): string {
    // Try a ```json ... ``` block first
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) { return fenced[1].trim(); }
    // Fall back to the first { ... } span
    const bare = raw.match(/\{[\s\S]*\}/);
    if (bare) { return bare[0]; }
    throw new Error(`No JSON found in AI response: ${raw.slice(0, 100)}`);
  }

  private normalizeRiskLevel(s: string): RiskLevel {
    const lower = (s ?? '').toLowerCase();
    if (lower === 'critical') { return 'critical'; }
    if (lower === 'high')     { return 'high'; }
    if (lower === 'medium')   { return 'medium'; }
    return 'low';
  }

  private scoreToLevel(score: number): RiskLevel {
    if (score >= 8) { return 'critical'; }
    if (score >= 6) { return 'high'; }
    if (score >= 4) { return 'medium'; }
    return 'low';
  }

  /** Derives the ORM model class name: "order_items" → "OrderItem", "users" → "User" */
  private deriveModelName(tableName: string): string {
    const pascal = tableName
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
    if (pascal.endsWith('ies')) { return pascal.slice(0, -3) + 'y'; }
    if (pascal.endsWith('ses')) { return pascal.slice(0, -2); }
    if (pascal.endsWith('s') && !pascal.endsWith('ss')) { return pascal.slice(0, -1); }
    return pascal;
  }
}
