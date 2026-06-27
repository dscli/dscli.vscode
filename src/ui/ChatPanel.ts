/**
 * 聊天面板组件 - 通过 dscli CLI 与 DeepSeek 交互
 *
 * HTML/CSS/JS 模板位于 media/chatPanel.html，通过 fs.readFileSync 加载。
 * 避免了 TypeScript 模板字符串中的转义链问题。
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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  isError?: boolean;
}

export class ChatPanel {
  private panel: vscode.WebviewPanel | null = null;
  private processService: ProcessService;
  private configService: ConfigService;
  private secretService: SecretService;
  private extensionUri: vscode.Uri;
  private currentMessages: ChatMessage[] = [];
  private messageCounter = 0;
  private currentProcessId: string | null = null;
  private currentCwd: string;
  private isInterrupted = false;

  // 流式输出缓冲
  private streamBuffer = '';
  private streamMessageId: string | null = null;

  constructor(
    processService: ProcessService,
    configService: ConfigService,
    secretService: SecretService,
    context: vscode.ExtensionContext,
  ) {
    this.processService = processService;
    this.configService = configService;
    this.secretService = secretService;
    this.extensionUri = context.extensionUri;
    this.currentCwd = this.resolveInitialCwd();
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


  /**
   * 创建或显示聊天面板
   */
  public show(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal();
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
      'dscliChat',
      'dscli Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.webview.html = this.getHtml();
    this.setupMessageHandler();

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.interruptProcess();
    });

    // 发送初始工作目录和欢迎消息
    setTimeout(async () => {
      this.broadcastCwd();

      const hasApiKey = !!(await this.secretService.getApiKey());
      const welcome = hasApiKey
        ? '👋 欢迎使用 dscli！输入你的问题开始对话。'
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
   * 发送用户消息（由外部调用，如 analyzeFile）
   */
  public sendUserMessage(content: string): void {
    this.handleUserMessage(content);
  }

  // ---------------------------------------------------------------------------
  // 工作目录管理
  // ---------------------------------------------------------------------------

  private resolveInitialCwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.uri.fsPath ?? os.homedir();
  }

  /**
   * 格式化路径显示：将 HOME 目录替换为 ~
   */
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

  private broadcastCwd(): void {
    this.postMessage('setCwd', {
      path: this.formatCwdDisplay(this.currentCwd),
      fullPath: this.currentCwd,
    });
  }

  /**
   * 弹出快速选择框，让用户选择工作目录
   */
  private async handleChangeDirectory(): Promise<void> {
    const items: vscode.QuickPickItem[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
      const fsPath = folder.uri.fsPath;
      items.push({
        label: (fsPath === this.currentCwd ? '$(check) ' : '$(folder) ') + folder.name,
        description: this.formatCwdDisplay(fsPath),
        detail: fsPath,
      });
    }

    items.push({ label: '$(folder-opened) 浏览其他文件夹...', description: '', detail: '__browse__' });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择 dscli 工作目录',
    });

    if (!picked) {
      return;
    }

    let newCwd: string;

    if (picked.detail === '__browse__') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: '选择目录',
      });
      if (!selected || selected.length === 0) {
        return;
      }
      newCwd = selected[0].fsPath;
    } else {
      newCwd = picked.detail ?? this.currentCwd;
    }

    if (newCwd === this.currentCwd) {
      return;
    }

    this.currentCwd = newCwd;
    this.broadcastCwd();
    this.addMessage('system', `📂 已切换到 ${this.formatCwdDisplay(newCwd)}`, false, false);
    logger.info('工作目录已切换', { cwd: newCwd });
  }

  // ---------------------------------------------------------------------------
  // 进程管理
  // ---------------------------------------------------------------------------

  private interruptProcess(): void {
    if (this.currentProcessId) {
      this.isInterrupted = true;
      this.processService.killProcess(this.currentProcessId);
      this.currentProcessId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 消息处理
  // ---------------------------------------------------------------------------

  private async handleUserMessage(content: string): Promise<void> {
    if (!content.trim()) {
      return;
    }

    logger.info('处理用户消息', { content: content.slice(0, 100) });

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

    const cwd = this.currentCwd;
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
        cwd,
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

  // ---------------------------------------------------------------------------
  // 流式输出
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Webview 消息处理
  // ---------------------------------------------------------------------------

  private setupMessageHandler(): void {
    if (!this.panel) {
      return;
    }

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'sendMessage':
            await this.handleUserMessage(message.content);
            break;
          case 'interrupt':
            this.interruptProcess();
            this.addMessage('system', '⏹ 已中断', false, false);
            break;
          case 'changeDirectory':
            await this.handleChangeDirectory();
            break;
        }
      },
      undefined,
      [],
    );
  }

  // ---------------------------------------------------------------------------
  // HTML 生成 — 加载外部文件，替换 {{NONCE}} 占位符
  // ---------------------------------------------------------------------------

  private getHtml(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chatPanel.html');
    const raw = fs.readFileSync(htmlPath, 'utf8');
    return raw.replace(/\{\{NONCE\}\}/g, nonce);
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  public dispose(): void {
    this.interruptProcess();
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
    this.currentMessages = [];
  }

  public getMessages(): ChatMessage[] {
    return [...this.currentMessages];
  }
}
