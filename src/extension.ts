/**
 * dscli VSCode扩展 - 精简版入口
 * 
 * 核心功能：
 * 1. ChatPanel - 聊天面板，通过 dscli CLI 与 DeepSeek 交互
 * 2. SecretService - API Key 安全管理
 * 3. ConfigService - 配置管理
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './utils/logger';
import { ConfigService } from './services/ConfigService';
import { SecretService } from './services/SecretService';
import { ProcessService } from './services/ProcessService';
import { ChatPanel } from './ui/ChatPanel';

const execFileAsync = promisify(execFile);

// 模块级引用，供 deactivate() 清理时使用
let extensionInstance: DscliExtension | undefined;

export class DscliExtension {
    private context: vscode.ExtensionContext;
    private configService: ConfigService;
    private secretService: SecretService;
    private processService: ProcessService;
    private chatPanel: ChatPanel | null = null;

    private statusBarItem: vscode.StatusBarItem;
    private isInitialized = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.configService = new ConfigService();
        this.secretService = new SecretService(context);
        this.processService = new ProcessService();

        // 状态栏
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right, 100
        );
        this.statusBarItem.command = 'dscli.openChat';
        this.statusBarItem.tooltip = '打开 dscli 聊天面板';
        this.context.subscriptions.push(this.statusBarItem);
    }

    /**
     * 初始化扩展 - 所有初始化失败都不阻止激活
     */
    public async initialize(): Promise<void> {
        try {
            logger.info('初始化 dscli 扩展...');

            // 配置服务
            try {
                await this.configService.initialize();
            } catch (e) {
                logger.warn('ConfigService 初始化失败', e);
            }

            // 进程服务
            try {
                await this.processService.initialize();
            } catch (e) {
                logger.warn('ProcessService 初始化失败', e);
            }

            this.isInitialized = true;
            this.updateStatusBar();

            // 延迟检查 dscli 可执行文件（不阻塞激活）
            setTimeout(() => this.probeDscli(), 2000);

            logger.info('dscli 扩展初始化完成');


        } catch (error) {
            logger.error('扩展初始化失败', error);
            this.isInitialized = true;
        }
    }

    /**
     * 探测 dscli 可执行文件
     */
    private async probeDscli(): Promise<void> {
        try {
            const executablePath = this.configService.getConfig().executablePath;
            await execFileAsync(executablePath, ['version'], { timeout: 3000 });
            logger.info('dscli 可执行文件探测成功');
        } catch (error: any) {
            logger.warn('dscli 可执行文件未找到，聊天功能需要安装 dscli', error);
        }
    }



    /**
     * 更新状态栏
     */
    private updateStatusBar(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const projectName = path.basename(workspaceFolders[0].uri.fsPath);
            this.statusBarItem.text = `$(hubot) dscli: ${projectName}`;
        } else {
            this.statusBarItem.text = `$(hubot) dscli`;
        }
        this.statusBarItem.show();
    }

    /**
     * 打开聊天面板
     */
    public async openChat(): Promise<void> {
        try {
            if (!this.chatPanel) {
                this.chatPanel = new ChatPanel(
                    this.processService,
                    this.configService,
                    this.secretService,
                    this.context
                );
            }
            this.chatPanel.show();
        } catch (error) {
            logger.error('打开聊天面板失败', error);
            vscode.window.showErrorMessage(
                `打开聊天面板失败: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * 检查系统状态
     */
    public async checkStatus(): Promise<void> {
        const config = this.configService.getConfig();
        const hasApiKey = !!(await this.secretService.getApiKey());

        let message = '📊 dscli 系统状态\n\n';
        message += `扩展状态: ${this.isInitialized ? '✅ 已激活' : '❌ 未激活'}\n`;
        message += `API Key: ${hasApiKey ? '✅ 已配置' : '⚠️ 未配置'}\n`;
        message += `dscli 路径: ${config.executablePath}\n`;

        try {
            const result = await execFileAsync(config.executablePath, ['version'], {
                timeout: 2000
            });
            message += `dscli 版本: ${result.stdout.trim()}\n`;
            message += `dscli 状态: ✅ 可用\n`;
        } catch (error: any) {
            message += `dscli 状态: ❌ 不可用\n`;
        }

        message += `\n📋 可用命令:\n`;
        message += `• dscli: Start Chat - 打开聊天面板\n`;
        message += `• dscli: Set API Key - 配置 API Key\n`;
        message += `• dscli: Check System Status - 本页面\n`;

        vscode.window.showInformationMessage(message, { modal: true });
    }

    /**
     * 设置 API Key
     */
    public async setApiKey(): Promise<void> {
        const key = await vscode.window.showInputBox({
            prompt: '请输入 DEEPSEEK_API_KEY',
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'sk-...'
        });

        if (key) {
            await this.secretService.storeApiKey(key.trim());
            vscode.window.showInformationMessage('🔑 API Key 已安全保存！');
        }
    }

    /**
     * 清空聊天历史
     */
    public async clearHistory(): Promise<void> {
        if (this.chatPanel) {
            this.chatPanel.dispose();
            this.chatPanel = null;
        }
        vscode.window.showInformationMessage('聊天历史已清空');
    }

    /**
     * 中断当前进程
     */
    public async interrupt(): Promise<void> {
        this.processService.dispose();
        vscode.window.showInformationMessage('当前操作已中断');
    }

    /**
     * 分析当前文件
     */
    public async analyzeCurrentFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('没有打开的文件');
            return;
        }

        const document = editor.document;
        const selection = editor.selection;

        let content: string;
        if (!selection.isEmpty) {
            content = document.getText(selection);
        } else {
            content = document.getText();
        }

        await this.openChat();
        if (this.chatPanel) {
            const contextInfo = `📄 文件: ${document.fileName}\n语言: ${document.languageId}\n行数: ${document.lineCount}\n\n请分析以下代码:\n\`\`\`${document.languageId}\n${content.slice(0, 8000)}\n\`\`\``;
            this.chatPanel.sendUserMessage(contextInfo);
        }
    }

    /**
     * 清理资源
     */
    public async dispose(): Promise<void> {
        logger.info('清理扩展资源...');
        if (this.chatPanel) {
            this.chatPanel.dispose();
            this.chatPanel = null;
        }
        this.processService.dispose();
        this.isInitialized = false;
    }
}

/**
 * 激活扩展
 */
export async function activate(context: vscode.ExtensionContext): Promise<DscliExtension> {
    try {
        logger.info('激活 dscli VSCode 扩展...');

        const extension = new DscliExtension(context);
        extensionInstance = extension;
        await extension.initialize();

        // 注册命令
        const commands = [
            vscode.commands.registerCommand('dscli.openChat', () => extension.openChat()),
            vscode.commands.registerCommand('dscli.analyzeFile', () => extension.analyzeCurrentFile()),
            vscode.commands.registerCommand('dscli.setApiKey', () => extension.setApiKey()),
            vscode.commands.registerCommand('dscli.checkStatus', () => extension.checkStatus()),
            vscode.commands.registerCommand('dscli.clearHistory', () => extension.clearHistory()),
            vscode.commands.registerCommand('dscli.interrupt', () => extension.interrupt()),
        ];

        commands.forEach(cmd => context.subscriptions.push(cmd));

        logger.info('dscli 扩展激活完成');
        return extension;

    } catch (error) {
        logger.error('激活扩展失败', error);
        vscode.window.showErrorMessage(
            `dscli 激活失败: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
    }
}

/**
 * 停用扩展
 */
export async function deactivate(): Promise<void> {
    logger.info('停用 dscli 扩展');
    await extensionInstance?.dispose();
    extensionInstance = undefined;
}