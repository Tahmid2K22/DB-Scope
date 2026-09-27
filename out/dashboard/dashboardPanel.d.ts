import * as vscode from 'vscode';
import { BlastRadiusResult, MergeAnalysisResult, DuplicateGroup, SchemaSnapshot } from '../core/types';
export type DashboardPayload = {
    type: 'overview';
    data: null;
} | {
    type: 'blastRadius';
    data: BlastRadiusResult;
} | {
    type: 'merge';
    data: MergeAnalysisResult;
} | {
    type: 'duplicates';
    data: DuplicateGroup[];
} | {
    type: 'history';
    data: SchemaSnapshot[];
};
export declare class DashboardPanel {
    private readonly extensionUri;
    static currentPanel: DashboardPanel | undefined;
    private readonly _panel;
    private _disposables;
    private constructor();
    static createOrShow(extensionUri: vscode.Uri, payload: DashboardPayload): void;
    private _update;
    private titleFor;
    dispose(): void;
    private getHtml;
    private baseHtml;
    private blastRadiusHtml;
    private mergeHtml;
    private duplicatesHtml;
    private historyHtml;
    private overviewHtml;
    private esc;
}
//# sourceMappingURL=dashboardPanel.d.ts.map