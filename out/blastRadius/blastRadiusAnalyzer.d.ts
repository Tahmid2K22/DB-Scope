import { BlastRadiusResult } from '../core/types';
import { SchemaStateMap } from '../core/schemaStateMap';
import { WatsonxClient } from '../ai/watsonxClient';
export declare class BlastRadiusAnalyzer {
    private readonly schemaState;
    private readonly logger;
    private readonly ai;
    constructor(schemaState: SchemaStateMap, ai?: WatsonxClient);
    analyze(sql: string): Promise<BlastRadiusResult>;
    private analyzeSchemaImpact;
    private findAppDependencies;
    private assessDataIntegrityRisks;
    private detectDocumentationDrift;
    private calculateRiskScore;
    private buildRollbackSuggestions;
    exportResult(result: BlastRadiusResult, targetDir: string): Promise<string>;
    private buildSchemaContext;
    /** Extract the first JSON object from a Granite response that may contain markdown fences. */
    private extractJson;
    private normalizeRiskLevel;
    private scoreToLevel;
    /** Derives the ORM model class name: "order_items" → "OrderItem", "users" → "User" */
    private deriveModelName;
}
//# sourceMappingURL=blastRadiusAnalyzer.d.ts.map