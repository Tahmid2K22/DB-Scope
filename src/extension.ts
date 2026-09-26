// src/extension.ts — Main entry point for DB-Scope VS Code Extension
import * as vscode from 'vscode';
import { BlastRadiusAnalyzer } from './blastRadius/blastRadiusAnalyzer';
import { SqlHoverProvider } from './hoverProvider/sqlHoverProvider';
import { SqlDiagnosticProvider } from './diagnostics/sqlDiagnosticProvider';
import { ContextManager } from './contextManager/contextManager';
import { DuplicateDetector } from './duplicateDetector/duplicateDetector';
import { MergeAnalyzer } from './mergeAnalyzer/mergeAnalyzer';
import { DashboardPanel } from './dashboard/dashboardPanel';
import { SchemaStateMap } from './core/schemaStateMap';
import { Logger } from './utils/logger';

export async function activate(context: vscode.ExtensionContext) {
  const logger = Logger.getInstance();
  logger.info('DB-Scope extension activating...');

  // Initialize core schema state
  const schemaState = new SchemaStateMap(context);

  // Initialize providers
  const contextManager = new ContextManager(schemaState, context);
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

  // Auto-fetch context if enabled
  const config = vscode.workspace.getConfiguration('dbscope');
  if (config.get<boolean>('autoFetchContext')) {
    contextManager.fetchFromCodebase().catch(err =>
      logger.warn(`Auto context fetch failed: ${err.message}`)
    );
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('dbscope.analyzeBlastRadius', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('DB-Scope: No active editor.');
        return;
      }
      const sql = editor.document.getText(editor.selection) || editor.document.getText();
      const result = await blastRadiusAnalyzer.analyze(sql);
      DashboardPanel.createOrShow(context.extensionUri, { type: 'blastRadius', data: result });
    }),

    vscode.commands.registerCommand('dbscope.detectDuplicates', async () => {
      const schema = await schemaState.getCurrentSchema();
      if (!schema) {
        vscode.window.showWarningMessage('DB-Scope: No schema loaded. Run "Fetch Database Context" first.');
        return;
      }
      const duplicates = duplicateDetector.detect(schema);
      DashboardPanel.createOrShow(context.extensionUri, { type: 'duplicates', data: duplicates });
    }),

    vscode.commands.registerCommand('dbscope.mergeDatabases', async () => {
      const result = await mergeAnalyzer.promptAndAnalyze();
      if (result) {
        DashboardPanel.createOrShow(context.extensionUri, { type: 'merge', data: result });
      }
    }),

    vscode.commands.registerCommand('dbscope.fetchContext', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DB-Scope: Fetching database context...' },
        () => contextManager.fetchFromCodebase()
      );
      vscode.window.showInformationMessage('DB-Scope: Database context updated successfully.');
    }),

    vscode.commands.registerCommand('dbscope.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri, { type: 'overview', data: null });
    }),

    vscode.commands.registerCommand('dbscope.showHistory', async () => {
      const history = await schemaState.getHistory();
      DashboardPanel.createOrShow(context.extensionUri, { type: 'history', data: history });
    })
  );

  // Status bar item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(database) DB-Scope';
  statusBar.tooltip = 'DB-Scope: Click to open dashboard';
  statusBar.command = 'dbscope.openDashboard';
  statusBar.show();
  context.subscriptions.push(statusBar);

  logger.info('DB-Scope extension activated successfully.');
}

export function deactivate() {
  Logger.getInstance().info('DB-Scope extension deactivated.');
}
