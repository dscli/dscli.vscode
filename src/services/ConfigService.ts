import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export interface Config {
    executablePath: string;
    model: string;
    streaming: boolean;
}

export class ConfigService {
    private config: Config;

    constructor() {
        this.config = this.loadConfig();
    }

    private loadConfig(): Config {
        const config = vscode.workspace.getConfiguration('dscli');
        return {
            executablePath: config.get<string>('executablePath') || 'dscli',
            model: config.get<string>('model') || 'deepseek-v4-flash',
            streaming: config.get<boolean>('streaming') ?? true,
        };
    }

    async initialize(): Promise<void> {
        logger.info('ConfigService 初始化');
    }

    getConfig(): Config {
        return { ...this.config };
    }

    async dispose(): Promise<void> {
        logger.info('ConfigService 清理');
    }
}
