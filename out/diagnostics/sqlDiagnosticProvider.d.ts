import * as vscode from 'vscode';
import { SchemaStateMap } from '../core/schemaStateMap';
import { ContextManager } from '../contextManager/contextManager';
export declare class SqlDiagnosticProvider {
    private readonly schemaState;
    private readonly contextManager;
    private readonly logger;
    private debounceTimer;
    private readonly DEBOUNCE_MS;
    private readonly sessionAlerts;
    constructor(schemaState: SchemaStateMap, contextManager: ContextManager);
    register(collection: vscode.DiagnosticCollection, context: vscode.ExtensionContext): void;
    /**
     * Gate for "execute" flow: shows modal warnings before the user runs destructive SQL.
     * Called by extension.ts at the top of dbscope.analyzeBlastRadius command.
     */
    promptDestructiveGate(document: vscode.TextDocument): Promise<void>;
    private analyze;
    private processModals;
    private showModalWarning;
    private toVsDiagnostic;
    private toVsSeverity;
    private debounce;
}
//# sourceMappingURL=sqlDiagnosticProvider.d.ts.map