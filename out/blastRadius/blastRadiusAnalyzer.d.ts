import { BlastRadiusResult } from '../core/types';
import { SchemaStateMap } from '../core/schemaStateMap';
import { WatsonxClient } from '../ai/watsonxClient';
export declare class BlastRadiusAnalyzer {
    private readonly schemaState;
    private readonly logger;
    private readonly ai;
    private analysisCache;
    constructor(schemaState: SchemaStateMap, ai?: WatsonxClient);
    analyze(sql: string): Promise<BlastRadiusResult>;
    private performConsolidatedAnalysis;
    private findAppDependencies;
    private detectDocumentationDrift;
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