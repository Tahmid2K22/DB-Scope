// src/utils/logger.ts — Simple singleton logger for DB-Scope
import * as vscode from 'vscode';

export class Logger {
  private static instance: Logger;
  private readonly channel: vscode.OutputChannel;

  private constructor() {
    this.channel = vscode.window.createOutputChannel('DB-Scope');
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  info(message: string): void {
    this.log('INFO', message);
  }

  warn(message: string): void {
    this.log('WARN', message);
  }

  error(message: string, err?: unknown): void {
    this.log('ERROR', message);
    if (err instanceof Error) {
      this.log('ERROR', err.stack ?? err.message);
    }
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] [${level}] ${message}`);
  }
}
