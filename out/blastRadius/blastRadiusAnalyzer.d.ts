import { BlastRadiusResult } from '../core/types';
import { SchemaStateMap } from '../core/schemaStateMap';
export declare class BlastRadiusAnalyzer {
    private readonly schemaState;
    private readonly logger;
    constructor(schemaState: SchemaStateMap);
    analyze(sql: string): Promise<BlastRadiusResult>;
    private analyzeSchemaImpact;
    private findAppDependencies;
    /**
     * Derives the ORM model class name from a table name.
     * "users" → "User",  "order_items" → "OrderItem",  "categories" → "Category"
     */
    private deriveModelName;
    private classifyDepSeverity;
    private assessDataIntegrityRisks;
    private detectDocumentationDrift;
    private calculateRiskScore;
    /** Returns a multiplier based on the largest rowCount of affected tables. */
    private getTableSizeFactor;
    private scoreToLevel;
    private buildSuggestions;
    private buildRollbackSuggestions;
    exportResult(result: BlastRadiusResult, targetDir: string): Promise<string>;
}
//# sourceMappingURL=blastRadiusAnalyzer.d.ts.map