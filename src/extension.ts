/**
 * dscli VSCode扩展 - 精简版入口
 *
 * 核心功能：
 * 1. ChatPanelManager - 多实例聊天面板管理
 * 2. SecretService - API Key 安全管理
 * 3. ConfigService - 配置管理
 * 4. setupProcessEnv - 一次性进程环境初始化（AskUser PATH）
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './utils/logger';
import { ConfigService } from './services/ConfigService';
import { SecretService } from './services/SecretService';
import { ProcessService } from './services/ProcessService';
import { ChatPanelManager } from './ui/ChatPanelManager';
import { resolveEditorValue, getVscodeCliDir } from './utils/env';

const execFileAsync = promisify(execFile);

// 模块级引用，供 deactivate() 清理时使用
let extensionInstance: DscliExtension | undefined;

export class DscliExtension {
    private context: vscode.ExtensionContext;
    private configService: ConfigService;
    private secretService: SecretService;
    private processService: ProcessService;
    private chatPanelManager: ChatPanelManager;

    private statusBarItem: vscode.StatusBarItem;
    private isInitialized = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.configService = new ConfigService();
        this.secretService = new SecretService(context);
        this.processService = new ProcessService();
        this.chatPanelManager = new ChatPanelManager(
            this.processService,
            this.configService,
            this.secretService,
            context.extensionUri,
        );

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

            // 一次性设置 AskUser 所需的进程环境（process.env.PATH）
            // 必须在任何 dscli 子进程启动前执行
            try {
                this.setupProcessEnv();
                logger.info('AskUser 环境初始化完成');
            } catch (e) {
                logger.warn('AskUser 环境初始化失败', e);
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
     * 一次性设置子进程环境变量，支持 AskUser 功能。
     *
     * 将 VSCode CLI (code) 所在目录注入 process.env.PATH，使 dscli 的
     * AskUser 功能能通过 exec.LookPath("code") 找到 code CLI。
     *
     * 仅在扩展激活时执行一次，不在每次消息处理时修改全局 PATH，
     * 避免并发消息的竞态条件。
     */
    private setupProcessEnv(): void {
        const appRoot = vscode.env.appRoot;
        if (!appRoot) {
            logger.debug('AskUser: vscode.env.appRoot 为空，跳过 PATH 设置');
            return;
        }

        const editorVal = resolveEditorValue(appRoot);
        if (!editorVal) {
            logger.debug('AskUser: code CLI 不可用，跳过 PATH 设置');
            return;
        }

        const codeDir = getVscodeCliDir(appRoot);
        if (!codeDir) {
            logger.debug('AskUser: code CLI 目录不可用');
            return;
        }

        const sep = path.delimiter;

        // Unix PATH
        const currentPath = process.env.PATH || '';
        if (!currentPath.split(sep).filter(Boolean).includes(codeDir)) {
            process.env.PATH = codeDir + sep + currentPath;
            logger.debug('AskUser: 注入 code CLI 目录到 process.env.PATH', { codeDir });
        }

        // Windows: Go 的 exec.LookPath 也会检查 Path 变量
        if (process.platform === 'win32' && process.env.Path) {
            const winDirs = (process.env.Path || '').split(sep).filter(Boolean);
            if (!winDirs.includes(codeDir)) {
                process.env.Path = codeDir + sep + (process.env.Path || '');
            }
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
     * 打开聊天面板 — 基于当前 active editor 所在 workspace。
     */
    public async openChat(): Promise<void> {
        try {
            await this.chatPanelManager.getOrCreateForActiveEditor();
        } catch (error) {
            logger.error('打开聊天面板失败', error);
            vscode.window.showErrorMessage(
                `打开聊天面板失败: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * 为指定文件夹打开聊天面板。
     */
    public async openChatForFolder(): Promise<void> {
        const selected = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: '在此目录打开 ChatPanel',
        });
        if (selected?.[0]) {
            this.chatPanelManager.openChat(selected[0].fsPath);
        }
    }

    /**
     * 列出所有活跃面板 — 选择后聚焦。
     */
    public async listChats(): Promise<void> {
        await this.chatPanelManager.showPanelPicker();
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
        message += `活跃面板: ${this.chatPanelManager.listPanels().length} 个\n`;

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
        message += `• dscli: Open Chat - 打开当前项目的聊天面板\n`;
        message += `• dscli: Open Chat for Folder - 为指定目录打开聊天面板\n`;
        message += `• dscli: List Chats - 列出并切换活跃面板\n`;
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
     * 清空对话历史
     */
    public async clearHistory(): Promise<void> {
        await this.chatPanelManager.handleClearHistory();
    }

    /**
     * 中断当前活跃面板的处理进程。
     * 不再杀死所有进程 — 只中断用户当前正在交互的面板。
     */
    public async interrupt(): Promise<void> {
        const interrupted = this.chatPanelManager.interruptActive();
        if (interrupted) {
            vscode.window.showInformationMessage('已中断当前对话');
        } else {
            logger.debug('interrupt: 没有正在处理的面板');
        }
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

        const panel = await this.chatPanelManager.getOrCreateForActiveEditor();
        const contextInfo = `📄 文件: ${document.fileName}\n语言: ${document.languageId}\n行数: ${document.lineCount}\n\n请分析以下代码:\n\`\`\`${document.languageId}\n${content.slice(0, 8000)}\n\`\`\``;
        panel.sendUserMessage(contextInfo);
    }

    /**
     * 清理资源
     */
    public async dispose(): Promise<void> {
        logger.info('清理扩展资源...');
        this.chatPanelManager.dispose();
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
            vscode.commands.registerCommand('dscli.openChatForFolder', () => extension.openChatForFolder()),
            vscode.commands.registerCommand('dscli.listChats', () => extension.listChats()),
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
