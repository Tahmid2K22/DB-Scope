import * as vscode from 'vscode';
import { DatabaseSchema, SchemaSnapshot, TableDefinition } from './types';
export declare class SchemaStateMap {
    private readonly context;
    private currentSchema;
    private history;
    private readonly logger;
    constructor(context: vscode.ExtensionContext);
    getCurrentSchema(): Promise<DatabaseSchema | null>;
    updateSchema(schema: DatabaseSchema): Promise<void>;
    getHistory(): Promise<SchemaSnapshot[]>;
    getTable(tableName: string): TableDefinition | null;
    getAllTableNames(): string[];
    private loadFromStorage;
    private persistToStorage;
    private diffCount;
}
//# sourceMappingURL=schemaStateMap.d.ts.map