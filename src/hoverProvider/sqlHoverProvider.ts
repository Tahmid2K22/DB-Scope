// src/hoverProvider/sqlHoverProvider.ts
// Member 1 — SQL Hover Provider
// Shows impact tooltip when hovering over SQL queries in the editor

import * as vscode from 'vscode';
import { BlastRadiusAnalyzer } from '../blastRadius/blastRadiusAnalyzer';
import { SchemaStateMap } from '../core/schemaStateMap';
import { parseSql } from '../utils/sqlParser';
import { RiskLevel } from '../core/types';

// Cache to avoid re-analyzing the same SQL on every hover
interface HoverCache {
  sql: string;
  hover: vscode.Hover;
  expiresAt: number;
}

export class SqlHoverProvider implements vscode.HoverProvider {
  private cache: HoverCache | null = null;
  private readonly CACHE_TTL_MS = 10_000; // 10 seconds

  constructor(
    private readonly analyzer: BlastRadiusAnalyzer,
    private readonly schemaState: SchemaStateMap
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    const sql = this.extractSqlAtPosition(document, position);
    if (!sql || sql.length < 6) { return null; }

    // Return cached hover if SQL hasn't changed and cache is fresh
    if (this.cache && this.cache.sql === sql && this.cache.expiresAt > Date.now()) {
      return this.cache.hover;
    }

    if (token.isCancellationRequested) { return null; }

    const result = await this.analyzer.analyze(sql);
    const hover = this.buildHover(result);

    this.cache = { sql, hover, expiresAt: Date.now() + this.CACHE_TTL_MS };
    return hover;
  }

  // ──────────────────────────────────────────────
  // SQL Extraction
  // ──────────────────────────────────────────────

  private extractSqlAtPosition(document: vscode.TextDocument, position: vscode.Position): string | null {
    const text = document.getText();

    if (document.languageId === 'sql') {
      // For .sql files: return the entire statement containing the cursor
      return this.extractStatementAt(text, document.offsetAt(position));
    }

    // For TypeScript/JS/Python: extract SQL from string literals near the cursor
    const line = document.lineAt(position.line).text;
    const sqlMatch = this.extractSqlFromString(line);
    if (sqlMatch) { return sqlMatch; }

    // Look at surrounding lines (multi-line SQL strings)
    const startLine = Math.max(0, position.line - 5);
    const endLine = Math.min(document.lineCount - 1, position.line + 5);
    const block = document.getText(new vscode.Range(startLine, 0, endLine, 999));
    return this.extractSqlFromString(block);
  }

  private extractStatementAt(text: string, offset: number): string {
    // Split on semicolons; return the statement containing the offset
    let pos = 0;
    for (const stmt of text.split(';')) {
      const end = pos + stmt.length;
      if (offset >= pos && offset <= end) {
        return stmt.trim();
      }
      pos = end + 1;
    }
    return text.trim();
  }

  private extractSqlFromString(text: string): string | null {
    // Match SQL keywords in string literals (backtick, single, or double quoted)
    const patterns = [
      /`((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^`]+)`/i,
      /"((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^"]+)"/i,
      /'((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^']+)'/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) { return match[1]; }
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Hover Content Builder
  // ──────────────────────────────────────────────

  private buildHover(result: ReturnType<typeof Object.assign> & { riskScore: number; riskLevel: RiskLevel; affectedTables: string[]; schemaImpact: { breakingChanges: string[]; cascadeEffects: string[] }; dataIntegrityRisks: { description: string; severity: string }[]; suggestions: string[] }): vscode.Hover {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = false;

    const riskEmoji = this.riskEmoji(result.riskLevel);
    const riskLabel = result.riskLevel.toUpperCase();

    md.appendMarkdown(`### ${riskEmoji} DB-Scope Impact Analysis\n\n`);
    md.appendMarkdown(`**Risk Score:** ${result.riskScore}/10 — \`${riskLabel}\`\n\n`);

    if (result.affectedTables.length > 0) {
      md.appendMarkdown(`**Affected Tables:** ${result.affectedTables.map(t => `\`${t}\``).join(', ')}\n\n`);
    }

    if (result.schemaImpact.breakingChanges.length > 0) {
      md.appendMarkdown(`**⚠ Breaking Changes:**\n`);
      for (const c of result.schemaImpact.breakingChanges) {
        md.appendMarkdown(`- ${c}\n`);
      }
      md.appendMarkdown('\n');
    }

    if (result.dataIntegrityRisks.length > 0) {
      md.appendMarkdown(`**🔴 Data Risks:**\n`);
      for (const r of result.dataIntegrityRisks.slice(0, 3)) {
        md.appendMarkdown(`- ${r.description}\n`);
      }
      md.appendMarkdown('\n');
    }

    if (result.schemaImpact.cascadeEffects.length > 0) {
      md.appendMarkdown(`**🔗 Cascade Effects:** ${result.schemaImpact.cascadeEffects.length} foreign key(s) affected\n\n`);
    }

    if (result.suggestions.length > 0) {
      md.appendMarkdown(`**💡 Suggestions:**\n`);
      for (const s of result.suggestions.slice(0, 2)) {
        md.appendMarkdown(`- ${s}\n`);
      }
      md.appendMarkdown('\n');
    }

    md.appendMarkdown(`---\n_[Open Full Analysis](command:dbscope.analyzeBlastRadius)_`);

    return new vscode.Hover(md);
  }

  private riskEmoji(level: RiskLevel): string {
    const map: Record<RiskLevel, string> = {
      low: '🟢',
      medium: '🟡',
      high: '🟠',
      critical: '🔴',
    };
    return map[level];
  }
}
