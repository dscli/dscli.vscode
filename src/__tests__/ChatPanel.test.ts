/**
 * ChatPanel 单元测试（纯逻辑部分）
 *
 * ChatPanel 的核心业务逻辑与 WebView UI 分离：
 *   - 构造函数 → cwd / projectName
 *   - getMessages() → 消息列表副本
 *   - onDidDispose → 回调注册与触发
 *   - sendUserMessage → 委托给 handleUserMessage
 *   - show() → WebViewPanel 创建/复用
 *
 * WebView 完整的消息循环和 HTML 模板需要 VS Code 集成测试环境，
 * 此处不覆盖 message handler、流式渲染等。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { ChatPanel } from '../ui/ChatPanel';
import { ProcessService } from '../services/ProcessService';
import { ConfigService } from '../services/ConfigService';
import { SecretService } from '../services/SecretService';

import * as child_process from 'child_process';

// ---------------------------------------------------------------------------
// Mock child_process.execFile — loadHistoryFromDscli 依赖它
// ---------------------------------------------------------------------------
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));


// Mock fs.readFileSync — ChatPanel.show() 会读取 media/chatPanel.html
// ---------------------------------------------------------------------------
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(() => '<html>{{NONCE}}</html>'),
}));

// ---------------------------------------------------------------------------
// 共享 Mock ExtensionContext
// ---------------------------------------------------------------------------
function createMockContext(): vscode.ExtensionContext {
  const store: Record<string, string> = {};
  return {
    secrets: {
      get: jest.fn(async (key: string) => store[key]),
      store: jest.fn(async (key: string, value: string) => { store[key] = value; }),
      delete: jest.fn(async (key: string) => { delete store[key]; }),
      onDidChange: jest.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

// ---------------------------------------------------------------------------
// Mock WebviewPanel
// ---------------------------------------------------------------------------
let mockWebviewPanel: vscode.WebviewPanel;

beforeEach(() => {
  mockWebviewPanel = {
    webview: {
      html: '',
      postMessage: jest.fn(),
      onDidReceiveMessage: jest.fn(),
    } as any,
    reveal: jest.fn(),
    dispose: jest.fn(),
    onDidDispose: jest.fn(),
  } as any;

  (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockWebviewPanel);
});

// ---------------------------------------------------------------------------
// 辅助：创建 ChatPanel 实例
// ---------------------------------------------------------------------------
function createPanel(cwd = '/tmp/test-project'): ChatPanel {
  const processService = new ProcessService();
  const configService = new ConfigService();
  const secretService = new SecretService(createMockContext());
  const extensionUri = { fsPath: '/mock/extension', scheme: 'file' } as any;

  return new ChatPanel(processService, configService, secretService, extensionUri, cwd);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ChatPanel', () => {
  describe('constructor', () => {
    it('should set cwd and projectName from argument', () => {
      const panel = createPanel('/tmp/my-project');
      expect(panel.cwd).toBe('/tmp/my-project');
      expect(panel.projectName).toBe('my-project');
    });

    it('should derive projectName from basename of cwd', () => {
      const panel = createPanel('/a/b/c/d/e/f/g');
      expect(panel.projectName).toBe('g');
    });

    it('should use empty string for root path basename', () => {
      // path.basename('/') 在 Node.js 中返回 ''
      const panel = createPanel('/');
      expect(panel.projectName).toBe('');
    });
  });

  describe('getMessages', () => {
    it('should return empty array initially', () => {
      const panel = createPanel();
      expect(panel.getMessages()).toEqual([]);
    });

    it('should return a copy (not the internal array)', () => {
      const panel = createPanel();
      const msgs = panel.getMessages();
      msgs.push({ id: 'x', role: 'user', content: 'hi', timestamp: new Date() });
      expect(panel.getMessages()).toHaveLength(0);
    });
  });

  describe('onDidDispose', () => {
    it('should register a handler and call it on dispose', () => {
      const panel = createPanel();
      const handler = jest.fn();
      panel.onDidDispose(handler);

      // dispose() 现在总是通知回调（即使没有 webview panel）
      panel.dispose();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support multiple handlers', () => {
      const panel = createPanel();
      const h1 = jest.fn();
      const h2 = jest.fn();

      panel.onDidDispose(h1);
      panel.onDidDispose(h2);
      panel.dispose();

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('should clear handlers after dispose', () => {
      const panel = createPanel();
      const handler = jest.fn();

      panel.onDidDispose(handler);
      panel.dispose();
      handler.mockClear();
      panel.dispose();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should clear message list', () => {
      const panel = createPanel();
      panel.dispose();
      expect(panel.getMessages()).toHaveLength(0);
    });

    it('should be idempotent', () => {
      const panel = createPanel();
      expect(() => {
        panel.dispose();
        panel.dispose();
      }).not.toThrow();
    });

    it('should dispose the underlying webview panel if shown', () => {
      const panel = createPanel();
      panel.show();
      panel.dispose();

      expect(mockWebviewPanel.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendUserMessage', () => {
    it('should exist as a function', () => {
      const panel = createPanel();
      expect(typeof panel.sendUserMessage).toBe('function');
    });

    it('should not throw when called without active webview panel', () => {
      const panel = createPanel();
      expect(() => panel.sendUserMessage('hello')).not.toThrow();
    });
  });

  describe('reveal', () => {
    it('should not throw when panel is not shown yet', () => {
      const panel = createPanel();
      expect(() => panel.reveal()).not.toThrow();
    });
  });

  describe('show', () => {
    beforeEach(() => {
      // 重置 fs.readFileSync mock 的调用统计
      (fs.readFileSync as jest.Mock).mockClear();
      (fs.readFileSync as jest.Mock).mockReturnValue('<html>{{NONCE}}</html>');
    });

    it('should create a WebviewPanel on first call', () => {
      const panel = createPanel();
      panel.show();

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'dscliChat',
        'dscli: test-project',
        vscode.ViewColumn.Beside,
        expect.objectContaining({
          enableScripts: true,
          retainContextWhenHidden: true,
        }),
      );
    });

    it('should reuse existing panel on subsequent calls', () => {
      const panel = createPanel();

      panel.show();
      panel.show();

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
      expect(mockWebviewPanel.reveal).toHaveBeenCalledTimes(1);
    });

    it('should set webview HTML content (nonce-substituted)', () => {
      const panel = createPanel();
      panel.show();

      expect(fs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('media/chatPanel.html'),
        'utf8',
      );
      // HTML 应包含替换后的 nonce（不含 {{NONCE}} 占位符）
      expect(mockWebviewPanel.webview.html).not.toContain('{{NONCE}}');
      expect(mockWebviewPanel.webview.html).toContain('</html>');
    });
  });
  describe('history loading (hasMoreHistory)', () => {
    const mockExecFile = child_process.execFile as unknown as jest.Mock;

    function makeHistoryItems(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        role: 'user',
        content: `msg ${i + 1}`,
        created_at: new Date(2024, 0, i + 1).toISOString(),
      }));
    }

    beforeEach(() => {
      jest.useFakeTimers();
      mockExecFile.mockReset();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should send hasMoreHistory=false when total <= pageSize (all loaded)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify(makeHistoryItems(17)), '');
        return { unref: jest.fn() };
      });

      const panel = createPanel();
      panel.show();

      // 触发 show() 内部的 setTimeout(200ms)
      jest.advanceTimersByTime(200);
      // 等待微任务（loadHistoryFromDscli 中的 Promise.resolve）
      await Promise.resolve();

      // 应该有 hasMoreHistory: false
      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'hasMoreHistory', hasMore: false }),
      );
    });

    it('should send hasMoreHistory=true when total > pageSize', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify(makeHistoryItems(25)), '');
        return { unref: jest.fn() };
      });

      const panel = createPanel();
      panel.show();

      jest.advanceTimersByTime(200);
      await Promise.resolve();

      // 有更多历史可加载
      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'hasMoreHistory', hasMore: true }),
      );
    });

    it('should NOT send hasMoreHistory when no history exists', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify([]), '');
        return { unref: jest.fn() };
      });

      const panel = createPanel();
      panel.show();

      jest.advanceTimersByTime(200);
      await Promise.resolve();

      // 无历史时不应发送 hasMoreHistory
      const calls = (mockWebviewPanel.webview.postMessage as jest.Mock).mock.calls;
      const hasMoreCalls = calls.filter((c: any[]) => c[0]?.command === 'hasMoreHistory');
      expect(hasMoreCalls).toHaveLength(0);
    });
    it('should pass --histsize 100000 to dscli history list', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify(makeHistoryItems(5)), '');
        return { unref: jest.fn() };
      });

      const panel = createPanel();
      panel.show();

      jest.advanceTimersByTime(200);
      await Promise.resolve();

      // 验证 CLI 参数包含 --histsize
      expect(mockExecFile).toHaveBeenCalled();
      const callArgs = mockExecFile.mock.calls[0][1] as string[];
      expect(callArgs).toContain('--histsize');
      const histsizeIdx = callArgs.indexOf('--histsize');
      expect(parseInt(callArgs[histsizeIdx + 1], 10)).toBeGreaterThanOrEqual(100000);
    });

    it('should load ALL history even when dscli default limit (32) would be insufficient', async () => {
      // 模拟 200 条历史（远超默认 histsize=32），确认能全部加载进内存
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify(makeHistoryItems(200)), '');
        return { unref: jest.fn() };
      });

      const panel = createPanel();
      panel.show();

      jest.advanceTimersByTime(200);
      await Promise.resolve();

      // 检查 postMessage 确认 hasMoreHistory: true（因为 200 > HISTORY_PAGE_SIZE=20）
      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'hasMoreHistory', hasMore: true }),
      );
    });
  });
});
