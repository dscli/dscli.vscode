# dscli VSCode Extension — 开发指南

面向插件开发者的技术文档。

---

## 架构概览

```text
┌──────────────────────────────────┐
│  VSCode Extension (TypeScript)   │  ← 本项目
│  ChatPanel + ProcessService      │
│  职责: UI 渲染、进程管理、凭证存储    │
└──────────┬───────────────────────┘
           │ stdin/stdout (子进程)
┌──────────▼───────────────────────┐
│  dscli CLI (Go)                  │  ← github.com/dscli/dscli
│  职责: 对话、工具调用、上下文、       │
│  历史管理、技能系统、prompt 模板     │
└──────────┬───────────────────────┘
           │ HTTPS
┌──────────▼───────────────────────┐
│  DeepSeek API                    │
└──────────────────────────────────┘
```

**核心设计原则**：扩展是薄 UI 层。所有智能能力（上下文感知、工具调用、项目检测、提示词模板）由 dscli CLI 后端负责。不要在 TypeScript 层重复实现 CLI 已有的能力。

---

## 项目结构

```text
dscli.vscode/
├── src/
│   ├── extension.ts              # 入口：激活、命令注册、DscliExtension 类
│   ├── ui/
│   │   └── ChatPanel.ts          # Webview 聊天面板（HTML/CSS/JS 内联）
│   ├── services/
│   │   ├── ProcessService.ts     # 子进程管理（spawn dscli chat）
│   │   ├── ConfigService.ts      # 读取 VSCode 配置项
│   │   └── SecretService.ts      # API Key 安全存储（SecretStorage）
│   ├── utils/
│   │   └── logger.ts             # 结构化日志（OutputChannel）
│   └── __tests__/                # Jest 单元测试
├── out/                          # tsc 编译产物
├── images/                       # 图标 (icon.png, icon.svg, chat-*.svg)
├── .vscode/
│   ├── launch.json               # F5 调试配置
│   ├── tasks.json                # 编译任务
│   └── settings.json             # 项目设置
├── package.json                  # 扩展清单 + 命令 + 配置项
├── tsconfig.json                 # TypeScript: CommonJS, ES2022, strict
├── eslint.config.js              # ESLint flat config
├── jest.config.cjs               # Jest 配置
└── .vscodeignore                 # VSIX 打包排除规则
```

---

## 数据流

```text
用户输入 → ChatPanel.webview
  → postMessage('sendMessage', content)
    → ChatPanel.handleUserMessage()
      → SecretService.getApiKey()
      → ProcessService.createProcess({
          command: 'dscli',
          args: ['chat'],
          input: content,         ← 通过 stdin 传入
          env: { DEEPSEEK_API_KEY },
          onData: handleStreamData,
          onExit: finalizeStreamMessage
        })
          → spawn('dscli', ['chat'])
            → dscli 读取 stdin → 调用 DeepSeek API → stdout 流式输出
          → onData → postMessage('updateStreamMessage')
            → webview 实时渲染
```

---

## 命令注册

`package.json` 中的 `contributes.commands` 与 `extension.ts` 中的 `registerCommand` 一一对应：

| 命令 ID | 处理方法 | 功能 |
| ------- | ------- | ---- |
| `dscli.openChat` | `openChat()` | 打开/显示聊天面板 |
| `dscli.analyzeFile` | `analyzeCurrentFile()` | 将当前文件发送给 AI |
| `dscli.setApiKey` | `setApiKey()` | 设置 API Key |
| `dscli.checkStatus` | `checkStatus()` | 显示系统状态 |
| `dscli.clearHistory` | `clearHistory()` | 销毁聊天面板 |
| `dscli.interrupt` | `interrupt()` | 终止 dscli 子进程 |

---

## 开发环境搭建

### 前置要求

- Node.js >= 18
- npm >= 9
- dscli CLI（用于端到端测试）

### 安装依赖

```bash
npm install
```

### 编译

```bash
npm run compile     # 单次编译
npm run watch       # 监听模式（开发时推荐）
```

### 调试

1. 在 VSCode 中打开项目
2. 按 `F5` 启动 Extension Development Host
3. 在新窗口中测试扩展
4. 修改 `.ts` 后，在新窗口按 `Cmd+R` 重新加载

调试日志：

- Extension Development Host → `Cmd+Shift+P` → `Developer: Toggle Developer Tools` → Console
- 主窗口 → Debug Console

### 测试

```bash
npm test                # 运行所有测试
npm run test:watch      # 监听模式
npm run test:coverage   # 覆盖率报告
```

### Lint

```bash
npm run lint
```

---

## 打包发布

```bash
npm run build   # 编译 + 打包 VSIX

# 或分步：
npm run compile
npm run package
```

产物：项目根目录下的 `dscli-vscode-x.y.z.vsix`。

`.vscodeignore` 控制 VSIX 中包含哪些文件。当前包含 `out/`、`images/`、`package.json`、`README.md`、`LICENSE`；排除 `src/`、`node_modules/`、测试文件。

---

## 关键设计决策

### 为什么不在扩展中实现智能服务？

dscli CLI 已经完整实现了项目感知（`GetProjectRoot`）、工具调用（`alltools.GetAllTools`）、对话历史（`LoadHistory/SaveMessages`）、技能系统（`LoadSkills`）、提示词模板（`LoadPrompts`）。在 TypeScript 层重复实现这些能力会导致：

1. **状态不一致** — CLI 和扩展各维护一套上下文
2. **重复维护成本** — 同一逻辑在 Go 和 TypeScript 中各一份
3. **架构耦合** — 扩展变成厚客户端，CLI 和扩展之间需要复杂同步

正确做法：扩展只负责 UI，通过 stdin/stdout 与 dscli 通信。如果需要增强智能能力，修改 dscli CLI（Go），不是扩展。

### 为什么用 CommonJS 而不是 ESM？

VSCode 扩展的宿主环境使用 CommonJS 加载 `main` 入口。设置 `"type": "module"` 会导致模块解析失败，扩展永远卡在 "activating" 状态。`tsconfig.json` 中 `"module": "commonjs"` 是必须的。

### 为什么 Webview HTML 是内联的？

ChatPanel 的 HTML/CSS/JS 直接在 TypeScript 模板字符串中生成。好处是：

- 无需额外的构建管道（webpack/vite）
- CSP nonce 在运行时生成，嵌入模板
- 部署简单，单文件输出

---

## 版本发布流程

1. 更新 `package.json` 中的 `version`
2. 更新 `CHANGES.md`
3. `npm run build`
4. 测试 `.vsix` 安装
5. 发布到 Releases 页面
