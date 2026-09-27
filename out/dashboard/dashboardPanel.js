"use strict";
// src/dashboard/dashboardPanel.ts — VS Code WebView Dashboard
// Shows blast radius, merge conflicts, duplicate detector, and schema history
// as a rich HTML panel inside VS Code.
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
exports.DashboardPanel = void 0;
const vscode = __importStar(require("vscode"));
class DashboardPanel {
    constructor(panel, extensionUri, payload) {
        this.extensionUri = extensionUri;
        this._disposables = [];
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._update(payload);
    }
    static createOrShow(extensionUri, payload) {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;
        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel._update(payload);
            DashboardPanel.currentPanel._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('dbscopeDashboard', 'DB-Scope Dashboard', column, { enableScripts: false, retainContextWhenHidden: true });
        DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, payload);
    }
    _update(payload) {
        this._panel.title = `DB-Scope — ${this.titleFor(payload.type)}`;
        this._panel.webview.html = this.getHtml(payload);
    }
    titleFor(type) {
        const map = {
            overview: 'Overview',
            blastRadius: 'Blast Radius Analysis',
            merge: 'Merge Conflict Report',
            duplicates: 'Duplicate Detector',
            history: 'Schema Timeline',
        };
        return map[type];
    }
    dispose() {
        DashboardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            d?.dispose();
        }
    }
    // ──────────────────────────────────────────────
    // HTML Generation
    // ──────────────────────────────────────────────
    getHtml(payload) {
        switch (payload.type) {
            case 'blastRadius': return this.blastRadiusHtml(payload.data);
            case 'merge': return this.mergeHtml(payload.data);
            case 'duplicates': return this.duplicatesHtml(payload.data);
            case 'history': return this.historyHtml(payload.data);
            case 'overview': return this.overviewHtml();
        }
    }
    baseHtml(title, body) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.esc(title)}</title>
  <style>
    body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); margin: 0; padding: 20px; }
    h1 { font-size: 1.4em; margin-bottom: 6px; }
    h2 { font-size: 1.1em; margin-top: 24px; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 0.8em; font-weight: bold; margin-left: 8px; }
    .critical { background: #f44; color: #fff; }
    .high { background: #f80; color: #fff; }
    .medium { background: #fb0; color: #000; }
    .low { background: #4a4; color: #fff; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }
    th { background: var(--vscode-sideBar-background); font-weight: bold; }
    .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 14px; margin-bottom: 12px; }
    .tag { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; padding: 1px 6px; font-size: 0.8em; margin: 2px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; font-size: 0.85em; overflow-x: auto; white-space: pre-wrap; }
    .muted { opacity: 0.7; font-size: 0.85em; }
    .score-bar { height: 8px; border-radius: 4px; background: #e0e0e0; margin-top: 6px; }
    .score-fill { height: 8px; border-radius: 4px; }
    ul { margin: 6px 0; padding-left: 20px; }
    li { margin-bottom: 4px; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
    }
    blastRadiusHtml(r) {
        const riskColor = r.riskLevel;
        const scoreWidth = Math.round(r.riskScore * 10);
        const scoreColor = { low: '#4a4', medium: '#fb0', high: '#f80', critical: '#f44' }[r.riskLevel];
        const breaking = r.schemaImpact.breakingChanges.map(c => `<li>${this.esc(c)}</li>`).join('');
        const nonBreaking = r.schemaImpact.nonBreakingChanges.map(c => `<li>${this.esc(c)}</li>`).join('');
        const cascades = r.schemaImpact.cascadeEffects.map(c => `<li><code>${this.esc(c)}</code></li>`).join('');
        const dataRisks = r.dataIntegrityRisks.map(d => `<tr><td>${this.esc(d.description)}</td><td><span class="badge ${d.severity}">${d.severity.toUpperCase()}</span></td></tr>`).join('');
        const appDeps = r.appDependencies.slice(0, 20).map(d => `<tr><td><code>${this.esc(d.filePath)}:${d.lineNumber ?? ''}</code></td><td>${this.esc(d.tableName)}</td><td class="muted">${this.esc(d.usage)}</td></tr>`).join('');
        const suggestions = r.suggestions.map(s => `<li>${this.esc(s)}</li>`).join('');
        const rollbacks = (r.rollbackSuggestions ?? []).map(rb => {
            const safetyColor = rb.safetyLevel === 'safe' ? 'low' : rb.safetyLevel === 'manual_review' ? 'medium' : 'critical';
            return `<tr>
        <td>${this.esc(rb.description)}</td>
        <td><span class="badge ${safetyColor}">${this.esc(rb.safetyLevel)}</span></td>
        <td><pre style="margin:0;font-size:0.8em">${this.esc(rb.sql)}</pre></td>
      </tr>`;
        }).join('');
        const body = `
<h1>💥 Blast Radius Analysis <span class="badge ${riskColor}">${riskColor.toUpperCase()} — ${r.riskScore}/10</span></h1>
<div class="score-bar"><div class="score-fill" style="width:${scoreWidth}%;background:${scoreColor}"></div></div>
<p class="muted">Analyzed: <code>${this.esc(r.sql.slice(0, 120))}${r.sql.length > 120 ? '…' : ''}</code></p>
<p><strong>Affected Tables:</strong> ${r.affectedTables.map(t => `<span class="tag">${this.esc(t)}</span>`).join(' ')}</p>

${breaking ? `<h2>⚠ Breaking Changes</h2><ul>${breaking}</ul>` : ''}
${nonBreaking ? `<h2>✅ Non-Breaking Changes</h2><ul>${nonBreaking}</ul>` : ''}
${cascades ? `<h2>🔗 Cascade Effects</h2><ul>${cascades}</ul>` : ''}

${dataRisks ? `<h2>🔴 Data Integrity Risks</h2>
<table><thead><tr><th>Risk</th><th>Severity</th></tr></thead><tbody>${dataRisks}</tbody></table>` : ''}

${appDeps ? `<h2>📁 App Dependencies (${r.appDependencies.length} files)</h2>
<table><thead><tr><th>File</th><th>Table</th><th>Usage</th></tr></thead><tbody>${appDeps}</tbody></table>` : ''}

${r.documentationDrift.length > 0 ? `<h2>📄 Documentation Drift (${r.documentationDrift.length} issues)</h2>
<ul>${r.documentationDrift.map(d => `<li><code>${this.esc(d.filePath)}</code> — ${this.esc(d.issue)}</li>`).join('')}</ul>` : ''}

${suggestions ? `<h2>💡 Suggestions</h2><ul>${suggestions}</ul>` : ''}

${rollbacks ? `<h2>↩ Rollback SQL</h2>
<table><thead><tr><th>Description</th><th>Safety</th><th>SQL</th></tr></thead><tbody>${rollbacks}</tbody></table>` : ''}
`;
        return this.baseHtml('Blast Radius Analysis', body);
    }
    mergeHtml(r) {
        const conflictRows = r.conflicts.map(c => `
<tr>
  <td><span class="tag">${this.esc(c.table)}</span>${c.column ? `.<code>${this.esc(c.column)}</code>` : ''}</td>
  <td><span class="badge ${c.conflictType === 'type_mismatch' ? 'high' : 'medium'}">${this.esc(c.conflictType)}</span></td>
  <td class="muted">${this.esc(c.sourceA)}</td>
  <td class="muted">${this.esc(c.sourceB)}</td>
  <td>${this.esc(c.suggestion)}</td>
</tr>`).join('');
        const body = `
<h1>🔀 Database Merge Conflict Report</h1>
<p><strong>Schema A:</strong> ${this.esc(r.schemaA.databaseName)} &nbsp;|&nbsp; <strong>Schema B:</strong> ${this.esc(r.schemaB.databaseName)}</p>
<p><strong>Conflicts found:</strong> <span class="badge ${r.conflicts.length > 5 ? 'high' : r.conflicts.length > 0 ? 'medium' : 'low'}">${r.conflicts.length}</span></p>

${conflictRows ? `<h2>Conflict Details</h2>
<table>
  <thead><tr><th>Table / Column</th><th>Type</th><th>In A</th><th>In B</th><th>Suggestion</th></tr></thead>
  <tbody>${conflictRows}</tbody>
</table>` : '<p>✅ No conflicts detected — schemas are compatible!</p>'}

<h2>Reconciliation SQL</h2>
<pre>${this.esc(r.reconciledSql)}</pre>
`;
        return this.baseHtml('Merge Conflict Report', body);
    }
    duplicatesHtml(groups) {
        if (groups.length === 0) {
            return this.baseHtml('Duplicate Detector', '<h1>🔍 Duplicate Detector</h1><p>✅ No logical duplicates found in the current schema.</p>');
        }
        const cards = groups.map(g => `
<div class="card">
  <strong>Semantic Group: <code>${this.esc(g.semanticMeaning)}</code></strong>
  <table>
    <thead><tr><th>Table</th><th>Column</th><th>Type</th><th>Reason</th></tr></thead>
    <tbody>
      ${g.columns.map(c => `<tr><td>${this.esc(c.table)}</td><td><code>${this.esc(c.column)}</code></td><td>${this.esc(c.type)}</td><td class="muted">${this.esc(c.reason)}</td></tr>`).join('')}
    </tbody>
  </table>
  <p>💡 <em>${this.esc(g.suggestion)}</em></p>
</div>`).join('');
        const body = `<h1>🔍 Duplicate Detector</h1><p>Found <strong>${groups.length}</strong> semantic duplicate group(s).</p>${cards}`;
        return this.baseHtml('Duplicate Detector', body);
    }
    historyHtml(snapshots) {
        if (snapshots.length === 0) {
            return this.baseHtml('Schema Timeline', '<h1>📅 Schema Timeline</h1><p>No schema history recorded yet.</p>');
        }
        const rows = snapshots.slice().reverse().map(s => `
<tr>
  <td>${new Date(s.timestamp).toLocaleString()}</td>
  <td>${Object.keys(s.schema.tables).length} tables</td>
  <td><span class="badge ${s.changeCount > 5 ? 'high' : 'low'}">${s.changeCount} changes</span></td>
</tr>`).join('');
        const body = `
<h1>📅 Schema Evolution Timeline</h1>
<p>${snapshots.length} snapshot(s) recorded.</p>
<table>
  <thead><tr><th>Timestamp</th><th>Tables</th><th>Changes</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
        return this.baseHtml('Schema Timeline', body);
    }
    overviewHtml() {
        const body = `
<h1>🔬 DB-Scope Dashboard</h1>
<p>AI-powered database lifecycle platform for VS Code.</p>
<div class="card">
  <h2>Available Commands</h2>
  <ul>
    <li><strong>Analyze Migration Blast Radius</strong> — 4-dimension impact analysis</li>
    <li><strong>Detect Logical Duplicates</strong> — find phone vs mobile, email vs email_address</li>
    <li><strong>Analyze Database Merge Conflicts</strong> — compare two schemas</li>
    <li><strong>Fetch Database Context</strong> — scan codebase for schema definitions</li>
    <li><strong>Show Schema Timeline</strong> — view schema evolution history</li>
  </ul>
</div>
<p class="muted">Hover over any SQL query in the editor to see instant impact tooltips.</p>`;
        return this.baseHtml('DB-Scope Overview', body);
    }
    esc(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
exports.DashboardPanel = DashboardPanel;
//# sourceMappingURL=dashboardPanel.js.map