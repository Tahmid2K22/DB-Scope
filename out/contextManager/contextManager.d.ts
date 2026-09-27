import * as vscode from 'vscode';
import { SchemaStateMap } from '../core/schemaStateMap';
export declare class ContextManager {
    private readonly schemaState;
    private readonly extensionContext;
    private readonly logger;
    private isFetching;
    private debounceTimer;
    private readonly DEBOUNCE_MS;
    constructor(schemaState: SchemaStateMap, extensionContext: vscode.ExtensionContext);
    /**
     * Scans the entire workspace for schema definitions (migrations, ORM models,
     * SQL files, Prisma schemas) and builds/updates the SchemaStateMap.
     */
    fetchFromCodebase(): Promise<void>;
    private scanCodebase;
    private parseSqlFile;
    private parseColumnDefinitions;
    private splitColumnDefs;
    private extractReferences;
    private parsePrismaSchema;
    private parseModelFile;
    private registerListeners;
    private debounce;
    private statusBarItem;
    private updateStatusBar;
}
//# sourceMappingURL=contextManager.d.ts.map