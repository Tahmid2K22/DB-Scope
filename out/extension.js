"use strict";
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
exports.activate = activate;
exports.deactivate = deactivate;
// src/extension.ts — Main entry point for DB-Scope VS Code Extension
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const blastRadiusAnalyzer_1 = require("./blastRadius/blastRadiusAnalyzer");
const sqlHoverProvider_1 = require("./hoverProvider/sqlHoverProvider");
const sqlDiagnosticProvider_1 = require("./diagnostics/sqlDiagnosticProvider");
const contextManager_1 = require("./contextManager/contextManager");
const duplicateDetector_1 = require("./duplicateDetector/duplicateDetector");
const mergeAnalyzer_1 = require("./mergeAnalyzer/mergeAnalyzer");
const dashboardPanel_1 = require("./dashboard/dashboardPanel");
const schemaStateMap_1 = require("./core/schemaStateMap");
const logger_1 = require("./utils/logger");
async function activate(context) {
    const logger = logger_1.Logger.getInstance();
    logger.info('DB-Scope extension activating...');
    // Initialize core schema state
    const schemaState = new schemaStateMap_1.SchemaStateMap(context);
    // Initialize providers
    const contextManager = new contextManager_1.ContextManager(schemaState, context);
    const blastRadiusAnalyzer = new blastRadiusAnalyzer_1.BlastRadiusAnalyzer(schemaState);
    const diagnosticProvider = new sqlDiagnosticProvider_1.SqlDiagnosticProvider(schemaState, contextManager);
    const duplicateDetector = new duplicateDetector_1.DuplicateDetector(schemaState);
    const mergeAnalyzer = new mergeAnalyzer_1.MergeAnalyzer(schemaState);
    // Register SQL hover provider for .sql files and inline SQL strings
    const hoverProvider = new sqlHoverProvider_1.SqlHoverProvider(blastRadiusAnalyzer);
    context.subscriptions.push(vscode.languages.registerHoverProvider([{ language: 'sql' }, { language: 'typescript' }, { language: 'javascript' }, { language: 'python' }], hoverProvider));
    // Register diagnostic collection
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('dbscope');
    context.subscriptions.push(diagnosticCollection);
    diagnosticProvider.register(diagnosticCollection, context);
    // Auto-fetch context if enabled
    const config = vscode.workspace.getConfiguration('dbscope');
    if (config.get('autoFetchContext')) {
        contextManager.fetchFromCodebase().catch(err => logger.warn(`Auto context fetch failed: ${err.message}`));
    }
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('dbscope.analyzeBlastRadius', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('DB-Scope: No active editor.');
            return;
        }
        const sql = editor.document.getText(editor.selection) || editor.document.getText();
        const result = await blastRadiusAnalyzer.analyze(sql);
        dashboardPanel_1.DashboardPanel.createOrShow(context.extensionUri, { type: 'blastRadius', data: result });
    }), vscode.commands.registerCommand('dbscope.detectDuplicates', async () => {
        const schema = await schemaState.getCurrentSchema();
        if (!schema) {
            vscode.window.showWarningMessage('DB-Scope: No schema loaded. Run "Fetch Database Context" first.');
            return;
        }
        const duplicates = duplicateDetector.detect(schema);
        dashboardPanel_1.DashboardPanel.createOrShow(context.extensionUri, { type: 'duplicates', data: duplicates });
    }), vscode.commands.registerCommand('dbscope.mergeDatabases', async () => {
        const result = await mergeAnalyzer.promptAndAnalyze();
        if (result) {
            dashboardPanel_1.DashboardPanel.createOrShow(context.extensionUri, { type: 'merge', data: result });
        }
    }), vscode.commands.registerCommand('dbscope.fetchContext', async () => {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DB-Scope: Fetching database context...' }, () => contextManager.fetchFromCodebase());
        vscode.window.showInformationMessage('DB-Scope: Database context updated successfully.');
    }), vscode.commands.registerCommand('dbscope.openDashboard', () => {
        dashboardPanel_1.DashboardPanel.createOrShow(context.extensionUri, { type: 'overview', data: null });
    }), vscode.commands.registerCommand('dbscope.showHistory', async () => {
        const history = await schemaState.getHistory();
        dashboardPanel_1.DashboardPanel.createOrShow(context.extensionUri, { type: 'history', data: history });
    }), 
    // Step 8: Export last analysis result to a JSON file
    vscode.commands.registerCommand('dbscope.exportAnalysis', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('DB-Scope: No active editor to analyze.');
            return;
        }
        const sql = editor.document.getText(editor.selection) || editor.document.getText();
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DB-Scope: Running blast radius analysis...' }, () => blastRadiusAnalyzer.analyze(sql));
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`blast-radius-${Date.now()}.json`),
            filters: { 'JSON Report': ['json'] },
            saveLabel: 'Save Analysis Report',
        });
        if (!saveUri) {
            return;
        }
        const dir = path.dirname(saveUri.fsPath);
        const savedPath = await blastRadiusAnalyzer.exportResult(result, dir);
        vscode.window.showInformationMessage(`DB-Scope: Analysis saved to ${path.basename(savedPath)}`, 'Open').then(sel => {
            if (sel === 'Open') {
                vscode.env.openExternal(vscode.Uri.file(savedPath));
            }
        });
    }));
    // Status bar item
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.text = '$(database) DB-Scope';
    statusBar.tooltip = 'DB-Scope: Click to open dashboard';
    statusBar.command = 'dbscope.openDashboard';
    statusBar.show();
    context.subscriptions.push(statusBar);
    logger.info('DB-Scope extension activated successfully.');
}
function deactivate() {
    logger_1.Logger.getInstance().info('DB-Scope extension deactivated.');
}
//# sourceMappingURL=extension.js.map