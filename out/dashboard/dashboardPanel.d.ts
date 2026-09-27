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
export type DashboardMessageHandler = (message: {
    command: string;
    [key: string]: unknown;
}) => void;
export declare class DashboardPanel {
    private readonly extensionUri;
    static currentPanel: DashboardPanel | undefined;
    private readonly _panel;
    private _disposables;
    private _shellLoaded;
    private _onMessage;
    private constructor();
    static createOrShow(extensionUri: vscode.Uri, payload: DashboardPayload, onMessage?: DashboardMessageHandler): void;
    static getCurrent(): DashboardPanel | undefined;
    updateStats(stats: {
        tableCount: number;
        columnCount: number;
        lastUpdated: number | null;
    }): void;
    private _pushView;
    private titleFor;
    dispose(): void;
    private getContentHtml;
    private shellHtml;
    private overviewHtml;
    private blastRadiusHtml;
    private mergeHtml;
    private duplicatesHtml;
    private historyHtml;
    private esc;
}
//# sourceMappingURL=dashboardPanel.d.ts.map