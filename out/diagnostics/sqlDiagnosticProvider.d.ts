import * as vscode from 'vscode';
import { SchemaStateMap } from '../core/schemaStateMap';
import { ContextManager } from '../contextManager/contextManager';
export declare class SqlDiagnosticProvider {
    private readonly schemaState;
    private readonly contextManager;
    private readonly logger;
    private debounceTimer;
    private readonly DEBOUNCE_MS;
    private interruptShown;
    constructor(schemaState: SchemaStateMap, contextManager: ContextManager);
    register(collection: vscode.DiagnosticCollection, context: vscode.ExtensionContext): void;
    private analyze;
    private runRules;
    private toVsDiagnostic;
    private toVsSeverity;
    private showInterruptWarning;
    private debounce;
}
//# sourceMappingURL=sqlDiagnosticProvider.d.ts.map