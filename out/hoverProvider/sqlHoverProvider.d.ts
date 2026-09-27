import * as vscode from 'vscode';
import { BlastRadiusAnalyzer } from '../blastRadius/blastRadiusAnalyzer';
export declare class SqlHoverProvider implements vscode.HoverProvider {
    private readonly analyzer;
    private cache;
    private readonly CACHE_TTL_MS;
    constructor(analyzer: BlastRadiusAnalyzer);
    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null>;
    private extractSqlAtPosition;
    private extractStatementAt;
    private extractSqlFromString;
    private buildHover;
    private riskEmoji;
}
//# sourceMappingURL=sqlHoverProvider.d.ts.map