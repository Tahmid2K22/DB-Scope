// src/extension.ts -- Main entry point for DB-Scope VS Code Extension
import * as vscode from 'vscode';
import * as path from 'path';
import { BlastRadiusAnalyzer } from './blastRadius/blastRadiusAnalyzer';
import { SqlHoverProvider } from './hoverProvider/sqlHoverProvider';
import { SqlDiagnosticProvider } from './diagnostics/sqlDiagnosticProvider';
import { ContextManager } from './contextManager/contextManager';
import { DuplicateDetector } from './duplicateDetector/duplicateDetector';
import { MergeAnalyzer } from './mergeAnalyzer/mergeAnalyzer';
import { DashboardPanel } from './dashboard/dashboardPanel';
import { DashboardViewProvider } from './dashboard/dashboardViewProvider';
import { SchemaStateMap } from './core/schemaStateMap';
import { Logger } from './utils/logger';
import { SqlCodeActionProvider } from './diagnostics/sqlCodeActionProvider';

export async function activate(context: vscode.ExtensionContext) {
  const logger = Logger.getInstance();
  logger.info('DB-Scope extension activating...');

  // Initialize core schema state
  const schemaState = new SchemaStateMap(context);

  // Status bar item -- created before ContextManager so it can be injected
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(database) DB-Scope';
  statusBar.tooltip = 'DB-Scope: Click to open dashboard';
  statusBar.command = 'dbscope.openDashboard';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Initialize providers
  const contextManager = new ContextManager(schemaState, context, statusBar);
  const blastRadiusAnalyzer = new BlastRadiusAnalyzer(schemaState);
  const diagnosticProvider = new SqlDiagnosticProvider(schemaState, contextManager);
  const duplicateDetector = new DuplicateDetector(schemaState);
  const mergeAnalyzer = new MergeAnalyzer(schemaState);

  // Register SQL hover provider for .sql files and inline SQL strings
  const hoverProvider = new SqlHoverProvider(blastRadiusAnalyzer);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'sql' }, { language: 'typescript' }, { language: 'javascript' }, { language: 'python' }],
      hoverProvider
    )
  );

  // Register diagnostic collection
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('dbscope');
  context.subscriptions.push(diagnosticCollection);
  diagnosticProvider.register(diagnosticCollection, context);

  // Register code action provider (quick fixes)
  const codeActionProvider = new SqlCodeActionProvider(schemaState);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'sql' }],
      codeActionProvider,
      SqlCodeActionProvider.metadata
    )
  );

  // Auto-fetch context if enabled
  const config = vscode.workspace.getConfiguration('dbscope');
  if (config.get<boolean>('autoFetchContext')) {
    contextManager.fetchFromCodebase().catch(err =>
      logger.warn(`Auto context fetch failed: ${err.message}`)
    );
  }

  // Sidebar Overview: WebviewView so the sidebar shows content on activation (no command needed)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DashboardViewProvider.viewId,
      new DashboardViewProvider()
    )
  );

  // --- Dashboard message handler ---
  // Handles bidirectional communication between the webview dashboard and the extension.
  const pushSchemaStats = async () => {
    const panel = DashboardPanel.getCurrent();
    if (!panel) { return; }
    const summary = schemaState.getSchemaSummary();
    panel.updateStats(summary);
  };

  const dashboardMessageHandler = async (message: { command: string; [key: string]: unknown }) => {
    switch (message.command) {
      case 'ready':
        await pushSchemaStats();
        break;
      case 'runCommand': {
        const commandId = message.commandId as string;
        if (commandId) {
          await vscode.commands.executeCommand(`dbscope.${commandId}`);
          // After certain commands complete, refresh dashboard stats
          if (commandId === 'fetchContext' || commandId === 'openDashboard') {
            await pushSchemaStats();
          }
        }
        break;
      }
    }
  };

  // Helper to open dashboard with the message handler wired up
  const openDashboard = (payload: Parameters<typeof DashboardPanel.createOrShow>[1]) => {
    DashboardPanel.createOrShow(context.extensionUri, payload, dashboardMessageHandler);
  };

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('dbscope.analyzeBlastRadius', async () => {
      let document = vscode.window.activeTextEditor?.document;

      // No active editor (e.g. focus was on Command Palette / sidebar) —
      // let the user pick a SQL file from the workspace.
      if (!document) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'SQL / Source files': ['sql', 'ts', 'js', 'py', 'java'] },
          openLabel: 'Analyze this file',
        });
        if (!picked || picked.length === 0) { return; }
        document = await vscode.workspace.openTextDocument(picked[0]);
        await vscode.window.showTextDocument(document);
      }

      const editor = vscode.window.activeTextEditor;
      const sql = editor
        ? (editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection) || document.getText())
        : document.getText();
      const result = await blastRadiusAnalyzer.analyze(sql);
      openDashboard({ type: 'blastRadius', data: result });
    }),

    vscode.commands.registerCommand('dbscope.detectDuplicates', async () => {
      const schema = await schemaState.getCurrentSchema();
      if (!schema) {
        vscode.window.showWarningMessage('DB-Scope: No schema loaded. Run "Fetch Database Context" first.');
        return;
      }
      const duplicates = duplicateDetector.detect(schema);
      openDashboard({ type: 'duplicates', data: duplicates });
    }),

    vscode.commands.registerCommand('dbscope.mergeDatabases', async () => {
      const result = await mergeAnalyzer.promptAndAnalyze();
      if (result) {
        openDashboard({ type: 'merge', data: result });
      }
    }),

    vscode.commands.registerCommand('dbscope.fetchContext', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DB-Scope: Fetching database context...' },
        () => contextManager.fetchFromCodebase()
      );
      vscode.window.showInformationMessage('DB-Scope: Database context updated successfully.');
      // Push updated stats to dashboard if open
      await pushSchemaStats();
    }),

    vscode.commands.registerCommand('dbscope.openDashboard', () => {
      openDashboard({ type: 'overview', data: null });
    }),

    vscode.commands.registerCommand('dbscope.showHistory', async () => {
      const history = await schemaState.getHistory();
      openDashboard({ type: 'history', data: history });
    }),

    // Step 8: Export last analysis result to a JSON file
    vscode.commands.registerCommand('dbscope.exportAnalysis', async () => {
      let document = vscode.window.activeTextEditor?.document;

      if (!document) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'SQL / Source files': ['sql', 'ts', 'js', 'py', 'java'] },
          openLabel: 'Analyze this file',
        });
        if (!picked || picked.length === 0) { return; }
        document = await vscode.workspace.openTextDocument(picked[0]);
        await vscode.window.showTextDocument(document);
      }

      const editor = vscode.window.activeTextEditor;
      const sql = editor
        ? (editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection) || document.getText())
        : document.getText();
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DB-Scope: Running impact analysis...' },
        () => blastRadiusAnalyzer.analyze(sql)
      );
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`blast-radius-${Date.now()}.json`),
        filters: { 'JSON Report': ['json'] },
        saveLabel: 'Save Analysis Report',
      });
      if (!saveUri) { return; }
      const dir = path.dirname(saveUri.fsPath);
      const savedPath = await blastRadiusAnalyzer.exportResult(result, dir);
      vscode.window.showInformationMessage(`DB-Scope: Analysis saved to ${path.basename(savedPath)}`, 'Open').then(sel => {
        if (sel === 'Open') { vscode.env.openExternal(vscode.Uri.file(savedPath)); }
      });
    })
  );

  logger.info('DB-Scope extension activated successfully.');
}

export function deactivate() {
  Logger.getInstance().info('DB-Scope extension deactivated.');
}
