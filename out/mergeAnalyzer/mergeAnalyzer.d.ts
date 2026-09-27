import { DatabaseSchema, MergeAnalysisResult } from '../core/types';
import { SchemaStateMap } from '../core/schemaStateMap';
export declare class MergeAnalyzer {
    private readonly schemaState;
    private readonly logger;
    constructor(schemaState: SchemaStateMap);
    promptAndAnalyze(): Promise<MergeAnalysisResult | null>;
    /**
     * Core analysis: compare schemaA and schemaB and produce a MergeAnalysisResult.
     */
    analyze(schemaA: DatabaseSchema, schemaB: DatabaseSchema): MergeAnalysisResult;
    private enrichWithBob;
    /**
     * Merges Bob's resolution objects back into the deterministic MergeConflict list.
     * For each conflict that Bob resolved, the suggestion is replaced with Bob's reason
     * and migration plan, and the reconciliation SQL is annotated.
     * All conflicts not covered by Bob are returned unchanged.
     */
    private applyBobResolutions;
    private compareColumns;
    private buildUnifiedSchema;
    private generateCreateTableSql;
    private generateTypeCastSql;
    private generateReconciledSql;
    private typesCompatible;
    private preferredType;
    private suggestTypeResolution;
    private parseSchemaFile;
    private parseColumnDefs;
}
//# sourceMappingURL=mergeAnalyzer.d.ts.map