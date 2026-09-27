export declare class Logger {
    private static instance;
    private readonly channel;
    private constructor();
    static getInstance(): Logger;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, err?: unknown): void;
    private log;
}
//# sourceMappingURL=logger.d.ts.map