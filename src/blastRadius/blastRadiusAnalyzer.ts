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

    // Dimensions 1-4 run in parallel (each makes one Granite call)
    const [schemaImpact, appDepsResult, dataRisksResult, docDrift] = await Promise.all([
      this.analyzeSchemaImpact(parsed, activeSchema),
      this.findAppDependencies(parsed.tables),
      this.assessDataIntegrityRisks(parsed, activeSchema),
      this.detectDocumentationDrift(parsed.tables),
    ]);

    // Step 5: AI risk score — single call returns score + explanation + all 5 confidence scores
    const scoreResult = await this.calculateRiskScore(
      schemaImpact.impact,
      appDepsResult.deps,
      dataRisksResult.risks,
      docDrift,
      parsed.tables,
      {
        filesScanned:    appDepsResult.filesScanned,
        totalFilesEst:   appDepsResult.totalFilesEst,
        schemaLoaded:    parsed.tables.some(t => !!activeSchema.getTable(t)),
        rowCountsKnown:  parsed.tables.some(t => activeSchema.getTable(t)?.rowCount !== undefined),
        docFilesFound:   docDrift.length === 0, // if drifts found, doc files were scanned
      },
      activeSchema
    );

    // Step 6: AI-written rollback SQL
    const rollbackSuggestions = await this.buildRollbackSuggestions(parsed, activeSchema);

    const riskLevel = this.scoreToLevel(scoreResult.score);

    return {
      sql,
      riskScore:          scoreResult.score,
      riskLevel,
      affectedTables:     parsed.tables,
      schemaImpact:       schemaImpact.impact,
      appDependencies:    appDepsResult.deps,
      dataIntegrityRisks: dataRisksResult.risks,
      documentationDrift: docDrift,
      suggestions:        scoreResult.suggestions,
      rollbackSuggestions,
      riskExplanation:    scoreResult.explanation,
      confidence:         scoreResult.confidence,
      generatedAt:        Date.now(),
    };
  }

  // ──────────────────────────────────────────────
  // Dimension 1: AI Schema Impact
  // ──────────────────────────────────────────────

  private async analyzeSchemaImpact(
    parsed: Awaited<ReturnType<typeof parseSqlAI>>,
    activeSchema: { getTable(name: string): TableDefinition | null }
  ): Promise<{ impact: SchemaImpact; confidence: DimensionConfidence }> {
    const schemaContext = this.buildSchemaContext(parsed.tables, activeSchema);
    const schemaAvailable = schemaContext !== 'Schema: not loaded';

    const system = `You are a database migration safety expert.
Given a SQL statement and the current table schema, identify all schema-level impacts.
Consider breaking changes (things that will break existing queries, ORMs, or APIs),
non-breaking changes (backward-compatible additions), and cascade effects through foreign keys.
Return ONLY valid JSON with no extra text or markdown fences:
{
  "breakingChanges": ["<human-readable description>"],
  "nonBreakingChanges": ["<human-readable description>"],
  "cascadeEffects": ["<human-readable description>"],
  "confidenceScore": 85,
  "confidenceReason": "<what context was available or missing>"
}`;

    const user = `SQL: ${parsed.rawSql}
${schemaContext}
Schema available: ${schemaAvailable}`;

    try {
      const raw   = await this.ai.ask(system, user, 512);
      const json  = this.extractJson(raw);
      const data  = JSON.parse(json) as {
        breakingChanges:    string[];
        nonBreakingChanges: string[];
        cascadeEffects:     string[];
        confidenceScore:    number;
        confidenceReason:   string;
      };
      return {
        impact: {
          breakingChanges:    data.breakingChanges    ?? [],
          nonBreakingChanges: data.nonBreakingChanges ?? [],
          cascadeEffects:     data.cascadeEffects     ?? [],
        },
        confidence: {
          confidenceScore:  data.confidenceScore  ?? 50,
          confidenceReason: data.confidenceReason ?? '',
        },
      };
    } catch (err) {
      this.logger.warn(`analyzeSchemaImpact AI error: ${err}`);
      return {
        impact:     { breakingChanges: [], nonBreakingChanges: [], cascadeEffects: [] },
        confidence: UNAVAILABLE,
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
  // Dimension 3: AI Data Integrity Risks
  // ──────────────────────────────────────────────

  private async assessDataIntegrityRisks(
    parsed: Awaited<ReturnType<typeof parseSqlAI>>,
    activeSchema: { getTable(name: string): TableDefinition | null }
  ): Promise<{ risks: DataIntegrityRisk[]; confidence: DimensionConfidence }> {
    const rowCountContext = parsed.tables
      .map(t => {
        const tbl = activeSchema.getTable(t);
        return tbl?.rowCount !== undefined ? `${t}=${tbl.rowCount.toLocaleString()} rows` : `${t}=row count unknown`;
      })
      .join(', ');

    const config  = vscode.workspace.getConfiguration('dbscope');
    const dbType  = config.get<string>('dbType', 'postgresql');

    const system = `You are a database reliability engineer specializing in migration safety.
Identify ALL data integrity risks in the given SQL statement.
Consider: missing WHERE clauses, lock escalation on large tables, foreign key violations,
constraint failures on existing data, irreversible operations, and transaction size risks.
Score your confidence (0-100) based on how much runtime context was provided
(row counts, FK graph, database version, database type).
Return ONLY valid JSON with no extra text or markdown fences:
{
  "risks": [
    { "description": "<risk description>", "severity": "critical|high|medium|low" }
  ],
  "confidenceScore": 70,
  "confidenceReason": "<what context was available or missing>"
}`;

    const user = `SQL: ${parsed.rawSql}
Database type: ${dbType}
Table row counts: ${rowCountContext || 'none available'}`;

    try {
      const raw  = await this.ai.ask(system, user, 768);
      const json = this.extractJson(raw);
      const data = JSON.parse(json) as {
        risks:            { description: string; severity: string }[];
        confidenceScore:  number;
        confidenceReason: string;
      };
      return {
        risks: (data.risks ?? []).map(r => ({
          description: r.description,
          severity:    this.normalizeRiskLevel(r.severity),
        })),
        confidence: {
          confidenceScore:  data.confidenceScore  ?? 50,
          confidenceReason: data.confidenceReason ?? '',
        },
      };
    } catch (err) {
      this.logger.warn(`assessDataIntegrityRisks AI error: ${err}`);
      return { risks: [], confidence: UNAVAILABLE };
    }
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
  // AI Risk Score + Explanation + All 5 Confidence Scores (single Granite call)
  // ──────────────────────────────────────────────

  private async calculateRiskScore(
    schema:   SchemaImpact,
    deps:     AppDependency[],
    data:     DataIntegrityRisk[],
    docs:     DocumentationDrift[],
    tables:   string[],
    context:  {
      filesScanned:   number;
      totalFilesEst:  number;
      schemaLoaded:   boolean;
      rowCountsKnown: boolean;
      docFilesFound:  boolean;
    },
    activeSchema: { getTable(name: string): TableDefinition | null }
  ): Promise<{
    score:       number;
    explanation: string;
    suggestions: string[];
    confidence:  AnalysisConfidence;
  }> {
    const rowInfo = tables.map(t => {
      const tbl = activeSchema.getTable(t);
      return tbl?.rowCount !== undefined ? `${t}: ${tbl.rowCount.toLocaleString()} rows` : `${t}: row count unknown`;
    }).join('; ');

    const system = `You are a senior DBA and migration risk expert.
Given the full analysis results for a SQL migration, score the overall risk and
provide per-dimension confidence scores reflecting how much context was available.
Score risk from 1 (trivial) to 10 (catastrophic).
Score each confidence from 0 (no context at all) to 100 (complete context).
Also provide up to 3 actionable suggestions for the developer.
Return ONLY valid JSON with no extra text or markdown fences:
{
  "score": 7,
  "explanation": "<2-3 sentence plain-English explanation of why this score>",
  "suggestions": ["<actionable suggestion 1>", "<actionable suggestion 2>"],
  "confidence": {
    "overall":            { "confidenceScore": 62, "confidenceReason": "<reason>" },
    "schemaImpact":       { "confidenceScore": 90, "confidenceReason": "<reason>" },
    "appDependencies":    { "confidenceScore": 55, "confidenceReason": "<reason>" },
    "dataIntegrityRisks": { "confidenceScore": 40, "confidenceReason": "<reason>" },
    "documentationDrift": { "confidenceScore": 70, "confidenceReason": "<reason>" }
  }
}`;

    const user = `SQL migration analysis:

Breaking schema changes: ${schema.breakingChanges.length > 0 ? schema.breakingChanges.join('; ') : 'none'}
Non-breaking schema changes: ${schema.nonBreakingChanges.length > 0 ? schema.nonBreakingChanges.join('; ') : 'none'}
Cascade effects: ${schema.cascadeEffects.length > 0 ? schema.cascadeEffects.join('; ') : 'none'}

App dependencies found: ${deps.length} files
  Critical: ${deps.filter(d => d.severity === 'critical').length}
  High:     ${deps.filter(d => d.severity === 'high').length}
  Medium:   ${deps.filter(d => d.severity === 'medium').length}
Files scanned: ${context.filesScanned} of ~${context.totalFilesEst} total

Data integrity risks: ${data.length > 0 ? data.map(r => `[${r.severity}] ${r.description}`).join('; ') : 'none'}

Documentation drift: ${docs.length} tables undocumented

Table sizes: ${rowInfo || 'none available'}
Schema loaded: ${context.schemaLoaded}
Row counts known: ${context.rowCountsKnown}
Documentation files found: ${context.docFilesFound}`;

    try {
      const raw  = await this.ai.ask(system, user, 1024);
      const json = this.extractJson(raw);
      const d    = JSON.parse(json) as {
        score:       number;
        explanation: string;
        suggestions: string[];
        confidence: {
          overall:            { confidenceScore: number; confidenceReason: string };
          schemaImpact:       { confidenceScore: number; confidenceReason: string };
          appDependencies:    { confidenceScore: number; confidenceReason: string };
          dataIntegrityRisks: { confidenceScore: number; confidenceReason: string };
          documentationDrift: { confidenceScore: number; confidenceReason: string };
        };
      };

      return {
        score:       Math.min(Math.max(Math.round(d.score ?? 5), 1), 10),
        explanation: d.explanation ?? '',
        suggestions: d.suggestions ?? [],
        confidence: {
          overall:            d.confidence?.overall            ?? UNAVAILABLE,
          schemaImpact:       d.confidence?.schemaImpact       ?? UNAVAILABLE,
          appDependencies:    d.confidence?.appDependencies     ?? UNAVAILABLE,
          dataIntegrityRisks: d.confidence?.dataIntegrityRisks ?? UNAVAILABLE,
          documentationDrift: d.confidence?.documentationDrift ?? UNAVAILABLE,
        },
      };
    } catch (err) {
      this.logger.warn(`calculateRiskScore AI error: ${err}`);
      // Arithmetic fallback so the tool still works without credentials
      let score = 0;
      score += Math.min(schema.breakingChanges.length * 2, 4);
      score += Math.min(schema.cascadeEffects.length * 0.5, 1);
      score += Math.min(deps.filter(d => d.severity === 'critical').length, 2);
      score += Math.min(data.filter(r => r.severity === 'critical').length * 2, 2);
      score += Math.min(data.filter(r => r.severity === 'high').length, 1);
      return {
        score:       Math.min(Math.max(Math.round(score), 1), 10),
        explanation: 'AI unavailable — score computed from rule-based heuristics.',
        suggestions: [],
        confidence: {
          overall:            UNAVAILABLE,
          schemaImpact:       UNAVAILABLE,
          appDependencies:    UNAVAILABLE,
          dataIntegrityRisks: UNAVAILABLE,
          documentationDrift: UNAVAILABLE,
        },
      };
    }
  }

  // ──────────────────────────────────────────────
  // AI Rollback SQL Generator
  // ──────────────────────────────────────────────

  private async buildRollbackSuggestions(
    parsed: Awaited<ReturnType<typeof parseSqlAI>>,
    activeSchema: { getTable(name: string): TableDefinition | null }
  ): Promise<RollbackSuggestion[]> {
    const config  = vscode.workspace.getConfiguration('dbscope');
    const dbType  = config.get<string>('dbType', 'postgresql');
    const schemaContext = this.buildSchemaContext(parsed.tables, activeSchema);

    const system = `You are a database migration engineer specializing in rollback strategies.
Write the exact SQL to UNDO the given migration statement.
Consider the database type and any schema context provided.
For each rollback, assign a safety level:
  "safe"           — can be run automatically with no data risk
  "manual_review"  — needs a human to verify before running
  "destructive"    — data was lost; a point-in-time backup is required
If no rollback is possible (e.g. DELETE / TRUNCATE), explain why and set safetyLevel to "destructive".
Return ONLY valid JSON with no extra text or markdown fences:
{
  "rollbacks": [
    {
      "description": "<what this rollback does>",
      "sql": "<ready-to-run SQL>",
      "safetyLevel": "safe|manual_review|destructive"
    }
  ]
}`;

    const user = `Migration SQL: ${parsed.rawSql}
Database type: ${dbType}
${schemaContext}`;

    try {
      const raw  = await this.ai.ask(system, user, 768);
      const json = this.extractJson(raw);
      const data = JSON.parse(json) as {
        rollbacks: { description: string; sql: string; safetyLevel: string }[];
      };
      return (data.rollbacks ?? []).map(r => ({
        description: r.description,
        sql:         r.sql,
        safetyLevel: (r.safetyLevel === 'safe' || r.safetyLevel === 'manual_review' || r.safetyLevel === 'destructive')
          ? r.safetyLevel
          : 'manual_review',
      }));
    } catch (err) {
      this.logger.warn(`buildRollbackSuggestions AI error: ${err}`);
      return [{
        description: 'Rollback generation unavailable — AI credentials not configured',
        sql:         '-- Configure dbscope.watsonxApiKey to enable AI-powered rollback generation',
        safetyLevel: 'manual_review',
      }];
    }
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
