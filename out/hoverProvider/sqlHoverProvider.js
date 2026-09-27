"use strict";
// src/hoverProvider/sqlHoverProvider.ts
// Member 1 — SQL Hover Provider
// Shows impact tooltip when hovering over SQL queries in the editor
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
exports.SqlHoverProvider = void 0;
const vscode = __importStar(require("vscode"));
class SqlHoverProvider {
    constructor(analyzer) {
        this.analyzer = analyzer;
        this.cache = null;
        this.CACHE_TTL_MS = 10000; // 10 seconds
    }
    async provideHover(document, position, token) {
        const match = this.extractSqlAtPosition(document, position);
        if (!match || match.sql.length < 6) {
            return null;
        }
        // Return cached hover if SQL hasn't changed and cache is fresh
        if (this.cache && this.cache.sql === match.sql && this.cache.expiresAt > Date.now()) {
            return this.cache.hover;
        }
        if (token.isCancellationRequested) {
            return null;
        }
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
    extractSqlAtPosition(document, position) {
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
        if (lineMatch) {
            return lineMatch;
        }
        // Multi-line window around cursor
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 5);
        const windowStartOffset = document.offsetAt(new vscode.Position(startLine, 0));
        const block = document.getText(new vscode.Range(startLine, 0, endLine, 999));
        return this.extractSqlFromString(block, windowStartOffset, document);
    }
    extractStatementAt(document, text, offset) {
        let pos = 0;
        for (const stmt of text.split(';')) {
            const end = pos + stmt.length;
            if (offset >= pos && offset <= end) {
                const trimmed = stmt.trim();
                if (!trimmed) {
                    return null;
                }
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
    extractSqlFromString(text, baseOffset, document) {
        // Step 6: 4 patterns — single-quoted, double-quoted, template literal (no interpolation),
        //         and multi-line template literal with ${...} interpolations
        const patterns = [
            // multi-line template literal ([\s\S]+? matches across newlines)
            /`(\s*(?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[\s\S]+?)`/i,
            /"((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^"]+)"/i,
            /'((?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)[^']+)'/i,
        ];
        for (const pattern of patterns) {
            const m = pattern.exec(text);
            if (m) {
                const sqlContent = m[1].trim().replace(/\$\{[^}]*\}/g, '?'); // replace ${expr} with ? placeholder
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
    buildHover(result, range) {
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
    riskEmoji(level) {
        const map = {
            low: '🟢',
            medium: '🟡',
            high: '🟠',
            critical: '🔴',
        };
        return map[level];
    }
}
exports.SqlHoverProvider = SqlHoverProvider;
//# sourceMappingURL=sqlHoverProvider.js.map