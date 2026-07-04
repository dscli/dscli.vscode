/**
 * 聊天面板组件 - 通过 dscli CLI 与 DeepSeek 交互
 *
 * 每个 ChatPanel 实例绑定一个固定的项目目录 (cwd)。
 * 多实例管理由 ChatPanelManager 负责。
 *
 * HTML/CSS/JS 模板位于 media/chatPanel.html，通过 fs.readFileSync 加载。
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ProcessService } from '../services/ProcessService';
import { ConfigService } from '../services/ConfigService';
import { SecretService } from '../services/SecretService';
import { resolveEditorValue, getVscodeCliDir } from '../utils/env';
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    isStreaming?: boolean;
    isError?: boolean;
}

export class ChatPanel {
    // 依赖注入
    private panel: vscode.WebviewPanel | null = null;
    private processService: ProcessService;
    private configService: ConfigService;
    private secretService: SecretService;
    private extensionUri: vscode.Uri;

    // 状态
    private currentMessages: ChatMessage[] = [];
    private messageCounter = 0;
    private currentProcessId: string | null = null;
    private isInterrupted = false;

    // 流式输出缓冲
    private streamBuffer = '';
    private streamMessageId: string | null = null;

    // dispose 回调 — ChatPanelManager 注册清理用
    private onDisposeHandlers: Array<() => void> = [];

    // 面板标识（不可变）
    private readonly _cwd: string;
    private readonly _projectName: string;

    constructor(
        processService: ProcessService,
        configService: ConfigService,
        secretService: SecretService,
        extensionUri: vscode.Uri,
        cwd: string,
    ) {
        this.processService = processService;
        this.configService = configService;
        this.secretService = secretService;
        this.extensionUri = extensionUri;
        this._cwd = cwd;
        this._projectName = path.basename(cwd);

        logger.debug('ChatPanel 创建', { cwd, projectName: this._projectName });
    }

    /** 当前面板绑定的项目目录（不可变） */
    get cwd(): string { return this._cwd; }

    /** 当前面板绑定的项目名（基于目录名的 basename） */
    get projectName(): string { return this._projectName; }

    /** 获取当前消息列表（副本） */
    getMessages(): ChatMessage[] {
        return [...this.currentMessages];
    }

    /**
     * 创建并显示（或 reveal）WebviewPanel。
     */
    show(): vscode.WebviewPanel {
        if (this.panel) {
            this.panel.reveal();
            return this.panel;
        }

        this.panel = vscode.window.createWebviewPanel(
            'dscliChat',
            `dscli: ${this._projectName}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                // 不加 localResourceRoots，默认允许全部本地资源
                // 当前不需要加载本地图片/字体
            },
        );

        this.panel.webview.html = this.getHtml();
        this.setupMessageHandler();

        this.panel.onDidDispose(() => {
            this.panel = null;
            this.interruptProcess();
            this.notifyDispose();
        });

        // 发送初始工作目录和欢迎消息
        setTimeout(async () => {
            this.broadcastCwd();

            // TODO: 从 dscli 数据库加载历史记录（后续 PR 实现）
            // await this.loadHistoryFromDscli();

            const hasApiKey = !!(await this.secretService.getApiKey());
            const welcome = hasApiKey
                ? `👋 欢迎使用 dscli！当前项目: **${this._projectName}**。输入你的问题开始对话。`
                : '👋 欢迎使用 dscli！输入你的问题开始对话。\n\n💡 提示：先用命令面板 (Cmd+Shift+P) 执行 **dscli: Set API Key** 配置 API Key。\n\nAPI Key 全局存储，只需设置一次即可在所有项目中使用。';

            this.postMessage('addMessage', {
                role: 'system',
                content: welcome,
                isStreaming: false,
                isError: false,
            });
        }, 200);

        return this.panel;
    }

    /**
     * 仅 reveal 已有面板，不创建。
     */
    reveal(): void {
        if (this.panel) {
            this.panel.reveal();
        }
    }

    /**
     * 发送用户消息（由外部调用，如 analyzeFile）。
     */
    sendUserMessage(content: string): void {
        this.handleUserMessage(content);
    }

    /**
     * 注册 dispose 回调。ChatPanelManager 使用此机制自动清理。
     */
    onDidDispose(handler: () => void): void {
        this.onDisposeHandlers.push(handler);
    }

    /**
     * 释放资源。
     */
    dispose(): void {
        this.interruptProcess();
        if (this.panel) {
            this.panel.dispose();
            this.panel = null;
        }
        this.currentMessages = [];
        // 无论 WebviewPanel 是否已创建，都要通知 dispose 回调
        this.notifyDispose();
        this.onDisposeHandlers = [];
        logger.debug('ChatPanel 已释放', { cwd: this._cwd });
    }

    // -----------------------------------------------------------------------
    // 工作目录显示
    // -----------------------------------------------------------------------

    private broadcastCwd(): void {
        this.postMessage('setCwd', {
            path: this.formatCwdDisplay(this._cwd),
            fullPath: this._cwd,
        });
    }

    private formatCwdDisplay(fullPath: string): string {
        const home = os.homedir();
        if (fullPath === home) {
            return '~';
        }
        if (fullPath.startsWith(home + path.sep)) {
            return '~' + fullPath.slice(home.length);
        }
        return fullPath;
    }

    // -----------------------------------------------------------------------
    // 进程管理
    // -----------------------------------------------------------------------

    private interruptProcess(): void {
        if (this.currentProcessId) {
            this.isInterrupted = true;
            this.processService.killProcess(this.currentProcessId);
            this.currentProcessId = null;
        }
    }

    // -----------------------------------------------------------------------
    // 消息处理
    // -----------------------------------------------------------------------

    private async handleUserMessage(content: string): Promise<void> {
        if (!content.trim()) {
            return;
        }

        logger.info('处理用户消息', { content: content.slice(0, 100), cwd: this._cwd });

        const apiKey = await this.secretService.getApiKey();
        if (!apiKey) {
            this.addMessage(
                'system',
                '⛔️ 未配置 API Key。请先执行命令 **dscli: Set API Key** 配置 DEEPSEEK_API_KEY。',
                false,
                true,
            );
            return;
        }

        const executablePath = this.configService.getConfig().executablePath;

        this.postMessage('setStatus', { content: '⏳ 正在思考...' });

        this.streamBuffer = '';
        this.streamMessageId = null;
        this.isInterrupted = false;

        const startTime = Date.now();
        let timerId: NodeJS.Timeout | null = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            this.postMessage('setStatus', { content: `⏳ 正在思考... (${elapsed}s)` });
        }, 1000);
        try {
            // 构建子进程环境：自动注入 EDITOR 以支持 AskUser
            const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: apiKey };
            const editorVal = resolveEditorValue(vscode.env.appRoot);
            if (editorVal) {
                env.EDITOR = editorVal;

                // 注入 code CLI 目录到 PATH，确保 Go 子进程能通过 exec.LookPath("code") 找到
                //
                // ⚠️ 直接修改 process.env.PATH（而非 options.env.PATH）：
                // macOS Code Helper (Plugin) 沙箱中 child_process.spawn 的
                // `env: { ...process.env, ...options.env }` spread 对 PATH
                // 的 override 不可靠。直接修改 process.env 确保子进程继承到。
                const codeDir = getVscodeCliDir(vscode.env.appRoot);
                if (codeDir) {
                    const sep = path.delimiter;
                    const currentPath = process.env.PATH || '';
                    if (!currentPath.split(sep).filter(Boolean).includes(codeDir)) {
                        process.env.PATH = codeDir + sep + currentPath;
                        logger.debug('AskUser: 注入 code CLI 目录到 process.env.PATH', { codeDir });
                    }

                    // Windows: Go 的 exec.LookPath 也检查 Path 变量
                    if (process.platform === 'win32' && process.env.Path) {
                        const winSep = path.delimiter;
                        const winDirs = (process.env.Path || '').split(winSep).filter(Boolean);
                        if (!winDirs.includes(codeDir)) {
                            process.env.Path = codeDir + sep + (process.env.Path || '');
                        }
                    }
                }

                logger.info('AskUser: 已设置 EDITOR', { editor: editorVal });
            } else {
                logger.debug('AskUser: code CLI 不可用，留空 EDITOR 由 Go 后端回退');
            }

            this.currentProcessId = await this.processService.createProcess({
                command: executablePath,
                args: ['chat'],
                cwd: this._cwd,
                input: content,
                env,
                onData: (data: string) => {
                    this.handleStreamData(data);
                },
                onError: (error: string) => {
                    logger.warn('dscli stderr', { error });
                },
                onExit: (code: number | null) => {
                    if (timerId) {
                        clearInterval(timerId);
                        timerId = null;
                    }
                    this.postMessage('setStatus', { content: '' });

                    if (this.isInterrupted) {
                        // 用户主动停止 — 已由 interrupt 处理，跳过错误提示
                    } else if (code !== 0 && !this.streamBuffer) {
                        this.addMessage('system', `dscli 进程异常退出 (code: ${code})`, false, true);
                    } else if (this.streamBuffer) {
                        this.finalizeStreamMessage();
                    } else {
                        this.addMessage('assistant', '（无响应）', false, true);
                    }

                    this.currentProcessId = null;
                    this.isInterrupted = false;
                },
            });
        } catch (error: unknown) {
            if (timerId) {
                clearInterval(timerId);
                timerId = null;
            }
            this.postMessage('setStatus', { content: '' });
            const msg = error instanceof Error ? error.message : String(error);
            this.addMessage(
                'system',
                `启动 dscli 失败: ${msg}\n\n请确认：\n1. dscli 已安装\n2. 路径配置正确 (设置 > dscli.executablePath)\n3. API Key 有效`,
                false,
                true,
            );
            logger.error('启动 dscli 失败', error);
        }
    }

    // -----------------------------------------------------------------------
    // 流式输出
    // -----------------------------------------------------------------------

    private handleStreamData(data: string): void {
        // 去除前导空白和思考标记（DeepSeek 输出前会带 \n 和 . 字符）
        if (!this.streamMessageId) {
            data = data.replace(/^[\s.]+/, '');
            if (!data) {
                return;
            }
        }

        this.streamBuffer += data;

        if (!this.streamMessageId) {
            this.streamMessageId = `msg_${Date.now()}_${this.messageCounter++}`;
            this.postMessage('addStreamMessage', {
                id: this.streamMessageId,
                role: 'assistant',
                content: this.streamBuffer,
            });
        } else {
            this.postMessage('updateStreamMessage', {
                id: this.streamMessageId,
                content: this.streamBuffer,
            });
        }
    }

    private finalizeStreamMessage(): void {
        if (this.streamMessageId) {
            this.postMessage('finalizeStreamMessage', {
                id: this.streamMessageId,
                content: this.streamBuffer,
            });
            this.currentMessages.push({
                id: this.streamMessageId,
                role: 'assistant',
                content: this.streamBuffer,
                timestamp: new Date(),
                isStreaming: false,
            });
        }
        this.streamBuffer = '';
        this.streamMessageId = null;
    }

    private addMessage(role: string, content: string, isStreaming = false, isError = false): void {
        const msg: ChatMessage = {
            id: `msg_${Date.now()}_${this.messageCounter++}`,
            role: role as ChatMessage['role'],
            content,
            timestamp: new Date(),
            isStreaming,
            isError,
        };
        this.currentMessages.push(msg);
        this.postMessage('addMessage', { role, content, isStreaming, isError });
    }

    private postMessage(command: string, data: Record<string, unknown>): void {
        if (this.panel) {
            this.panel.webview.postMessage({ command, ...data });
        }
    }

    // -----------------------------------------------------------------------
    // Webview 消息处理
    // -----------------------------------------------------------------------

    private setupMessageHandler(): void {
        if (!this.panel) {
            return;
        }

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                try {
                    switch (message.command) {
                        case 'sendMessage':
                            await this.handleUserMessage(message.content as string);
                            break;
                        case 'interrupt':
                            this.interruptProcess();
                            this.addMessage('system', '⏹ 已中断', false, false);
                            break;
                        case 'switchPanel':
                            // "切换"按钮现在触发面板导航
                            await vscode.commands.executeCommand('dscli.listChats');
                            break;
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.error('ChatPanel 消息处理出错', { command: message.command, error: msg });
                    vscode.window.showErrorMessage(`ChatPanel 错误: ${msg}`);
                }
            },
            undefined,
            [],
        );
    }

    // -----------------------------------------------------------------------
    // dispose 通知
    // -----------------------------------------------------------------------

    private notifyDispose(): void {
        for (const handler of this.onDisposeHandlers) {
            try {
                handler();
            } catch (err) {
                logger.error('ChatPanel dispose 回调异常', err);
            }
        }
        this.onDisposeHandlers = [];
    }

    // -----------------------------------------------------------------------
    // HTML 生成
    // -----------------------------------------------------------------------

    private getHtml(): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chatPanel.html');
        const raw = fs.readFileSync(htmlPath, 'utf8');
        return raw.replace(/\{\{NONCE\}\}/g, nonce);
    }
}
