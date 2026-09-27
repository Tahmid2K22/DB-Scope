// src/dashboard/dashboardViewProvider.ts -- Sidebar Overview (WebviewView)
// Renders the DB-Scope Overview directly in the activity-bar sidebar so the
// view is populated as soon as the extension activates (no command needed).

import * as vscode from 'vscode';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'dbscope.dashboardView';

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    webviewView.title = 'Dashboard';
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = DashboardViewProvider.overviewHtml();

    // Automatically open the main dashboard when this sidebar becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        vscode.commands.executeCommand('dbscope.openDashboard');
      }
    });

    // Open immediately on first resolve
    vscode.commands.executeCommand('dbscope.openDashboard');
  }

  private static overviewHtml(): string {
    const btn = (command: string, label: string): string =>
      `<a class="btn" href="command:${command}">${label}</a>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-sideBar-foreground);
      margin: 0;
      padding: 12px;
      font-size: var(--vscode-font-size);
    }
    h1 { font-size: 1.1em; margin: 0 0 4px; }
    p { opacity: 0.85; line-height: 1.4; }
    .btn {
      display: block;
      text-decoration: none;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-radius: 2px;
      padding: 6px 10px;
      margin: 6px 0;
      text-align: center;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .hint { opacity: 0.7; font-size: 0.9em; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>DB-Scope</h1>
  <p>AI-powered database lifecycle platform: impact analysis, diagnostics, merge conflicts &amp; duplicate detection.</p>
  ${btn('dbscope.openDashboard', 'Open Dashboard')}
  ${btn('dbscope.analyzeBlastRadius', 'Analyze Migration Impact')}
  ${btn('dbscope.detectDuplicates', 'Detect Logical Duplicates')}
  ${btn('dbscope.mergeDatabases', 'Analyze Merge Conflicts')}
  ${btn('dbscope.fetchContext', 'Fetch Database Context')}
  ${btn('dbscope.showHistory', 'Show Schema Timeline')}
  <p class="hint">Tip: hover any SQL query in the editor for an instant impact tooltip.</p>
</body>
</html>`;
  }
}
