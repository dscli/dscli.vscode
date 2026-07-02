# 多实例 ChatPanel 设计草案

> **作者**: Galileo (dscli team)
> **日期**: 2026-07-28
> **状态**: 草案 / 待评审

---

## 1. 现状分析

### 1.1 当前架构（单例）

```
DscliExtension (单例)
  └── ChatPanel (单例)
       ├── WebviewPanel × 1
       ├── currentCwd: string
       ├── currentProcessId: string | null
       ├── currentMessages: ChatMessage[]
       ├── streamBuffer / streamMessageId
       └── 切换目录 → 改变 currentCwd，不清除历史
```

### 1.2 关键发现

| 层 | 现状 | 多实例兼容性 |
|----|------|-------------|
| **ProcessService** | 已有 `processPool: Map<string, ProcessInfo>`，支持多进程 | ✅ 无需改动 |
| **ConfigService** | 全局配置，无状态 | ✅ 无需改动 |
| **SecretService** | 全局密钥存储，无状态 | ✅ 无需改动 |
| **ChatPanel** | 硬编码单例：`panel: WebviewPanel \| null` | ❌ 需要重构 |
| **DscliExtension** | 持有 `chatPanel: ChatPanel \| null` | ❌ 需要重构 |
| **chatPanel.html** | 单个消息列表 + cwd 显示 | ⚠️ 需要小改 |

### 1.3 核心问题

当前 "一个面板 + 切换目录" 的设计导致：

1. **不能同时看两个项目的对话** — 切换目录后历史被覆盖（只追加上限）
2. **进程不隔离** — `currentProcessId` 只有一个，A 项目请求进行中切到 B 项目会中断
3. **用户心智模型不匹配** — VSCode 用户习惯"一个编辑器一个标签"，而不是"一个面板反复切换上下文"
4. **未来扩展受限** — 无法做项目级 agent 持久化、多 agent 协作

---

## 2. 设计目标

### 2.1 核心目标

**每个项目/目录一个独立的 ChatPanel，可同时打开多个。**

### 2.2 具体目标

1. **进程隔离** — 每个 panel 有独立的 dscli 子进程，互不干扰
2. **历史隔离** — 每个 panel 有独立的消息历史，切换项目不丢失
3. **UI 可见性** — 用户能同时看到多个项目的对话（多 tab 或多 editor）
4. **生命周期独立** — 关闭一个 panel 不影响其他 panel
5. **入口自然** — 从项目文件夹打开 chat 自动关联正确的工作目录
6. **向后兼容** — 已有用户的单一 panel 体验不受影响

### 2.3 非目标

- ❌ 同一个 panel 内再开"子对话"（VSCode 层面做 tab 分组更合理）
- ❌ Agent 之间的通信（那是后续的课题）
- ❌ 跨 session 持久化聊天历史（后续可加，但不阻塞本次改动）

---

## 3. 总体架构

### 3.1 新架构

```
DscliExtension
  ├── ChatPanelManager (新增)
  │     └── Map<projectPath, ChatPanel>
  │           ├── /Users/alice/project-a → ChatPanel #1
  │           │     ├── WebviewPanel (title: "dscli: project-a")
  │           │     ├── cwd = /Users/alice/project-a (fixed)
  │           │     ├── processId → ProcessService 中的子进程
  │           │     └── currentMessages[]
  │           │
  │           ├── /Users/alice/project-b → ChatPanel #2
  │           │     ├── WebviewPanel (title: "dscli: project-b")
  │           │     ├── cwd = /Users/alice/project-b (fixed)
  │           │     ├── processId → ProcessService 中的子进程
  │           │     └── currentMessages[]
  │           │
  │           └── ...
  │
  ├── ProcessService (不改动)
  │     └── Map<processId, ProcessInfo> ← 已支持多进程
  │
  ├── ConfigService (不改动)
  └── SecretService (不改动)
```

### 3.2 核心原则

| 原则 | 说明 |
|------|------|
| **Panel = Project** | 一个 ChatPanel 绑定一个固定的项目路径，不可中途切换 |
| **Key by path** | 用规范化绝对路径作为 Map 键，天然去重 |
| **Manager 负责路由** | ChatPanelManager 决定打开/复用/关闭哪个 panel |
| **Panel 自管理** | 每个 ChatPanel 管理自己的 webview、进程、消息、流式缓冲 |

---

## 4. 组件设计

### 4.1 ChatPanelManager（新增）

```typescript
// src/ui/ChatPanelManager.ts

export class ChatPanelManager {
    private panels: Map<string, ChatPanel>;
    private processService: ProcessService;
    private configService: ConfigService;
    private secretService: SecretService;
    private extensionUri: vscode.Uri;

    constructor(
        processService: ProcessService,
        configService: ConfigService,
        secretService: SecretService,
        extensionUri: vscode.Uri,
    );

    /**
     * 为指定路径打开一个 ChatPanel。
     * - 如果该路径已有 panel，reveal 它
     * - 如果没有，创建新的
     * - 如果 cwd 未指定，使用当前 workspace folder
     */
    openChat(cwd?: string): ChatPanel;

    /**
     * 主动关闭指定路径的 ChatPanel。
     * 用户直接关闭 webview tab 也通过 onDidDispose 触发清理。
     */
    closeChat(cwd: string): void;

    /**
     * 获取当前活跃 editor 所在 workspace folder 的 panel。
     * 常用于 status bar 点击、命令面板等上下文。
     */
    getOrCreateForActiveEditor(): ChatPanel;

    /**
     * 列出所有活跃 panel 的信息（用于状态栏下拉、命令面板等）
     */
    listPanels(): Array<{ cwd: string; projectName: string; title: string }>;

    /**
     * 切换到指定 path 的 panel（reveal 但不改变 focus 中 editor）
     */
    focusPanel(cwd: string): void;

    /**
     * 清理所有 panel
     */
    dispose(): void;

    // 内部方法
    private resolveDefaultCwd(): string;
    private resolveCwdFromActiveEditor(): string;
    private normalizePath(p: string): string;
    private createPanel(cwd: string): ChatPanel;
}
```

#### 关键行为

- **onDidDispose 监听**: 每个 ChatPanel 创建时注册 `panel.onDidDispose` 回调，自动从 Map 中移除自身
- **进程清理**: panel dispose 时调用 `processService.killProcess(processId)` 清理自己的子进程
- **Key 规范化**: `path.normalize()` + 去除尾部分隔符，确保 `/a/b/` 和 `/a/b` 映射到同一个 key

### 4.2 ChatPanel（重构）

```typescript
// src/ui/ChatPanel.ts — 重构

export class ChatPanel {
    // 不变：对外暴露的服务引用
    private processService: ProcessService;
    private configService: ConfigService;
    private secretService: SecretService;
    private extensionUri: vscode.Uri;

    // 新增：固定的 cwd
    private readonly cwd: string;
    private readonly projectName: string;

    // 不变：自身状态
    private panel: WebviewPanel | null;
    private currentMessages: ChatMessage[];
    private streamBuffer: string;
    private streamMessageId: string | null;
    private currentProcessId: string | null;
    private isInterrupted: boolean;

    // 新增：dispose 回调（给 Manager 用）
    private onDisposeHandlers: Array<() => void>;

    constructor(
        processService: ProcessService,
        configService: ConfigService,
        secretService: SecretService,
        extensionUri: vscode.Uri,
        cwd: string,                    // 新增：固定 cwd
    );

    show(): WebviewPanel;               // 创建并显示，或 reveal 已有
    reveal(): void;                     // 只 reveal，不创建
    sendUserMessage(content: string): void;
    getMessages(): ChatMessage[];
    onDidDispose(handler: () => void): void;
    get cwd(): string;                  // getter，不变
    get projectName(): string;          // 新增 getter
    dispose(): void;

    // 删除：handleChangeDirectory / broadcastCwd / formatCwdDisplay
    //    → cwd 是固定的，不需要切换
    // 删除：resolveInitialCwd
    //    → cwd 由 Manager 传入
}
```

#### 与当前 ChatPanel 的关键差异

| 项 | 当前行为 | 新行为 |
|----|---------|--------|
| **cwd** | 可变，可通过 `handleChangeDirectory` 切换 | 不可变，构造函数固定 |
| **panel title** | 固定 `"dscli Chat"` | 动态 `"dscli: {projectName}"` |
| **工具栏切换按钮** | 有"切换"按钮和路径点击 | **保留**切换按钮（见下文 4.3） |
| **cwd 变更** | 原地切换 | ❌ 不允许。需要其他目录 → 开新 panel |

#### 关于工具栏"切换"按钮的重新设计

虽然 cwd 不可变，但 "切换" 按钮可以保留并改变用途：

**新行为**：点击"切换" → Manager 弹出 quick pick 列出所有已打开的 panel + 可选"浏览其他文件夹打开新 panel" → 选择后 focus 对应的 panel（或创建新的）。

这样既保留了用户熟悉的交互入口，又赋予它全新的"多 panel 导航"功能。

### 4.3 Webview Panel 身份

每个 panel 使用相同的 `viewType: 'dscliChat'`。VSCode 允许同一 viewType 的多个 panel 共存，区别通过 title 实现：

```typescript
this.panel = vscode.window.createWebviewPanel(
    'dscliChat',                         // viewType 不变
    `dscli: ${this.projectName}`,        // title 区分不同项目
    vscode.ViewColumn.Beside,            // 或动态选择 column
    { enableScripts: true, retainContextWhenHidden: true },
);
```

### 4.4 chatPanel.html（小幅更新）

前端需要增加两个新的 message 命令：

| 命令 | 用途 | 新增/已有 |
|------|------|-----------|
| `addMessage` | 添加普通消息 | 已有 |
| `addStreamMessage` | 创建流式消息 | 已有 |
| `updateStreamMessage` | 更新流式内容 | 已有 |
| `finalizeStreamMessage` | 完成流式 | 已有 |
| `setStatus` | 状态栏文字 | 已有 |
| `setCwd` | 显示工作目录 | 已有 |
| **`setProjectName`** | **设置面板标题的项目名** | **新增** |
| **`switchPanel`** | **导航到其他 panel** | **新增** |

`setProjectName` 用于在 webview 内部显示可读的项目名（不只是路径）。

`switchPanel` 由 webview 中的"切换"按钮触发，发送给 extension → ChatPanelManager 展示 panel 列表。

### 4.5 DscliExtension（更新）

```typescript
export class DscliExtension {
    private chatPanelManager: ChatPanelManager;  // 替换 chatPanel

    constructor(context) {
        // ... 原有初始化 ...
        this.chatPanelManager = new ChatPanelManager(
            this.processService,
            this.configService,
            this.secretService,
            context.extensionUri,
        );
    }

    // 命令实现
    async openChat(): Promise<void> {
        // 根据当前上下文决定打开哪个 panel
        await this.chatPanelManager.getOrCreateForActiveEditor();
    }

    async openChatForFolder(): Promise<void> {
        // 弹出目录选择器，打开新 panel
        const selected = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
        });
        if (selected?.[0]) {
            this.chatPanelManager.openChat(selected[0].fsPath);
        }
    }

    // 原有方法适配
    async analyzeCurrentFile(): Promise<void> {
        // 需要决定用哪个 panel — 使用 activeEditor 所属 workspace
        const panel = this.chatPanelManager.getOrCreateForActiveEditor();
        // ... 发送代码分析消息 ...
    }

    async clearHistory(): Promise<void> {
        // 询问用户清空哪个 panel，或批量清空全部
        // 或用 quick pick 选择
    }

    async dispose(): Promise<void> {
        this.chatPanelManager.dispose();
        this.processService.dispose();
    }
}
```

---

## 5. 数据流

### 5.1 打开 Chat

```
用户点击状态栏 / 命令面板 "dscli: Open Chat"
  │
  ▼
DscliExtension.openChat()
  │
  ▼
ChatPanelManager.getOrCreateForActiveEditor()
  │  ├─ 获取当前 activeEditor → workspaceFolder → path
  │  └─ path 已存在 Map 中 → reveal() 并返回
  │     path 不存在 → createPanel(path)
  │
  ▼
ChatPanel.constructor(cwd)
  ├─ 固定 cwd
  ├─ 暂不创建 WebviewPanel（懒加载）
  │
  ▼
ChatPanel.show()
  ├─ createWebviewPanel('dscliChat', `dscli: ${projectName}`, ...)
  ├─ 加载 HTML（不变）
  ├─ postMessage('setProjectName', { name: projectName })
  ├─ postMessage('setCwd', { path: formatCwdDisplay(cwd), fullPath: cwd })
  ├─ 检查 API Key → 发送欢迎消息
  └─ 注册 onDidDispose → 通知 Manager 清理
```

### 5.2 发送消息

```
用户输入 → sendMessage → ChatPanel.handleUserMessage(content)
  │
  ├─ 检查 API Key
  ├─ 设置状态 "⏳ 正在思考..."
  ├─ 启动定时器（每秒更新 elapsed）
  │
  ▼
ProcessService.createProcess({
    command: executablePath,
    args: ['chat'],
    cwd: this.cwd,           // 每个 panel 使用自己的 cwd
    input: content,
    env: { DEEPSEEK_API_KEY: apiKey },
    onData: (data) => this.handleStreamData(data),
    onError: (error) => ...,
    onExit: (code) => ...,
})
  │
  ▼
this.currentProcessId = processId  // 每个 panel 独立跟踪
```

### 5.3 关闭 Panel

```
用户关闭 webview tab / ChatPanel.dispose()
  │
  ├─ interruptProcess() — 杀掉自己的子进程
  ├─ panel.dispose() — 释放 webview 资源
  │
  ▼
onDidDispose 触发 → ChatPanelManager.panels.delete(key)
```

### 5.4 跨 Panel 导航（通过"切换目录"按钮）

```
用户点击 webview 中的"切换"按钮
  │
  ▼
webview postMessage({ command: 'switchPanel' })
  │
  ▼
ChatPanel.switchPanel() (新方法)
  │
  ▼
ChatPanelManager.listPanels()
  │  └─ 返回 [{ cwd, projectName, title }]
  │
  ▼
vscode.window.showQuickPick(items)  // 列出所有活跃 panel + "浏览其他文件夹..."
  │
  ├─ 选择已有 panel → ChatPanelManager.focusPanel(cwd)
  │  └─ 相当于 reveal 目标 panel
  │
  └─ 选择"浏览其他文件夹..."
     └─ showOpenDialog → ChatPanelManager.openChat(selected)
```

---

## 6. UI 变化

### 6.1 Panel Title

| 项目 | 旧 | 新 |
|------|----|----|
| title | `"dscli Chat"` | `"dscli: my-project"` |
| tab 识别度 | 所有 tab 都叫一样 | 每个项目不同，一目了然 |

### 6.2 工具栏按钮

| 项目 | 旧 | 新 |
|------|----|----|
| "切换"按钮 | 弹目录选择器切换当前 panel 的 cwd | 弹 quick pick 列出所有活跃 panel + 开新 panel |
| 路径点击 | 同"切换"按钮 | 同"切换"按钮（统一行为）|

### 6.3 Status Bar

当前：`$(hubot) dscli: projectName` → 点击 → `openChat`

新：（多种策略，推荐 B）

- **A（简单）**: 不变，但点击根据当前 active editor 所在的 workspace folder 打开/聚焦对应 panel
- **B（推荐）**: 点击弹 quick pick 列出所有活跃 panel + 当前 workspace folder 的选项
- **C（高级）**: 多个 status bar 项（每个项目一个），但 VSCode 空间有限，不推荐

### 6.4 建议的新增 UI

- **Explorer 右键菜单**: 文件夹右键 → "Open dscli Chat Here"（新增 contributes）
- **侧边栏视图**: 可选 — 列出所有活跃的 dscli session，方便切换（后期可加）

---

## 7. 命令与交互流程

### 7.1 命令矩阵

| 命令 | 当前行为 | 新行为 |
|------|---------|--------|
| `dscli.openChat` | 打开/聚焦唯一 panel | 打开/聚焦当前项目的 panel |
| `dscli.analyzeFile` | 发送代码到唯一 panel | 发送代码到当前项目对应的 panel |
| `dscli.setApiKey` | 设置全局 API Key | ❌ 不变（全局） |
| `dscli.checkStatus` | 检查 dscli 系统状态 | ❌ 不变（全局）|
| `dscli.clearHistory` | 清空唯一 panel 历史 | 弹出 quick pick 选择清空哪个 panel，或"全部清空" |
| `dscli.interrupt` | 中断当前进程 | 中断当前活跃 panel 的进程，无活跃 panel 时提示 |
| **`dscli.openChatForFolder`** | **（新增）** | 选择文件夹后打开/创建对应 panel |
| **`dscli.listChats`** | **（新增）** | 列出所有活跃 panel，选择后聚焦 |

### 7.2 右键菜单

在 `package.json` 的 `contributes` 中新增：

```json
{
    "menus": {
        "explorer/context": [
            {
                "command": "dscli.openChat",
                "when": "explorerResourceIsFolder",
                "group": "dscli"
            }
        ]
    }
}
```

注意：需要扩展 `dscli.openChat` 命令以支持传递文件夹 URI 参数。或者新增独立的 `dscli.openChatForFolder` 命令。

---

## 8. 迁移路径

### 8.1 向后兼容

用户从 0.3.1 升级到新版本时：

1. **已有单一 panel 用户**: 体验不变，只是 panel title 从 `"dscli Chat"` 变为 `"dscli: {projectName}"`，行为无断裂
2. **消息历史**: 当前消息存在内存中，升级后丢失（本来就不持久化）。不影响功能
3. **API Key 和配置**: 全局存储，完全不受影响

### 8.2 分阶段实施

| 阶段 | 内容 | 估计工作量 |
|------|------|-----------|
| **P0** | ChatPanelManager 实现 + ChatPanel 多实例化重构 | 2-3天 |
| **P1** | 命令和交互更新（右键菜单、status bar、clearHistory 弹选择） | 1天 |
| **P2** | 测试（单元测试 + 集成测试 + 手工多 panel 交互验证） | 1-2天 |
| **P3** | 文档更新 + 发布 | 0.5天 |

### 8.3 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/ui/ChatPanelManager.ts` | 🆕 新增 | 多 panel 管理器 |
| `src/ui/ChatPanel.ts` | 🔄 重构 | 接受固定 cwd，移除 cwd 切换逻辑 |
| `src/extension.ts` | 🔄 重构 | 用 ChatPanelManager 替换单一 chatPanel |
| `media/chatPanel.html` | 🔄 小改 | 新增 switchPanel 消息处理 |
| `package.json` | 🔄 小改 | 新增 commands + explorer/context menu |
| `src/__tests__/ChatPanelManager.test.ts` | 🆕 新增 | 单元测试 |
| `src/__tests__/ChatPanel.test.ts` | 🔄 更新 | 适配新接口 |

---

## 9. 风险评估

### 9.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 多 WebviewPanel 内存占用高 | 中 | 中 | VSCode 对隐藏 panel 有 retainContextWhenHidden 优化；限制同时最大 panel 数（如 10 个） |
| 多 dscli 子进程资源竞争 | 低 | 中 | ProcessService 已支持多进程隔离；每个 dscli chat 是独立进程，无共享状态 |
| 进程管理与 WebviewPanel 生命周期不同步 | 低 | 高 | 严格遵循 `onDidDispose → killProcess → remove from Map` 的生命周期链 |
| 从单例到多实例的 race condition | 低 | 中 | 所有 panel 操作通过 Manager 串行化；使用 `async` 方法 + 状态守卫 |

### 9.2 设计取舍

| 决策 | 选项 | 选择理由 |
|------|------|---------|
| cwd 可变还是固定？ | **固定** | 简化实现，符合"一个 panel = 一个项目"的心智模型 |
| panel key 用 path 还是自增 ID？ | **path** | 天然去重，同项目不创建多个 panel |
| 同一个 viewType 还是不同 viewType？ | **同一个 viewType** | 不需要不同 viewType，保证扩展简单 |
| 在 webview 中做 panel 切换还是用 VSCode API？ | **VSCode API**（quick pick）| 原生的 VSCode 体验，无需前端大改 |

### 9.3 未来扩展

本设计为以下场景预留了扩展点：

1. **Agent 持久化**: 每个 ChatPanel 的 `currentMessages` 可 JSON 序列化存储到 `.dscli/chat-history/{project-hash}.json`
2. **Agent 配置差异化**: 每个 ChatPanel 可拥有独立的 model 配置（当前用全局 ConfigService，后续可扩展 Panel-level config）
3. **Agent 协作**: `ChatPanelManager` 可作为 agent 通信总线的雏形，提供 `broadcastToAll()` 等方法
4. **侧边栏 TreeView**: `listPanels()` 已提供数据结构，可驱动一个自定义 TreeDataProvider

---

## 附录 A: 伪代码示例

### ChatPanelManager.openChat()

```typescript
openChat(cwd?: string): ChatPanel {
    const targetCwd = cwd ?? this.resolveDefaultCwd();
    const key = path.normalize(targetCwd);

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

    // 注册清理回调
    panel.onDidDispose(() => {
        this.panels.delete(key);
    });

    this.panels.set(key, panel);
    panel.show();
    return panel;
}
```

### ChatPanel 构造函数

```typescript
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
    this.cwd = cwd;
    this.projectName = path.basename(cwd);

    this.currentMessages = [];
    this.streamBuffer = '';
    this.streamMessageId = null;
    this.currentProcessId = null;
    this.isInterrupted = false;

    // panel 此时不创建，等 show() 调用时再创建
    this.panel = null;
}

show(): vscode.WebviewPanel {
    if (this.panel) {
        this.panel.reveal();
        return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
        'dscliChat',
        `dscli: ${this.projectName}`,
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
        this.interruptProcess();
        this.panel = null;
        this.notifyDispose();
    });

    // 发送项目信息和欢迎消息
    setTimeout(async () => {
        this.postMessage('setProjectName', { name: this.projectName });
        this.postMessage('setCwd', {
            path: this.formatCwdDisplay(this.cwd),
            fullPath: this.cwd,
        });

        const hasApiKey = !!(await this.secretService.getApiKey());
        const welcome = hasApiKey
            ? `👋 欢迎使用 dscli！当前项目: ${this.projectName}。输入你的问题开始对话。`
            : `👋 欢迎使用 dscli！\n\n💡 先用命令面板设置 API Key。`;
        this.postMessage('addMessage', {
            role: 'system',
            content: welcome,
            isStreaming: false,
            isError: false,
        });
    }, 200);

    return this.panel;
}
```

*本草案欢迎讨论。关键争议点：cwd 固定 vs 可变、面板切换的交互方式、与现有用户的兼容策略。*

---

## 10. Chat History：直接利用 dscli 已有数据（无需重复持久化）

### 10.1 需求

重新打开同一项目的 ChatPanel 时，能看到之前的聊天历史（不是从零开始）。

### 10.2 关键发现

**dscli CLI 已经完整持久化了所有聊天历史。**

验证结果：

| 证据 | 说明 |
|------|------|
| `dscli history` 子命令 | `list`, `show`, `recall`, `recent`, `edit`, `notes`, `update`，完整的管理体系 |
| `~/.dscli/sqlite.db` | SQLite 数据库，15MB，存储所有项目的对话 |
| `sessions` 表 | 每项目一条记录，`project_path` 是 **UNIQUE** 的 |
| `messages` 表 | 每条消息有 `session_id`, `role`, `content`, `created_at`, `tool_calls`, `reasoning_content` |

即：

```
dscli.vscode 调用 dscli chat
  └─ dscli chat 自动将消息写入 ~/.dscli/sqlite.db
      └─ messages 表通过 session_id → sessions(project_path)
          └─ 数据结构：每条消息含 role / content / timestamp
```

**结论：插件不需要任何额外的持久化逻辑。** 直接从 dscli 的 SQLite 数据库读取即可。

### 10.3 最终方案：Read-only 从 dscli DB 加载

#### 做什么

| 时机 | 操作 |
|------|------|
| **ChatPanel.show()** | 读取 `~/.dscli/sqlite.db`，查询当前项目的最新 N 条 user + assistant 消息，显示在 webview 中 |
| **对话过程中** | **什么都不做**——dscli 在 `dscli chat` 过程中已经自动写库 |

#### 不做什么

| ~~之前的设计~~ | ~~现在~~ |
|---------------|---------|
| ~~`ChatHistoryService.ts`~~ | ❌ 不需要 |
| ~~`.dscli/chat-history.json`~~ | ❌ 不需要 |
| ~~`chatHistoryEnabled` 配置项~~ | ❌ 不需要 |
| ~~`chatHistoryMaxMessages` 配置项~~ | ❌ 不需要 |
| ~~`finalizeStreamMessage()` 中保存~~ | ❌ 不需要 |
| ~~`dispose()` 中保存~~ | ❌ 不需要 |

#### 查询逻辑（ChatPanel.show() 中新增）

```typescript
// 伪代码 — 实际通过 better-sqlite3 或 sql.js 读取
const DB_PATH = path.join(os.homedir(), '.dscli', 'sqlite.db');

async function loadHistory(cwd: string): Promise<ChatMessage[]> {
    const db = new Database(DB_PATH);

    const session = db.prepare(`
        SELECT id FROM sessions WHERE project_path = ?
    `).get(cwd);

    if (!session) return [];  // 该项目从未使用过 dscli

    const rows = db.prepare(`
        SELECT role, content, created_at
        FROM messages
        WHERE session_id = ?
          AND role IN ('user', 'assistant')
        ORDER BY id DESC
        LIMIT 50
    `).all(session.id);

    return rows.reverse().map((row, i) => ({
        id: `hist_${i}`,
        role: row.role,
        content: row.content,
        timestamp: new Date(row.created_at),
        isStreaming: false,
    }));
}
```

#### 数据流（简化版）

```
ChatPanel.show()
  ├─ 创建 webview
  ├─ 发送欢迎消息
  ├─ 读取 ~/.dscli/sqlite.db
  │    ├─ sessions WHERE project_path = this.cwd → session_id
  │    └─ messages WHERE session_id AND role='user'/'assistant' → rows[]
  ├─ 如果有 rows，批量 postMessage('addMessage', ...)
  └─ 正常开始对话

dscli chat 运行中
  └─ dscli 自动写入 messages 表 ← 插件无需干预
```

### 10.4 代码变更

| 文件 | 变更类型 | 变更 |
|------|---------|------|
| `src/ui/ChatPanel.ts` | 🔄 "show() 增加加载历史" | 新增 `loadHistoryFromDscli()` 方法，读取 `~/.dscli/sqlite.db` |
| `package.json` | 🆕 新增依赖 | 新增 `better-sqlite3` 或 `sql.js`（选择见 10.5） |
| ~~`src/services/ChatHistoryService.ts`~~ | ❌ 无需新增 | |
| ~~`src/services/ConfigService.ts`~~ | ❌ 无需修改 | |
| ~~`package.json` 配置项~~ | ❌ 无需添加 | |

### 10.5 SQLite 读取方式选择

| 方案 | 优点 | 缺点 |
|------|------|------|
| **`better-sqlite3`** | 同步 API，性能好，成熟 | 需要 native 编译（vsce 打包可能增加复杂度） |
| **`sql.js`** (SQLite compiled to WASM) | 纯 JS，无需 native 编译，vsce 友好 | WASM 文件 1.2MB，异步 API |
| **不引入依赖，直接调用 `dscli history list` CLI** | 零依赖，简单 | 解析 CLI 输出较 hacky，性能开销每次 ~50ms |

**推荐方案：不引入依赖，直接对 `~/.dscli/sqlite.db` 执行文件级 SQLite 查询。**

为什么可行：
- `better-sqlite3` 需要 node-gyp 编译，在 VS Code 扩展中发布到 marketplace 时容易出问题
- `sql.js` 的 WASM 需要额外配置 webview 的 `localResourceRoots`
- 文件级 SQLite 数据格式是固定的、稳定的（dscli 自有格式，无并发写问题——`dscli chat` 写入时插件只读）

实际上有**更轻量的方式**：

```typescript
// 方案：通过 child_process 调用 sqlite3 CLI
import { execSync } from 'child_process';

function loadHistoryFromDscli(cwd: string): ChatMessage[] {
    const dbPath = path.join(os.homedir(), '.dscli', 'sqlite.db');
    const query = `
        SELECT role, content, created_at
        FROM messages
        WHERE session_id = (SELECT id FROM sessions WHERE project_path = '${escape(cwd)}')
          AND role IN ('user', 'assistant')
        ORDER BY id DESC LIMIT 50
    `;
    // 或者使用 dscli history list --histsize 50 --role dev
    // 然后用 dscli history show <id> 获取内容
}
```

**但更好的方式**：直接用 `sqlite3` CLI（如果系统安装了）或 `dscli history` 命令。

### 10.6 具体实现

鉴于 VS Code 扩展不能保证用户系统安装了 `sqlite3` CLI，但 **dscli CLI 一定有**（因为 dscli.vscode 依赖 dscli），我们可以：

1. 用 `dscli history list --histsize 50 --role dev` 获取消息 ID 列表
2. 用 `dscli history show <id>` 获取每条消息的完整内容

但这种方式性能较差（N+1 查询）。

**更好的折衷**：用 Node.js 内置的 `fs.readFileSync` + 简单的 SQLite 解析。但 SQLite 格式复杂，不适合手动解析。

**所以最终建议**：使用 `sql.js`（WASM 版 SQLite），因为它：
- 纯 JS，无 native 编译
- VS Code 扩展的 `localResourceRoots` 可以配置加载 WASM
- 同步 API 可用（通过 `initSqlJs` 初始化后）

```typescript
// 最简实现：使用 sql.js
import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

async function loadHistory(cwd: string): Promise<ChatMessage[]> {
    const SQL = await initSqlJs();
    const dbPath = path.join(os.homedir(), '.dscli', 'sqlite.db');
    const buffer = readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    const stmt = db.prepare(`
        SELECT role, content, created_at
        FROM messages
        WHERE session_id = (SELECT id FROM sessions WHERE project_path = $cwd)
          AND role IN ('user', 'assistant')
        ORDER BY id ASC
    `);
    stmt.bind({ $cwd: cwd });

    const messages: ChatMessage[] = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        messages.push({
            id: `hist_${messages.length}`,
            role: row.role,
            content: row.content,
            timestamp: new Date(row.created_at + 'Z'),
            isStreaming: false,
        });
    }
    stmt.free();
    db.close();

    // 取最近 50 条
    return messages.slice(-50);
}
```

### 10.7 完整性保证

有人可能会担心：**如果用户同时在 CLI 和 VS Code 中使用 dscli 聊天，VS Code 读取 DB 时会不会读到不完整的数据？**

不会。SQLite 的读一致性保证：
- `readFileSync` 读取的是某个时刻的 snapshot
- SQLite WAL 模式下，reader 不会 block writer
- 即使读到半条写入，SQLite 的原子提交保证文件级别的完整性

但为了绝对安全，可以加上重试逻辑：

```typescript
async function loadHistory(cwd: string, retries = 3): Promise<ChatMessage[]> {
    for (let i = 0; i < retries; i++) {
        try {
            const buffer = readFileSync(dbPath);
            // 尝试解析……
            return messages;
        } catch (e) {
            if (i === retries - 1) throw e;
            await sleep(100);  // 100ms 后重试
        }
    }
    return [];
}
```

### 10.8 设计决策记录

| 决策 | ~~之前的选择~~ | 最终选择 |
|------|---------------|---------|
| 是否插件自建持久化 | ✅ 项目本地 JSON | ❌ **不持久化**——dscli 已存好 |
| 历史数据来源 | `.dscli/chat-history.json` | `~/.dscli/sqlite.db` (dscli 的数据库) |
| 读取方式 | 解析 JSON 文件 | `sql.js` WASM + `readFileSync` |
| 保存时机 | `finalizeStreamMessage()` + `dispose()` | **不需要保存** |
| 配置项 | 两个配置开关 | **不需要** |
| 新增文件 | `ChatHistoryService.ts` | **零新增文件** |

### 10.9 修正后伪代码

ChatPanel.ts 只新增一个方法，改动约 30 行：

```typescript
// ChatPanel.ts — 新增方法
private async loadHistoryFromDscli(): Promise<ChatMessage[]> {
    const dbPath = path.join(os.homedir(), '.dscli', 'sqlite.db');
    try {
        if (!fs.existsSync(dbPath)) return [];
        const SQL = await initSqlJs();
        const buffer = fs.readFileSync(dbPath);
        const db = new SQL.Database(buffer);
        const stmt = db.prepare(`
            SELECT role, content, created_at
            FROM messages
            WHERE session_id = (SELECT id FROM sessions WHERE project_path = $cwd)
              AND role IN ('user', 'assistant')
            ORDER BY id ASC
        `);
        stmt.bind({ $cwd: this.cwd });
        const msgs: ChatMessage[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            msgs.push({
                id: `hist_${msgs.length}`,
                role: row.role,
                content: row.content,
                timestamp: new Date(row.created_at + 'Z'),
                isStreaming: false,
            });
        }
        stmt.free();
        db.close();
        return msgs.slice(-50);
    } catch (err) {
        logger.warn('读取 dscli 聊天历史失败', err);
        return [];
    }
}

// ChatPanel.show() — 在欢迎消息后调用
private async onPanelReady(): Promise<void> {
    // 发送欢迎消息（已有）
    // 发送项目名（已有）
    // 发送工作目录（已有）

    // 新增：加载 dscli 历史
    const history = await this.loadHistoryFromDscli();
    if (history.length > 0) {
        this.postMessage('addMessage', {
            role: 'system',
            content: `─── 共有 ${history.length} 条历史记录 ───`,
            isStreaming: false,
            isError: false,
        });
        for (const msg of history) {
            this.currentMessages.push(msg);
            this.postMessage('addMessage', {
                role: msg.role,
                content: msg.content,
                isStreaming: false,
                isError: false,
            });
        }
    }
}
```
