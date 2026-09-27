import * as vscode from 'vscode';
import { BlastRadiusAnalyzer } from '../blastRadius/blastRadiusAnalyzer';
export declare class SqlHoverProvider implements vscode.HoverProvider {
    private readonly analyzer;
    private cache;
    private readonly CACHE_TTL_MS;
    constructor(analyzer: BlastRadiusAnalyzer);
    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null>;
    private generateHoverSummary;
    private buildHover;
    /** Render one confidence bar line:  "Schema Impact      ████████░░  85%  reason" */
    private confidenceLine;
    /** Returns the DimensionConfidence with the lowest score (excluding overall). */
    private lowestConfidence;
    private extractSqlAtPosition;
    private extractStatementAt;
    private extractSqlFromString;
    private riskEmoji;
}
//# sourceMappingURL=sqlHoverProvider.d.ts.map