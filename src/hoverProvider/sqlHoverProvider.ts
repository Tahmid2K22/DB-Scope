// src/hoverProvider/sqlHoverProvider.ts
// Member 1 — AI-Powered SQL Hover Provider
// Hover tooltip is written by IBM watsonx.ai Granite as natural language,
// including per-dimension confidence bars so the developer knows what to trust.

import * as vscode from 'vscode';
import { BlastRadiusAnalyzer } from '../blastRadius/blastRadiusAnalyzer';
import { BlastRadiusResult, RiskLevel, DimensionConfidence } from '../core/types';
import { getWatsonxClient } from '../ai/watsonxClient';

// Cache to avoid re-analyzing the same SQL on every hover
interface HoverCache {
  sql: string;
  hover: vscode.Hover;
  expiresAt: number;
}

interface SqlMatch {
  sql: string;
  range: vscode.Range;
}

export class SqlHoverProvider implements vscode.HoverProvider {
  private cache: HoverCache | null = null;
  private readonly CACHE_TTL_MS = 10_000; // 10 seconds

  constructor(
    private readonly analyzer: BlastRadiusAnalyzer
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    const match = this.extractSqlAtPosition(document, position);
    if (!match || match.sql.length < 6) { return null; }

    // Return cached hover if SQL hasn't changed and cache is fresh
    if (this.cache && this.cache.sql === match.sql && this.cache.expiresAt > Date.now()) {
      return this.cache.hover;
    }

    if (token.isCancellationRequested) { return null; }

    const result = await this.analyzer.analyze(match.sql);

    // Ask Granite for a natural-language summary of the full analysis result
    const aiSummary = await this.generateHoverSummary(result);

    const hover = this.buildHover(result, match.range, aiSummary);
    this.cache = { sql: match.sql, hover, expiresAt: Date.now() + this.CACHE_TTL_MS };
    return hover;
  }

  // ──────────────────────────────────────────────
  // AI Natural-Language Hover Summary
  // ──────────────────────────────────────────────

  private async generateHoverSummary(result: BlastRadiusResult): Promise<string> {
    const ai = getWatsonxClient();

    const system = `You are a senior DBA explaining a migration risk assessment to a developer.
Write a clear, concise 2-4 sentence summary in plain English.
Mention: the risk score and what it means in practice, the most important breaking change
or data risk (if any), which source files are affected (if any), and the rollback strategy.
Do NOT use bullet points — write in flowing prose. Use markdown bold for key terms.
Keep it under 120 words.`;

    const affectedFiles = result.appDependencies.slice(0, 3).map(d => `\`${d.filePath}\``).join(', ');
    const topRisk       = result.dataIntegrityRisks[0]?.description ?? 'none identified';
    const topBreaking   = result.schemaImpact.breakingChanges[0]    ?? 'none';
    const topRollback   = result.rollbackSuggestions[0]?.sql.split('\n')[0] ?? 'no rollback available';

    const user = `SQL: ${result.sql.slice(0, 200)}
Risk score: ${result.riskScore}/10 (${result.riskLevel.toUpperCase()})
Top breaking change: ${topBreaking}
Top data risk: ${topRisk}
Affected files: ${affectedFiles || 'none found'}
Rollback: ${topRollback}
AI explanation: ${result.riskExplanation}`;

    try {
      return await ai.ask(system, user, 200);
    } catch {
      // Fall back to the structured explanation from the analysis
      return result.riskExplanation || '';
    }
  }

  // ──────────────────────────────────────────────
  // Hover Content Builder
  // ──────────────────────────────────────────────

  private buildHover(result: BlastRadiusResult, range?: vscode.Range, aiSummary?: string): vscode.Hover {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted    = true;
    md.supportHtml  = false;

    const riskEmoji = this.riskEmoji(result.riskLevel);
    const riskLabel = result.riskLevel.toUpperCase();

    md.appendMarkdown(`### ${riskEmoji} DB-Scope: Migration Impact — Risk ${result.riskScore}/10 (${riskLabel})\n\n`);

    // Primary content: AI-written natural language summary
    if (aiSummary && aiSummary.trim()) {
      md.appendMarkdown(`${aiSummary.trim()}\n\n`);
    }

    // Rollback (most actionable item shown up-front)
    if (result.rollbackSuggestions.length > 0) {
      const r = result.rollbackSuggestions[0];
      const icon = r.safetyLevel === 'safe' ? '✅' : r.safetyLevel === 'manual_review' ? '⚠' : '🔴';
      md.appendMarkdown(`**↩ Rollback:** ${icon} \`${r.sql.split('\n')[0].slice(0, 90)}\`\n\n`);
    }

    // Per-dimension confidence bars
    if (result.confidence) {
      md.appendMarkdown(`---\n**Analysis Confidence**\n\n`);
      md.appendMarkdown(`\`\`\`\n`);
      md.appendMarkdown(this.confidenceLine('Schema Impact     ', result.confidence.schemaImpact));
      md.appendMarkdown(this.confidenceLine('App Dependencies  ', result.confidence.appDependencies));
      md.appendMarkdown(this.confidenceLine('Data Risks        ', result.confidence.dataIntegrityRisks));
      md.appendMarkdown(this.confidenceLine('Doc Drift         ', result.confidence.documentationDrift));
      md.appendMarkdown(this.confidenceLine('Overall           ', result.confidence.overall));
      md.appendMarkdown(`\`\`\`\n\n`);

      // Show the lowest-confidence dimension's reason as an actionable hint
      const lowest = this.lowestConfidence(result.confidence);
      if (lowest && lowest.confidenceScore < 70) {
        md.appendMarkdown(`⚠ *${lowest.confidenceReason}*\n\n`);
      }
    }

    md.appendMarkdown(`---\n_[Open Full Analysis](command:dbscope.analyzeBlastRadius)_`);

    return range ? new vscode.Hover(md, range) : new vscode.Hover(md);
  }

  /** Render one confidence bar line:  "Schema Impact      ████████░░  85%  reason" */
  private confidenceLine(label: string, dim: DimensionConfidence): string {
    const pct   = Math.max(0, Math.min(100, Math.round(dim.confidenceScore)));
    const filled = Math.round(pct / 10);
    const empty  = 10 - filled;
    const bar    = '█'.repeat(filled) + '░'.repeat(empty);
    // Truncate reason to fit in the tooltip
    const reason = dim.confidenceReason.slice(0, 55);
    return `${label}${bar}  ${String(pct).padStart(3)}%  ${reason}\n`;
  }

  /** Returns the DimensionConfidence with the lowest score (excluding overall). */
  private lowestConfidence(conf: BlastRadiusResult['confidence']): DimensionConfidence | null {
    const dims = [
      conf.schemaImpact,
      conf.appDependencies,
      conf.dataIntegrityRisks,
      conf.documentationDrift,
    ];
    return dims.reduce<DimensionConfidence | null>((min, d) =>
      min === null || d.confidenceScore < min.confidenceScore ? d : min,
    null);
  }

  // ──────────────────────────────────────────────
  // SQL Extraction (unchanged — I/O, not AI)
  // ──────────────────────────────────────────────

  private extractSqlAtPosition(document: vscode.TextDocument, position: vscode.Position): SqlMatch | null {
    const text         = document.getText();
    const cursorOffset = document.offsetAt(position);

    if (document.languageId === 'sql') {
      return this.extractStatementAt(document, text, cursorOffset);
    }

    const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));
    const lineText        = document.lineAt(position.line).text;
    const lineMatch       = this.extractSqlFromString(lineText, lineStartOffset, document);
    if (lineMatch) { return lineMatch; }

    const startLine       = Math.max(0, position.line - 5);
    const endLine         = Math.min(document.lineCount - 1, position.line + 5);
    const windowStartOff  = document.offsetAt(new vscode.Position(startLine, 0));
    const block           = document.getText(new vscode.Range(startLine, 0, endLine, 999));
    return this.extractSqlFromString(block, windowStartOff, document);
  }

  private extractStatementAt(document: vscode.TextDocument, text: string, offset: number): SqlMatch | null {
    let pos = 0;
    for (const stmt of text.split(';')) {
      const end = pos + stmt.length;
      if (offset >= pos && offset <= end) {
        const trimmed = stmt.trim();
        if (!trimmed) { return null; }
        const stmtStart = pos + stmt.indexOf(trimmed[0]);
        const stmtEnd   = stmtStart + trimmed.length;
        return {
          sql:   trimmed,
          range: new vscode.Range(document.positionAt(stmtStart), document.positionAt(stmtEnd)),
        };
      }
      pos = end + 1;
    }
    const trimmed = text.trim();
    return trimmed
      ? { sql: trimmed, range: new vscode.Range(document.positionAt(0), document.positionAt(text.length)) }
      : null;
  }

  private extractSqlFromString(text: string, baseOffset: number, document: vscode.TextDocument): SqlMatch | null {
    const patterns = [
      // Multi-line template literal with or without ${...} interpolations
      /`(\s*(?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[\s\S]+?)`/i,
      /"((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^"]+)"/i,
      /'((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^']+)'/i,
    ];
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (m) {
        const sqlContent = m[1].trim().replace(/\$\{[^}]*\}/g, '?');
        const matchStart = baseOffset + m.index + 1;
        const matchEnd   = matchStart + m[1].length;
        return {
          sql:   sqlContent,
          range: new vscode.Range(document.positionAt(matchStart), document.positionAt(matchEnd)),
        };
      }
    }
    return null;
  }

  private riskEmoji(level: RiskLevel): string {
    const map: Record<RiskLevel, string> = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
    return map[level];
  }
}
