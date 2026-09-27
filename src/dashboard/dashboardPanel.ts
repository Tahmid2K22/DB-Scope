// src/dashboard/dashboardPanel.ts -- VS Code WebView Dashboard
// Interactive dashboard with navigation tabs, message passing, and polished UI.

import * as vscode from 'vscode';
import {
  BlastRadiusResult,
  MergeAnalysisResult,
  BobResolutionSummary,
  DuplicateGroup,
  SchemaSnapshot,
} from '../core/types';

export type DashboardPayload =
  | { type: 'overview'; data: null }
  | { type: 'blastRadius'; data: BlastRadiusResult }
  | { type: 'merge'; data: MergeAnalysisResult }
  | { type: 'duplicates'; data: DuplicateGroup[] }
  | { type: 'history'; data: SchemaSnapshot[] };

export type DashboardMessageHandler = (message: { command: string; [key: string]: unknown }) => void;

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _shellLoaded = false;
  private _onMessage: DashboardMessageHandler | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    payload: DashboardPayload,
    onMessage?: DashboardMessageHandler
  ) {
    this._panel = panel;
    this._onMessage = onMessage;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    if (onMessage) {
      this._panel.webview.onDidReceiveMessage(onMessage, null, this._disposables);
    }

    // Load the shell first, then push the initial view
    this._panel.webview.html = this.shellHtml();
    this._shellLoaded = true;
    this._pushView(payload);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    payload: DashboardPayload,
    onMessage?: DashboardMessageHandler
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._pushView(payload);
      DashboardPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbscopeDashboard',
      'DB-Scope Dashboard',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, payload, onMessage);
  }

  public static getCurrent(): DashboardPanel | undefined {
    return DashboardPanel.currentPanel;
  }

  public updateStats(stats: { tableCount: number; columnCount: number; lastUpdated: number | null }): void {
    this._panel.webview.postMessage({ command: 'updateStats', stats });
  }

  private _pushView(payload: DashboardPayload): void {
    this._panel.title = `DB-Scope -- ${this.titleFor(payload.type)}`;
    const html = this.getContentHtml(payload);
    this._panel.webview.postMessage({ command: 'setView', view: payload.type, html });
  }

  private titleFor(type: DashboardPayload['type']): string {
    const map: Record<DashboardPayload['type'], string> = {
      overview: 'Overview',
      blastRadius: 'Impact Analysis',
      merge: 'Merge Conflict Report',
      duplicates: 'Duplicate Detector',
      history: 'Schema Timeline',
    };
    return map[type];
  }

  public dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      d?.dispose();
    }
  }

  // --------------------------------------------------
  // Content HTML (view-specific, no page wrapper)
  // --------------------------------------------------

  private getContentHtml(payload: DashboardPayload): string {
    switch (payload.type) {
      case 'blastRadius': return this.blastRadiusHtml(payload.data);
      case 'merge': return this.mergeHtml(payload.data);
      case 'duplicates': return this.duplicatesHtml(payload.data);
      case 'history': return this.historyHtml(payload.data);
      case 'overview': return this.overviewHtml();
    }
  }

  // --------------------------------------------------
  // Shell HTML (loaded once, contains CSS + JS + nav)
  // --------------------------------------------------

  private shellHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DB-Scope Dashboard</title>
  <style>
    :root {
      --accent: #4a9eff;
      --accent-dim: rgba(74, 158, 255, 0.15);
      --critical: #dc3545;
      --high: #e67700;
      --medium: #e6a700;
      --low: #28a745;
      --card-bg: var(--vscode-sideBar-background, #1e1e2e);
      --card-border: var(--vscode-panel-border, #333);
      --text: var(--vscode-editor-foreground, #ccc);
      --text-muted: var(--vscode-descriptionForeground, #888);
      --bg: var(--vscode-editor-background, #181825);
      --header-bg: var(--vscode-titleBar-activeBackground, #1a1a2e);
      --table-alt: rgba(255, 255, 255, 0.03);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      overflow-x: hidden;
    }

    /* ---- Header & Navigation ---- */
    .header {
      background: var(--header-bg);
      border-bottom: 1px solid var(--card-border);
      border-top: 3px solid var(--accent);
      padding: 0 20px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-inner {
      display: flex;
      align-items: center;
      gap: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }
    .header-title {
      font-size: 1.1em;
      font-weight: 700;
      color: var(--accent);
      padding: 12px 0;
      white-space: nowrap;
      letter-spacing: 0.5px;
    }
    .nav-tabs {
      display: flex;
      gap: 0;
      overflow-x: auto;
    }
    .nav-tab {
      padding: 12px 16px;
      font-size: 0.85em;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      white-space: nowrap;
      transition: color 0.15s, border-color 0.15s;
      user-select: none;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
      font-family: inherit;
    }
    .nav-tab:hover { color: var(--text); }
    .nav-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 600;
    }

    /* ---- Main Content ---- */
    .main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 20px 40px;
    }
    #content {
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ---- Typography ---- */
    h1 {
      font-size: 1.35em;
      margin-bottom: 8px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }
    h2 {
      font-size: 1.05em;
      margin-top: 24px;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--card-border);
      font-weight: 600;
    }
    p { margin-bottom: 8px; }

    /* ---- Cards ---- */
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 14px;
    }
    .card-title {
      font-size: 0.78em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
      margin-bottom: 14px;
    }

    /* ---- Badges ---- */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 0.78em;
      font-weight: 700;
      margin-left: 6px;
      vertical-align: middle;
    }
    .badge-critical { background: var(--critical); color: #fff; }
    .badge-high { background: var(--high); color: #fff; }
    .badge-medium { background: var(--medium); color: #000; }
    .badge-low { background: var(--low); color: #fff; }
    .badge-info { background: var(--accent); color: #fff; }

    /* ---- Tags ---- */
    .tag {
      display: inline-block;
      background: var(--accent-dim);
      color: var(--accent);
      border-radius: 3px;
      padding: 1px 7px;
      font-size: 0.8em;
      margin: 2px;
      font-weight: 500;
    }

    /* ---- Tables ---- */
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid var(--card-border);
      font-size: 0.88em;
    }
    th {
      background: var(--card-bg);
      font-weight: 700;
      font-size: 0.8em;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--text-muted);
    }
    tr:nth-child(even) td { background: var(--table-alt); }

    /* ---- Code ---- */
    pre, code {
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
    }
    pre {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 12px;
      border-radius: 4px;
      font-size: 0.84em;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    code {
      font-size: 0.92em;
    }

    /* ---- Score bar ---- */
    .score-bar {
      height: 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      margin-top: 8px;
      overflow: hidden;
    }
    .score-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.4s ease;
    }

    /* ---- Buttons ---- */
    .btn {
      display: inline-block;
      padding: 8px 16px;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid rgba(74, 158, 255, 0.3);
      border-radius: 4px;
      font-size: 0.85em;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      font-family: inherit;
      margin: 4px;
    }
    .btn:hover {
      background: rgba(74, 158, 255, 0.25);
      border-color: var(--accent);
    }
    .btn:active {
      background: rgba(74, 158, 255, 0.35);
    }

    /* ---- Lists ---- */
    ul, ol { margin: 6px 0; padding-left: 22px; }
    li { margin-bottom: 4px; font-size: 0.9em; }

    /* ---- Muted text ---- */
    .muted { color: var(--text-muted); font-size: 0.85em; }

    /* ---- Bob AI Banner ---- */
    .bob-banner {
      background: rgba(74, 158, 255, 0.08);
      border: 1px solid rgba(74, 158, 255, 0.25);
      border-radius: 4px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 0.9em;
    }
    .bob-banner strong { color: var(--accent); }

    /* ---- Conflict cards ---- */
    .conflict-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }
    .conflict-card .meta {
      font-size: 0.82em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .conflict-card .suggestion { margin: 6px 0 4px; }

    /* ---- Section label ---- */
    .section-label {
      font-size: 0.76em;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-muted);
      margin: 8px 0 4px;
      letter-spacing: 0.5px;
    }

    /* ---- Confidence pill ---- */
    .confidence-pill {
      display: inline-block;
      background: rgba(74, 158, 255, 0.15);
      color: var(--accent);
      border-radius: 10px;
      padding: 1px 8px;
      font-size: 0.76em;
      font-weight: 700;
      margin-left: 6px;
      vertical-align: middle;
    }

    /* ---- Files & migration lists ---- */
    .files-list, .migration-steps {
      margin: 4px 0 0 0;
      padding-left: 20px;
      font-size: 0.84em;
    }
    .files-list li, .migration-steps li { margin-bottom: 2px; }
    .risks-list {
      margin: 4px 0 0 0;
      padding-left: 20px;
      font-size: 0.84em;
      color: var(--critical);
    }

    /* ---- Stat values ---- */
    .stat-value {
      font-size: 1.8em;
      font-weight: 700;
      color: var(--accent);
      line-height: 1.2;
    }
    .stat-label {
      font-size: 0.82em;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .stat-row {
      display: flex;
      gap: 32px;
      margin: 12px 0;
    }
    .stat-item { text-align: center; }

    /* ---- Status indicator ---- */
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .status-dot.active { background: var(--low); }
    .status-dot.inactive { background: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <div class="header-title">DB-Scope</div>
      <div class="nav-tabs">
        <button class="nav-tab active" data-view="overview" onclick="switchTab('overview')">Overview</button>
        <button class="nav-tab" data-view="blastRadius" onclick="switchTab('blastRadius')">Impact</button>
        <button class="nav-tab" data-view="merge" onclick="switchTab('merge')">Merge Analysis</button>
        <button class="nav-tab" data-view="duplicates" onclick="switchTab('duplicates')">Duplicates</button>
        <button class="nav-tab" data-view="history" onclick="switchTab('history')">Timeline</button>
      </div>
    </div>
  </div>
  <div class="main">
    <div id="content">
      <p class="muted">Loading dashboard...</p>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentView = 'overview';

    function switchTab(view) {
      if (view === 'overview') {
        // Overview is handled locally -- just tell extension to push overview data
        vscode.postMessage({ command: 'runCommand', commandId: 'openDashboard' });
      } else {
        const commandMap = {
          blastRadius: 'analyzeBlastRadius',
          merge: 'mergeDatabases',
          duplicates: 'detectDuplicates',
          history: 'showHistory'
        };
        const cmd = commandMap[view];
        if (cmd) {
          vscode.postMessage({ command: 'runCommand', commandId: cmd });
        }
      }
    }

    function setActiveTab(view) {
      currentView = view;
      document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === view);
      });
    }

    function runCommand(commandId) {
      vscode.postMessage({ command: 'runCommand', commandId: commandId });
    }

    function relativeTime(timestamp) {
      if (!timestamp) return 'Never';
      const diff = Date.now() - timestamp;
      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'setView') {
        const el = document.getElementById('content');
        if (el) {
          el.style.animation = 'none';
          el.offsetHeight; // trigger reflow
          el.style.animation = '';
          el.innerHTML = msg.html;
        }
        setActiveTab(msg.view);
      } else if (msg.command === 'updateStats') {
        const s = msg.stats;
        const tcEl = document.getElementById('stat-tables');
        const ccEl = document.getElementById('stat-columns');
        const luEl = document.getElementById('stat-updated');
        if (tcEl) tcEl.textContent = String(s.tableCount);
        if (ccEl) ccEl.textContent = String(s.columnCount);
        if (luEl) luEl.textContent = relativeTime(s.lastUpdated);
      }
    });

    // Signal ready
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }

  // --------------------------------------------------
  // View: Overview
  // --------------------------------------------------

  private overviewHtml(): string {
    return `
<h1>Dashboard Overview</h1>
<p class="muted">AI-powered database lifecycle platform for VS Code.</p>

<div class="card-grid">
  <div class="card">
    <div class="card-title">Schema Health</div>
    <div class="stat-row">
      <div class="stat-item">
        <div class="stat-value" id="stat-tables">--</div>
        <div class="stat-label">Tables</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" id="stat-columns">--</div>
        <div class="stat-label">Columns</div>
      </div>
    </div>
    <p class="muted">Last scan: <span id="stat-updated">--</span></p>
  </div>

  <div class="card">
    <div class="card-title">AI Integration</div>
    <p><span class="status-dot active"></span> <strong>IBM watsonx.ai</strong> -- Granite 3-3-8b-instruct</p>
    <p><span class="status-dot active"></span> <strong>IBM Bob Shell</strong> -- CLI fallback engine</p>
    <p class="muted" style="margin-top:8px">Token-optimized context delivery active</p>
  </div>
</div>

<div class="card">
  <div class="card-title">Quick Actions</div>
  <button class="btn" onclick="runCommand('analyzeBlastRadius')">Analyze Impact</button>
  <button class="btn" onclick="runCommand('detectDuplicates')">Detect Duplicates</button>
  <button class="btn" onclick="runCommand('mergeDatabases')">Merge Analysis</button>
  <button class="btn" onclick="runCommand('fetchContext')">Fetch Context</button>
  <button class="btn" onclick="runCommand('showHistory')">Show Timeline</button>
</div>

<div class="card">
  <div class="card-title">Capabilities</div>
  <ul>
    <li><strong>Impact Analysis</strong> -- 4-dimension migration impact assessment</li>
    <li><strong>Duplicate Detection</strong> -- semantic duplicate column and table finder</li>
    <li><strong>Merge Conflict Analysis</strong> -- cross-schema structural diff with AI enrichment</li>
    <li><strong>Real-time Diagnostics</strong> -- SQL error detection and quick fixes</li>
    <li><strong>Schema Timeline</strong> -- historical schema evolution tracking</li>
  </ul>
</div>

<p class="muted">Hover over any SQL query in the editor for instant impact tooltips.</p>`;
  }

  // --------------------------------------------------
  // View: Impact Analysis
  // --------------------------------------------------

  private blastRadiusHtml(r: BlastRadiusResult): string {
    const riskColor = `badge-${r.riskLevel}`;
    const scoreWidth = Math.round(r.riskScore * 10);
    const scoreColor = { low: 'var(--low)', medium: 'var(--medium)', high: 'var(--high)', critical: 'var(--critical)' }[r.riskLevel];

    const breaking = r.schemaImpact.breakingChanges.map(c => `<li>${this.esc(c)}</li>`).join('');
    const nonBreaking = r.schemaImpact.nonBreakingChanges.map(c => `<li>${this.esc(c)}</li>`).join('');
    const cascades = r.schemaImpact.cascadeEffects.map(c => `<li><code>${this.esc(c)}</code></li>`).join('');
    const dataRisks = r.dataIntegrityRisks.map(d =>
      `<tr><td>${this.esc(d.description)}</td><td><span class="badge badge-${d.severity}">${d.severity.toUpperCase()}</span></td></tr>`
    ).join('');
    const appDeps = r.appDependencies.slice(0, 20).map(d =>
      `<tr><td><code>${this.esc(d.filePath)}:${d.lineNumber ?? ''}</code></td><td>${this.esc(d.tableName)}</td><td class="muted">${this.esc(d.usage)}</td></tr>`
    ).join('');
    const suggestions = r.suggestions.map(s => `<li>${this.esc(s)}</li>`).join('');
    const rollbacks = (r.rollbackSuggestions ?? []).map(rb => {
      const safetyColor = rb.safetyLevel === 'safe' ? 'badge-low' : rb.safetyLevel === 'manual_review' ? 'badge-medium' : 'badge-critical';
      return `<tr>
        <td>${this.esc(rb.description)}</td>
        <td><span class="badge ${safetyColor}">${this.esc(rb.safetyLevel)}</span></td>
        <td><pre style="margin:0;font-size:0.82em">${this.esc(rb.sql)}</pre></td>
      </tr>`;
    }).join('');

    return `
<h1>Impact Analysis <span class="badge ${riskColor}">${r.riskLevel.toUpperCase()} -- ${r.riskScore}/10</span></h1>
<div class="score-bar"><div class="score-fill" style="width:${scoreWidth}%;background:${scoreColor}"></div></div>
<p class="muted" style="margin-top:8px">Analyzed: <code>${this.esc(r.sql.slice(0, 120))}${r.sql.length > 120 ? '...' : ''}</code></p>
<p><strong>Affected Tables:</strong> ${r.affectedTables.map(t => `<span class="tag">${this.esc(t)}</span>`).join(' ')}</p>

${breaking ? `<h2>Breaking Changes</h2><ul>${breaking}</ul>` : ''}
${nonBreaking ? `<h2>Non-Breaking Changes</h2><ul>${nonBreaking}</ul>` : ''}
${cascades ? `<h2>Cascade Effects</h2><ul>${cascades}</ul>` : ''}

${dataRisks ? `<h2>Data Integrity Risks</h2>
<table><thead><tr><th>Risk</th><th>Severity</th></tr></thead><tbody>${dataRisks}</tbody></table>` : ''}

${appDeps ? `<h2>App Dependencies (${r.appDependencies.length} files)</h2>
<table><thead><tr><th>File</th><th>Table</th><th>Usage</th></tr></thead><tbody>${appDeps}</tbody></table>` : ''}

${r.documentationDrift.length > 0 ? `<h2>Documentation Drift (${r.documentationDrift.length} issues)</h2>
<ul>${r.documentationDrift.map(d => `<li><code>${this.esc(d.filePath)}</code> -- ${this.esc(d.issue)}</li>`).join('')}</ul>` : ''}

${suggestions ? `<h2>Suggestions</h2><ul>${suggestions}</ul>` : ''}

${rollbacks ? `<h2>Rollback SQL</h2>
<table><thead><tr><th>Description</th><th>Safety</th><th>SQL</th></tr></thead><tbody>${rollbacks}</tbody></table>` : ''}
`;
  }

  // --------------------------------------------------
  // View: Merge Analysis
  // --------------------------------------------------

  private mergeHtml(r: MergeAnalysisResult): string {
    const bobMap = new Map<string, BobResolutionSummary>();
    for (const res of (r.bobResolutions ?? [])) {
      bobMap.set(res.conflictId, res);
    }

    const bobEnriched = bobMap.size > 0;

    const severityFor = (t: string): string => {
      switch (t) {
        case 'missing_table':    return 'high';
        case 'type_mismatch':    return 'high';
        case 'name_conflict':    return 'medium';
        case 'missing_column':   return 'medium';
        case 'nullable_difference': return 'low';
        default:                 return 'medium';
      }
    };

    const typeCounts: Record<string, number> = {};
    for (const c of r.conflicts) {
      typeCounts[c.conflictType] = (typeCounts[c.conflictType] ?? 0) + 1;
    }
    const typeBreakdown = Object.entries(typeCounts)
      .map(([t, n]) => `<span class="badge badge-${severityFor(t)}" style="margin-right:4px">${n} ${this.esc(t)}</span>`)
      .join(' ');

    const bobBanner = bobEnriched ? `
<div class="bob-banner">
  <strong>IBM Bob AI-Enhanced</strong> -- ${bobMap.size} conflict${bobMap.size !== 1 ? 's' : ''} analyzed by IBM Bob Shell.
  Confidence scores, affected files, and migration steps are sourced from Bob's repository-level analysis.
</div>` : '';

    const conflictIdFn = (c: { conflictType: string; table: string; column?: string }) =>
      c.column ? `${c.conflictType}::${c.table}::${c.column}` : `${c.conflictType}::${c.table}`;

    const conflictCards = r.conflicts.map(c => {
      const id = conflictIdFn(c);
      const bob = bobMap.get(id);
      const severityClass = `badge-${severityFor(c.conflictType)}`;

      const confidencePill = bob
        ? `<span class="confidence-pill">${Math.round(bob.confidence * 100)}% confidence</span>`
        : '';

      const resolutionBadge = bob
        ? `<span class="tag" style="margin-left:4px">${this.esc(bob.resolution)}</span>`
        : '';

      const files = bob?.affectedFiles ?? [];
      const filesHtml = files.length > 0 ? `
<div class="section-label">Affected Files</div>
<ul class="files-list">
  ${files.slice(0, 5).map(f => `<li><code>${this.esc(f.path)}</code> <span class="muted">-- ${this.esc(f.reason)}</span></li>`).join('')}
  ${files.length > 5 ? `<li class="muted">...and ${files.length - 5} more</li>` : ''}
</ul>` : '';

      const plan = bob?.migrationPlan ?? [];
      const planHtml = plan.length > 0 ? `
<div class="section-label">Migration Plan</div>
<ol class="migration-steps">
  ${plan.map(step => `<li>${this.esc(step)}</li>`).join('')}
</ol>` : '';

      const risks = bob?.risks ?? [];
      const risksHtml = risks.length > 0 ? `
<div class="section-label">Risks</div>
<ul class="risks-list">
  ${risks.map(risk => `<li>${this.esc(risk)}</li>`).join('')}
</ul>` : '';

      return `
<div class="conflict-card">
  <div class="meta">
    <span class="tag">${this.esc(c.table)}</span>${c.column ? `.<code>${this.esc(c.column)}</code>` : ''}
    &nbsp;
    <span class="badge ${severityClass}">${this.esc(c.conflictType)}</span>${confidencePill}${resolutionBadge}
  </div>
  <div style="font-size:0.85em;opacity:0.75;margin-bottom:4px">
    <strong>A:</strong> ${this.esc(c.sourceA)} &nbsp;|&nbsp; <strong>B:</strong> ${this.esc(c.sourceB)}
  </div>
  <div class="suggestion">Suggestion: ${this.esc(c.suggestion)}</div>
  ${filesHtml}${planHtml}${risksHtml}
</div>`;
    }).join('');

    return `
<h1>Merge Conflict Report</h1>
${bobBanner}
<p>
  <strong>Schema A:</strong> ${this.esc(r.schemaA.databaseName)}
  &nbsp;|&nbsp;
  <strong>Schema B:</strong> ${this.esc(r.schemaB.databaseName)}
</p>
<p>
  <strong>Conflicts found:</strong>
  <span class="badge ${r.conflicts.length > 5 ? 'badge-high' : r.conflicts.length > 0 ? 'badge-medium' : 'badge-low'}">${r.conflicts.length}</span>
  &nbsp; ${typeBreakdown}
</p>

${conflictCards || '<p>No conflicts detected -- schemas are compatible.</p>'}

<h2>Reconciliation SQL</h2>
<pre>${this.esc(r.reconciledSql)}</pre>
`;
  }

  // --------------------------------------------------
  // View: Duplicates
  // --------------------------------------------------

  private duplicatesHtml(groups: DuplicateGroup[]): string {
    if (groups.length === 0) {
      return '<h1>Duplicate Detector</h1><p>No logical duplicates found in the current schema.</p>';
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
  <p style="margin-top:8px">Suggestion: <em>${this.esc(g.suggestion)}</em></p>
</div>`).join('');

    return `<h1>Duplicate Detector</h1><p>Found <strong>${groups.length}</strong> semantic duplicate group(s).</p>${cards}`;
  }

  // --------------------------------------------------
  // View: History
  // --------------------------------------------------

  private historyHtml(snapshots: SchemaSnapshot[]): string {
    if (snapshots.length === 0) {
      return '<h1>Schema Timeline</h1><p>No schema history recorded yet.</p>';
    }

    const rows = snapshots.slice().reverse().map(s => `
<tr>
  <td>${new Date(s.timestamp).toLocaleString()}</td>
  <td>${Object.keys(s.schema.tables).length} tables</td>
  <td><span class="badge ${s.changeCount > 5 ? 'badge-high' : 'badge-low'}">${s.changeCount} changes</span></td>
</tr>`).join('');

    return `
<h1>Schema Evolution Timeline</h1>
<p>${snapshots.length} snapshot(s) recorded.</p>
<table>
  <thead><tr><th>Timestamp</th><th>Tables</th><th>Changes</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  }

  // --------------------------------------------------
  // Utility
  // --------------------------------------------------

  private esc(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
