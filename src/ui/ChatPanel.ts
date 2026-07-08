/**
 * 聊天面板组件 - 通过 dscli CLI 与 DeepSeek 交互
 *
 * 每个 ChatPanel 实例绑定一个固定的项目目录 (cwd)。
 * 多实例管理由 ChatPanelManager 负责。
 *
 * HTML/CSS/JS 模板位于 media/chatPanel.html，通过 fs.readFileSync 加载。
 */
import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ProcessService } from '../services/ProcessService';
import { ConfigService } from '../services/ConfigService';
import { SecretService } from '../services/SecretService';

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    isStreaming?: boolean;
    isError?: boolean;
}

// ---------------------------------------------------------------------------
export class ChatPanel {
    // 每次分页加载的消息条数
    private static readonly HISTORY_PAGE_SIZE = 20;

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

    // 历史消息分页
    private allHistoryMessages: ChatMessage[] = [];   // 从 dscli 加载的完整历史
    private historyEndIdx = 0;                         // 已展示的消息数（从末尾计数）

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

        // 发送初始工作目录，加载历史聊天记录（如有历史则不显示欢迎消息）
        setTimeout(async () => {
            this.broadcastCwd();

            // 从 dscli 数据库加载当前项目的聊天历史
            const hasHistory = await this.loadHistoryFromDscli();

            // 只有首次使用（无历史记录）时才显示欢迎消息
            if (!hasHistory) {
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
            }
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
     * 从 dscli 数据库加载当前项目的聊天历史记录。
     * 使用分页策略：全部加载到内存，但只展示最后 N 条。
     * @returns 如果加载到有效消息则返回 true，否则返回 false
     */
    private async loadHistoryFromDscli(): Promise<boolean> {
        const executablePath = this.configService.getConfig().executablePath;

        try {
            const stdout = await new Promise<string>((resolve, reject) => {
                child_process.execFile(
                    executablePath,
                    ['history', 'list', '--json', '--histsize', '100000'],
                    {
                        cwd: this._cwd,
                        maxBuffer: 50 * 1024 * 1024,
                        timeout: 15000,
                    },
                    (error, stdout, _stderr) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve(stdout);
                    },
                );
            });

            const rawMessages = JSON.parse(stdout) as Array<{
                id: number;
                role: string;
                content: string;
                reasoning_content?: string;
                tool_call_id?: string;
                created_at: string;
            }>;

            // 解析并过滤所有消息，存入 allHistoryMessages
            const all: ChatMessage[] = [];
            for (const msg of rawMessages) {
                // 跳过 tool 角色的内部消息（工具调用结果）
                if (msg.role === 'tool') {
                    continue;
                }

                // 跳过空内容（纯工具调用 assistant 消息）
                const content = msg.content || msg.reasoning_content || '';
                if (!content.trim()) {
                    continue;
                }

                // 校验角色有效性
                const role = (msg.role === 'assistant' || msg.role === 'user' || msg.role === 'system')
                    ? msg.role : 'system';

                all.push({
                    id: `hist_${msg.id}`,
                    role: role as ChatMessage['role'],
                    content,
                    timestamp: new Date(msg.created_at),
                    isStreaming: false,
                    isError: false,
                });
            }

            this.allHistoryMessages = all;
            if (all.length === 0) return false;

            // 只展示最后 HISTORY_PAGE_SIZE 条
            const pageSize = ChatPanel.HISTORY_PAGE_SIZE;
            const startIdx = Math.max(0, all.length - pageSize);
            this.historyEndIdx = all.length - startIdx; // 已展示的条数
            const toShow = all.slice(startIdx);

            // 添加历史消息统计提示
            const infoLine = startIdx > 0
                ? `📜 已加载 ${toShow.length}/${all.length} 条历史记录（向上滚动查看更多）`
                : `📜 已加载全部 ${all.length} 条历史记录`;

            const infoMsg: ChatMessage = {
                id: 'history_info',
                role: 'system',
                content: infoLine,
                timestamp: new Date(),
            };
            this.currentMessages.push(infoMsg);
            this.postMessage('addMessage', {
                role: 'system',
                content: infoLine,
                isStreaming: false,
                isError: false,
            });

            // 展示分页消息
            for (const chatMsg of toShow) {
                this.currentMessages.push(chatMsg);
                this.postMessage('addMessage', {
                    id: chatMsg.id,
                    role: chatMsg.role,
                    content: chatMsg.content,
                    isStreaming: false,
                    isError: false,
                });
            }

            // 通知前端是否有更多历史可加载
            this.postMessage('hasMoreHistory', { hasMore: startIdx > 0 });


            logger.debug('加载历史记录', {
                total: all.length,
                displayed: toShow.length,
                cwd: this._cwd,
            });

            return true;

        } catch (error: any) {
            // 无历史记录或 dscli 版本不支持 --json 时静默忽略
            logger.debug('加载历史记录跳过（首次使用或旧版 dscli）', {
                error: error?.message,
                cwd: this._cwd,
            });
            return false;
        }
    }

    /**
     * 处理前端 scroll-to-top 请求，加载更早的历史消息。
     */
    private handleLoadMoreHistory(): void {
        const remaining = this.allHistoryMessages.length - this.historyEndIdx;
        if (remaining <= 0) {
            this.postMessage('hasMoreHistory', { hasMore: false });
            return;
        }

        const pageSize = ChatPanel.HISTORY_PAGE_SIZE;
        const batchSize = Math.min(pageSize, remaining);
        const endIdx = this.allHistoryMessages.length - this.historyEndIdx;
        const startIdx = Math.max(0, endIdx - batchSize);
        const batch = this.allHistoryMessages.slice(startIdx, endIdx);
        this.historyEndIdx = this.allHistoryMessages.length - startIdx;

        // 构建要发送的消息列表（chronological order，前端会正确 prepend）
        const messages = batch.map(msg => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp.toISOString(),
            isStreaming: false,
            isError: false,
        }));

        // 更新 currentMessages（插入到最前面）
        this.currentMessages.unshift(...batch);

        this.postMessage('prependMessages', { messages });

        if (startIdx === 0) {
            this.postMessage('hasMoreHistory', { hasMore: false });
        }

        logger.debug('加载更多历史', {
            batchSize: batch.length,
            remaining: this.allHistoryMessages.length - this.historyEndIdx,
            cwd: this._cwd,
        });
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
        this.allHistoryMessages = [];
        this.historyEndIdx = 0;
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

    /**
     * 解析 EDITOR 环境变量。
     *
     * 如果 Extension Host 已有 EDITOR，直接跳过（尊重用户已有的配置）。
     * 否则通过 vscode.env.appRoot 定位当前运行的 VSCode CLI 路径，
     * 设置 EDITOR="<code-absolute-path> --wait"，确保 dscli 的 askUser
     * 能用 VSCode 打开编辑器并等待编辑完成。
     */
    private resolveEditorEnv(): Record<string, string> {
        if (process.env.EDITOR) {
            return {};
        }

        const appRoot = vscode.env.appRoot;
        if (!appRoot) {
            return {};
        }

        // 平台相关候选路径
        const isWin = process.platform === 'win32';
        const candidates: string[] = [
            path.join(appRoot, 'bin', isWin ? 'code.cmd' : 'code'),
            path.resolve(appRoot, '..', 'bin', isWin ? 'code.cmd' : 'code'),
        ];

        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate)) {
                    return { EDITOR: `"${candidate}" --wait` };
                }
            } catch {
                // 个别候选路径可能存在权限问题，继续尝试下一个
            }
        }

        return {};
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
            this.currentProcessId = await this.processService.createProcess({
                command: executablePath,
                args: ['chat'],
                cwd: this._cwd,
                input: content,
                env: { DEEPSEEK_API_KEY: apiKey, ...this.resolveEditorEnv() },
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
                        case 'loadMoreHistory':
                            this.handleLoadMoreHistory();
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
