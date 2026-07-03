/**
 * ChatPanelManager - 多实例聊天面板管理器
 *
 * 管理多个 ChatPanel 实例，每个实例绑定一个固定的项目目录。
 * 职责：
 *   1. 按项目路径管理 ChatPanel 的创建、复用、关闭
 *   2. 提供面板列表查询和导航
 *   3. 处理生命周期清理
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ProcessService } from '../services/ProcessService';
import { ConfigService } from '../services/ConfigService';
import { SecretService } from '../services/SecretService';
import { ChatPanel } from './ChatPanel';

export interface PanelInfo {
    cwd: string;
    projectName: string;
    title: string;
}

export class ChatPanelManager {
    private panels: Map<string, ChatPanel> = new Map();
    private processService: ProcessService;
    private configService: ConfigService;
    private secretService: SecretService;
    private extensionUri: vscode.Uri;

    constructor(
        processService: ProcessService,
        configService: ConfigService,
        secretService: SecretService,
        extensionUri: vscode.Uri,
    ) {
        this.processService = processService;
        this.configService = configService;
        this.secretService = secretService;
        this.extensionUri = extensionUri;
        logger.debug('ChatPanelManager 创建');
    }

    /**
     * 为指定路径打开一个 ChatPanel。
     * - 如果该路径已有 panel，reveal 它
     * - 如果没有，创建新的
     * - 如果 cwd 未指定，使用当前 workspace folder
     */
    openChat(cwd?: string): ChatPanel {
        const targetCwd = cwd ?? this.resolveDefaultCwd();
        const key = path.resolve(targetCwd);

        // 复用已有 panel
        const existing = this.panels.get(key);
        if (existing) {
            existing.reveal();
            return existing;
        }

        // 创建新 panel
        const panel = new ChatPanel(
            this.processService,
            this.configService,
            this.secretService,
            this.extensionUri,
            key,
        );

        // 注册自动清理
        panel.onDidDispose(() => {
            const disposedKey = this.findKeyByPanel(panel);
            if (disposedKey) {
                this.panels.delete(disposedKey);
                logger.info('ChatPanel 已从管理器移除', { cwd: disposedKey });
            }
        });

        this.panels.set(key, panel);
        panel.show();
        logger.info('ChatPanel 已创建', { cwd: key, total: this.panels.size });
        return panel;
    }

    /**
     * 获取当前活跃 editor 所在 workspace folder 对应的 panel。
     * 常用于状态栏点击、命令面板等上下文。
     * 在 multi-root workspace 中，如果无法确定当前活动项目，弹出快速选择。
     */
    async getOrCreateForActiveEditor(): Promise<ChatPanel> {
        const cwd = await this.resolveCwdFromActiveEditor();
        return this.openChat(cwd);
    }

    /**
     * 主动关闭指定路径的 ChatPanel。
     */
    closeChat(cwd: string): void {
        const key = path.normalize(cwd);
        const panel = this.panels.get(key);
        if (panel) {
            panel.dispose();
            this.panels.delete(key);
            logger.info('ChatPanel 已关闭', { cwd: key });
        }
    }

    /**
     * 列出所有活跃 panel 的信息。
     */
    listPanels(): PanelInfo[] {
        const result: PanelInfo[] = [];
        for (const [cwd, panel] of this.panels) {
            result.push({
                cwd,
                projectName: panel.projectName,
                title: `dscli: ${panel.projectName}`,
            });
        }
        return result;
    }

    /**
     * 聚焦（reveal）指定路径的 panel。
     */
    focusPanel(cwd: string): void {
        const key = path.normalize(cwd);
        const panel = this.panels.get(key);
        if (panel) {
            panel.reveal();
        }
    }

    /**
     * 弹出快速选择，让用户选择：
     * 1. 一个已打开的面板 → 切换聚焦
     * 2. 当前 workspace 中未打开面板的文件夹 → 新建面板
     * 3. "浏览其他文件夹..." → 打开文件对话框选择目录
     *
     * 与 showWorkspaceFolderPicker() 保持一致的 UE，
     * 供 ChatPanel 的 "切换" 按钮调用。
     */
    async showPanelPicker(): Promise<void> {
        const items: vscode.QuickPickItem[] = [];

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const openCwds = new Set(this.panels.keys());

        // 1. 列出所有活跃 panel
        for (const [cwd, panel] of this.panels) {
            items.push({
                label: `$(hubot) dscli: ${panel.projectName}`,
                description: this.formatCwdDisplay(cwd),
                detail: cwd,
            });
        }

        // 2. 列出 workspace 中尚未打开 panel 的文件夹
        const unopenedFolders = workspaceFolders.filter(
            f => !openCwds.has(path.resolve(f.uri.fsPath))
        );
        if (unopenedFolders.length > 0) {
            if (items.length > 0) {
                items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            }
            for (const folder of unopenedFolders) {
                items.push({
                    label: `$(folder) ${path.basename(folder.uri.fsPath)}`,
                    description: this.formatCwdDisplay(folder.uri.fsPath),
                    detail: folder.uri.fsPath,
                });
            }
        }

        // 分隔线 + "浏览其他文件夹"
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(folder-opened) 浏览其他文件夹...',
            description: '在新目录中打开 ChatPanel',
            detail: '__browse__',
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: items.length > 1
                ? '选择要聚焦的 ChatPanel，或打开新面板'
                : '打开一个新的 ChatPanel',
            ignoreFocusOut: true,
        });

        if (!picked) return;

        if (picked.detail === '__browse__') {
            const selected = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: '在此目录打开 ChatPanel',
            });
            if (selected?.[0]) {
                this.openChat(selected[0].fsPath);
            }
        } else if (picked.detail) {
            // openChat 兼顾复用（已存在时 reveal）和新建
            this.openChat(picked.detail);
        }
    }

    /**
     * 清空对话历史 — 弹出选择。
     */
    async handleClearHistory(): Promise<void> {
        const panels = this.listPanels();

        if (panels.length === 0) {
            vscode.window.showInformationMessage('没有活跃的 ChatPanel。');
            return;
        }

        if (panels.length === 1) {
            // 只有一个面板，直接清空
            const panel = this.panels.get(panels[0].cwd);
            if (panel) {
                panel.dispose();
                this.panels.delete(panels[0].cwd);
                vscode.window.showInformationMessage(
                    `已清空 "${panels[0].projectName}" 的对话历史。`,
                );
            }
            return;
        }

        // 多个面板，让用户选择
        const items: vscode.QuickPickItem[] = panels.map(p => ({
            label: `$(hubot) dscli: ${p.projectName}`,
            description: this.formatCwdDisplay(p.cwd),
            detail: p.cwd,
        }));

        items.push({
            label: '',
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: '$(trash) 清空所有面板',
            description: '关闭所有 ChatPanel',
            detail: '__all__',
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要清空的面板',
            ignoreFocusOut: true,
        });

        if (!picked) return;

        if (picked.detail === '__all__') {
            this.dispose();
            vscode.window.showInformationMessage('已清空所有 ChatPanel 的对话历史。');
        } else if (picked.detail) {
            const panel = this.panels.get(picked.detail);
            if (panel) {
                panel.dispose();
                this.panels.delete(picked.detail);
                vscode.window.showInformationMessage(
                    `已清空 "${picked.label.replace(/^.*dscli:\s*/, '')}" 的对话历史。`,
                );
            }
        }
    }

    /**
     * 清理所有 panel。
     */
    dispose(): void {
        for (const [cwd, panel] of this.panels) {
            panel.dispose();
            logger.debug('ChatPanel 已释放', { cwd });
        }
        this.panels.clear();
        logger.info('ChatPanelManager 已清理');
    }

    // -----------------------------------------------------------------------
    // 内部方法
    // -----------------------------------------------------------------------
    private resolveDefaultCwd(): string {
        const folders = vscode.workspace.workspaceFolders;
        return folders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';
    }

    /**
     * 解析当前 active editor 对应的项目路径。
     *
     * 优先级：
     *   1. 单文件夹 workspace → 直接返回
     *   2. 有 active editor → 返回其所在 workspace folder
     *   3. 多文件夹 + 无 active editor → 弹出 quick pick 让用户选择
     */
    private async resolveCwdFromActiveEditor(): Promise<string> {
        const folders = vscode.workspace.workspaceFolders;

        // 无 workspace
        if (!folders || folders.length === 0) {
            return process.env.HOME ?? '/';
        }

        // 单文件夹 → 直接返回
        if (folders.length === 1) {
            return folders[0].uri.fsPath;
        }

        // 多文件夹：先检查 active editor
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (folder) {
                return folder.uri.fsPath;
            }
        }

        // 多文件夹 + 无 active editor 上下文 → 弹出选择
        const picked = await this.showWorkspaceFolderPicker();
        if (!picked) {
            // 用户取消，回退到第一个文件夹
            return folders[0].uri.fsPath;
        }
        return picked;
    }

    /**
     * 弹出 workspace folder 快速选择。
     * 供多文件夹 workspace 中使用。
     */
    private async showWorkspaceFolderPicker(): Promise<string | undefined> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;

        const items: vscode.QuickPickItem[] = folders.map(f => ({
            label: `$(folder) ${path.basename(f.uri.fsPath)}`,
            description: this.formatCwdDisplay(f.uri.fsPath),
            detail: f.uri.fsPath,
        }));

        // 分隔线 + "浏览其他文件夹"
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(folder-opened) 浏览其他文件夹...',
            description: '在非 workspace 目录中打开 ChatPanel',
            detail: '__browse__',
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要打开 ChatPanel 的项目文件夹',
            ignoreFocusOut: true,
        });

        if (!picked) return undefined;

        if (picked.detail === '__browse__') {
            const selected = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: '在此目录打开 ChatPanel',
            });
            return selected?.[0]?.fsPath;
        }

        return picked.detail;
    }

    private findKeyByPanel(panel: ChatPanel): string | undefined {
        for (const [key, p] of this.panels) {
            if (p === panel) return key;
        }
        return undefined;
    }

    private formatCwdDisplay(fullPath: string): string {
        const home = process.env.HOME;
        if (home && fullPath.startsWith(home)) {
            return '~' + fullPath.slice(home.length);
        }
        return fullPath;
    }
}
