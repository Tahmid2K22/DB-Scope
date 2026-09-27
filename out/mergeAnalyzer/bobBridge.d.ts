import { MergeConflict, DatabaseSchema } from '../core/types';
export type BobResolution = 'rename' | 'keep_a' | 'keep_b' | 'merge' | 'manual_review';
export interface BobAffectedFile {
    path: string;
    reason: string;
}
export interface BobAffectedSymbol {
    name: string;
    kind: string;
    file: string;
}
export interface BobConflictResolution {
    conflictId: string;
    resolution: BobResolution;
    confidence: number;
    reason: string;
    semanticEquivalent: boolean;
    oldReference: {
        table: string;
        column?: string;
    };
    newReference: {
        table: string;
        column?: string;
    };
    affectedFiles: BobAffectedFile[];
    affectedSymbols: BobAffectedSymbol[];
    migrationPlan: string[];
    applicationChanges: string[];
    testsToUpdate: string[];
    risks: string[];
}
export interface BobBridgeResult {
    available: boolean;
    resolutions: BobConflictResolution[];
    rawOutput?: string;
    error?: string;
}
/** Returns the subset of conflicts worth sending to Bob. */
export declare function filterSemanticallyRelevant(conflicts: MergeConflict[]): MergeConflict[];
export declare function conflictId(c: MergeConflict): string;
export declare function buildBobPrompt(workspaceRoot: string, conflicts: MergeConflict[], schemaA: DatabaseSchema, schemaB: DatabaseSchema): string;
export declare function extractJson(raw: string): BobConflictResolution[] | null;
/** Returns true if `bob` is on PATH without throwing. */
export declare function isBobAvailable(): Promise<boolean>;
export declare function invokeBobForMergeAnalysis(prompt: string, workspaceRoot: string): Promise<BobBridgeResult>;
//# sourceMappingURL=bobBridge.d.ts.map