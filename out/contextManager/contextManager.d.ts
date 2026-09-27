import * as vscode from 'vscode';
import { SchemaStateMap } from '../core/schemaStateMap';
export declare class ContextManager {
    private readonly schemaState;
    private readonly extensionContext;
    private readonly logger;
    private isFetching;
    private debounceTimer;
    private readonly DEBOUNCE_MS;
    private readonly CONNECT_TIMEOUT_MS;
    private readonly EXTRACT_TIMEOUT_MS;
    private statusBarItem;
    constructor(schemaState: SchemaStateMap, extensionContext: vscode.ExtensionContext, statusBarItem?: vscode.StatusBarItem);
    /**
     * Scans the entire workspace for schema definitions (migrations, ORM models,
     * SQL files, Prisma schemas) and optionally merges with a live DB schema.
     */
    fetchFromCodebase(): Promise<void>;
    private setStatus;
    private fetchLiveSchema;
    private withTimeout;
    private scanCodebase;
    private readSafe;
    private registerListeners;
    private debounce;
}
//# sourceMappingURL=contextManager.d.ts.map