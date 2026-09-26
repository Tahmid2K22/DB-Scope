// src/hoverProvider/sqlHoverProvider.ts
// Member 1 — SQL Hover Provider
// Shows impact tooltip when hovering over SQL queries in the editor

import * as vscode from 'vscode';
import { BlastRadiusAnalyzer } from '../blastRadius/blastRadiusAnalyzer';
import { BlastRadiusResult, RiskLevel } from '../core/types';

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
    // Step 7: pass range so VS Code highlights only the SQL token
    const hover = this.buildHover(result, match.range);

    this.cache = { sql: match.sql, hover, expiresAt: Date.now() + this.CACHE_TTL_MS };
    return hover;
  }

  // ──────────────────────────────────────────────
  // SQL Extraction
  // ──────────────────────────────────────────────

  // Step 7: returns SqlMatch (sql + range) instead of bare string
  private extractSqlAtPosition(document: vscode.TextDocument, position: vscode.Position): SqlMatch | null {
    const text = document.getText();
    const cursorOffset = document.offsetAt(position);

    if (document.languageId === 'sql') {
      // For .sql files: return the entire statement containing the cursor
      return this.extractStatementAt(document, text, cursorOffset);
    }

    // For TypeScript/JS/Python: try current line first, then ±5 line window
    const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));
    const lineText = document.lineAt(position.line).text;
    const lineMatch = this.extractSqlFromString(lineText, lineStartOffset, document);
    if (lineMatch) { return lineMatch; }

    // Multi-line window around cursor
    const startLine = Math.max(0, position.line - 5);
    const endLine = Math.min(document.lineCount - 1, position.line + 5);
    const windowStartOffset = document.offsetAt(new vscode.Position(startLine, 0));
    const block = document.getText(new vscode.Range(startLine, 0, endLine, 999));
    return this.extractSqlFromString(block, windowStartOffset, document);
  }

  private extractStatementAt(document: vscode.TextDocument, text: string, offset: number): SqlMatch | null {
    let pos = 0;
    for (const stmt of text.split(';')) {
      const end = pos + stmt.length;
      if (offset >= pos && offset <= end) {
        const trimmed = stmt.trim();
        if (!trimmed) { return null; }
        // Range: from first non-whitespace char to end of stmt
        const stmtStart = pos + stmt.indexOf(trimmed[0]);
        const stmtEnd = stmtStart + trimmed.length;
        return {
          sql: trimmed,
          range: new vscode.Range(document.positionAt(stmtStart), document.positionAt(stmtEnd)),
        };
      }
      pos = end + 1;
    }
    const trimmed = text.trim();
    return trimmed ? { sql: trimmed, range: new vscode.Range(document.positionAt(0), document.positionAt(text.length)) } : null;
  }

  private extractSqlFromString(text: string, baseOffset: number, document: vscode.TextDocument): SqlMatch | null {
    // Step 6: 4 patterns — single-quoted, double-quoted, template literal (no interpolation),
    //         and multi-line template literal with ${...} interpolations
    const patterns = [
      // multi-line template literal ([\s\S]+? matches across newlines)
      /`((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[\s\S]+?)`/i,
      /"((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^"]+)"/i,
      /'((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^']+)'/i,
    ];
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (m) {
        const sqlContent = m[1].replace(/\$\{[^}]*\}/g, '?'); // replace ${expr} with ? placeholder
        const matchStart = baseOffset + m.index + 1; // +1 to skip the opening quote
        const matchEnd = matchStart + m[1].length;
        return {
          sql: sqlContent,
          range: new vscode.Range(document.positionAt(matchStart), document.positionAt(matchEnd)),
        };
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Hover Content Builder
  // ──────────────────────────────────────────────

  private buildHover(result: BlastRadiusResult, range?: vscode.Range): vscode.Hover {
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

    // Show rollback suggestions if present
    if (result.rollbackSuggestions && result.rollbackSuggestions.length > 0) {
      md.appendMarkdown(`**↩ Rollback:**\n`);
      for (const r of result.rollbackSuggestions.slice(0, 2)) {
        const safetyIcon = r.safetyLevel === 'safe' ? '✅' : r.safetyLevel === 'manual_review' ? '⚠' : '🔴';
        md.appendMarkdown(`- ${safetyIcon} \`${r.sql.split('\n')[0].slice(0, 80)}\`\n`);
      }
      md.appendMarkdown('\n');
    }

    md.appendMarkdown(`---\n_[Open Full Analysis](command:dbscope.analyzeBlastRadius)_`);

    // Step 7: pass range so tooltip anchors to the SQL token
    return range ? new vscode.Hover(md, range) : new vscode.Hover(md);
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
