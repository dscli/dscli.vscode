/**
 * ChatPanelManager 单元测试
 *
 * 测试多实例面板管理器的核心逻辑：
 *   1. 按路径创建/复用 ChatPanel
 *   2. 生命周期清理（dispose/close）
 *   3. 面板列表查询
 *   4. dispose 回调自动清理
 *
 * ChatPanel 被完整 mock，聚焦 Manager 的管理逻辑。
 */

import * as vscode from 'vscode';
import { ChatPanelManager } from '../ui/ChatPanelManager';
import { ProcessService } from '../services/ProcessService';
import { ConfigService } from '../services/ConfigService';
import { SecretService } from '../services/SecretService';

// ---------------------------------------------------------------------------
// Mock ChatPanel — 每个实例有独立的 mock 方法
// ---------------------------------------------------------------------------
jest.mock('../ui/ChatPanel', () => {
  let instanceCounter = 0;

  return {
    ChatPanel: jest.fn().mockImplementation((_ps, _cs, _ss, _extUri, cwd: string) => {
      const id = ++instanceCounter;
      const projectName = 'proj-' + cwd.replace(/[/\s]/g, '_');
      const handlers: Array<() => void> = [];

      return {
        id,
        cwd,
        projectName,
        show: jest.fn(),
        reveal: jest.fn(),
        dispose: jest.fn(() => {
          const copy = [...handlers];
          handlers.length = 0;
          copy.forEach(h => h());
        }),
        onDidDispose: jest.fn((handler: () => void) => {
          handlers.push(handler);
        }),
        sendUserMessage: jest.fn(),
        getMessages: jest.fn().mockReturnValue([]),
      };
    }),
  };
});

// ---------------------------------------------------------------------------
// 共享：创建 Mock ExtensionContext
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
// 辅助：创建测试用 Manager
// ---------------------------------------------------------------------------
function createManager(
  overrides?: { workspaceFolders?: Array<{ uri: { fsPath: string } }> },
): {
  manager: ChatPanelManager;
} {
  const processService = new ProcessService();
  const configService = new ConfigService();
  const secretService = new SecretService(createMockContext());

  const mockWorkspaceFolders = overrides?.workspaceFolders ?? [];
  (vscode.workspace as any).workspaceFolders = mockWorkspaceFolders;

  const extensionUri = { fsPath: '/mock/extension', scheme: 'file', path: '/mock/extension' } as any;

  const manager = new ChatPanelManager(
    processService,
    configService,
    secretService,
    extensionUri,
  );

  return { manager };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ChatPanelManager', () => {
  afterEach(() => {
    (vscode.workspace as any).workspaceFolders = [];
  });

  describe('openChat', () => {
    it('should create a new ChatPanel for a new path', () => {
      const { manager } = createManager();
      const panel = manager.openChat('/tmp/project-a');

      expect(panel).toBeDefined();
      expect(panel.cwd).toBe('/tmp/project-a');
      expect(panel.show).toHaveBeenCalledTimes(1);
    });

    it('should reuse existing ChatPanel when opening the same path', () => {
      const { manager } = createManager();
      const panel1 = manager.openChat('/tmp/project-a');
      const panel2 = manager.openChat('/tmp/project-a');

      expect(panel1).toBe(panel2);
      expect(panel1.reveal).toHaveBeenCalledTimes(1);
      expect(panel1.show).toHaveBeenCalledTimes(1);
    });

    it('should normalize paths that differ only by trailing slashes', () => {
      const { manager } = createManager();
      const panel1 = manager.openChat('/tmp//project-a///');
      const panel2 = manager.openChat('/tmp/project-a');

      // path.resolve 会移除尾部斜杠，两者应视为同一个路径
      expect(panel1).toBe(panel2);
    });

    it('should create separate panels for different paths', () => {
      const { manager } = createManager();
      const panelA = manager.openChat('/tmp/project-a');
      const panelB = manager.openChat('/tmp/project-b');

      expect(panelA).not.toBe(panelB);
      expect(panelA.cwd).toBe('/tmp/project-a');
      expect(panelB.cwd).toBe('/tmp/project-b');
    });

    it('should fall back to first workspace folder when no cwd given', () => {
      const { manager } = createManager({
        workspaceFolders: [{ uri: { fsPath: '/workspace/foo' } }],
      });
      const panel = manager.openChat();
      expect(panel.cwd).toBe('/workspace/foo');
    });

    it('should fall back to HOME when no workspace folder', () => {
      const { manager } = createManager();
      const panel = manager.openChat();
      expect(panel.cwd).toBe(process.env.HOME ?? '/');
    });
  });

  describe('getOrCreateForActiveEditor', () => {
    it('should return a panel for the active editor workspace', async () => {
      const { manager } = createManager({
        workspaceFolders: [{ uri: { fsPath: '/workspace/active-editor' } }],
      });

      (vscode.window as any).activeTextEditor = {
        document: { uri: { fsPath: '/workspace/active-editor/file.ts' } },
      };

      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
        uri: { fsPath: '/workspace/active-editor' },
      });

      try {
        const panel = await manager.getOrCreateForActiveEditor();
        expect(panel.cwd).toBe('/workspace/active-editor');
      } finally {
        (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReset();
        (vscode.window as any).activeTextEditor = undefined;
      }
    });
  });

  describe('closeChat', () => {
    it('should remove the panel from the manager', () => {
      const { manager } = createManager();
      manager.openChat('/tmp/project-a');
      expect(manager.listPanels()).toHaveLength(1);

      manager.closeChat('/tmp/project-a');
      expect(manager.listPanels()).toHaveLength(0);
    });

    it('should call dispose on the removed panel', () => {
      const { manager } = createManager();
      const panel = manager.openChat('/tmp/project-a');

      manager.closeChat('/tmp/project-a');
      expect(panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('should do nothing for unknown path', () => {
      const { manager } = createManager();
      expect(() => manager.closeChat('/nonexistent')).not.toThrow();
    });
  });

  describe('listPanels', () => {
    it('should return empty array when no panels', () => {
      const { manager } = createManager();
      expect(manager.listPanels()).toEqual([]);
    });

    it('should return panel info for all open panels', () => {
      const { manager } = createManager();
      manager.openChat('/tmp/project-a');
      manager.openChat('/tmp/project-b');

      const list = manager.listPanels();
      expect(list).toHaveLength(2);
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cwd: '/tmp/project-a', projectName: 'proj-_tmp_project-a' }),
          expect.objectContaining({ cwd: '/tmp/project-b', projectName: 'proj-_tmp_project-b' }),
        ]),
      );
    });
  });

  describe('focusPanel', () => {
    it('should reveal an existing panel', () => {
      const { manager } = createManager();
      const panel = manager.openChat('/tmp/project-a');

      manager.focusPanel('/tmp/project-a');
      expect(panel.reveal).toHaveBeenCalledTimes(1);
    });

    it('should do nothing for unknown path', () => {
      const { manager } = createManager();
      expect(() => manager.focusPanel('/nonexistent')).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('should dispose all panels and clear the map', () => {
      const { manager } = createManager();
      const panelA = manager.openChat('/tmp/project-a');
      const panelB = manager.openChat('/tmp/project-b');

      manager.dispose();

      expect(panelA.dispose).toHaveBeenCalledTimes(1);
      expect(panelB.dispose).toHaveBeenCalledTimes(1);
      expect(manager.listPanels()).toHaveLength(0);
    });

    it('should be idempotent', () => {
      const { manager } = createManager();
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
      expect(manager.listPanels()).toHaveLength(0);
    });
  });

  describe('automatic cleanup on panel dispose', () => {
    it('should remove panel from map when its dispose fires', () => {
      const { manager } = createManager();
      const panel = manager.openChat('/tmp/project-a') as any;

      expect(manager.listPanels()).toHaveLength(1);

      // 模拟 ChatPanel 被外部 dispose（用户关闭 WebviewPanel）
      panel.dispose();

      expect(manager.listPanels()).toHaveLength(0);
    });

    it('should not affect other panels when one is disposed', () => {
      const { manager } = createManager();
      const panelA = manager.openChat('/tmp/project-a') as any;
      const panelB = manager.openChat('/tmp/project-b') as any;

      panelA.dispose();

      expect(manager.listPanels()).toHaveLength(1);
      expect(manager.listPanels()[0].cwd).toBe('/tmp/project-b');
    });
  });

  describe('UI-bound methods — edge cases only', () => {
    it('should not throw when calling clearHistory with no panels', async () => {
      const { manager } = createManager();
      await expect(manager.handleClearHistory()).resolves.toBeUndefined();
    });

    it('should not throw when calling showPanelPicker and user cancels', async () => {
      const { manager } = createManager();
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
      await expect(manager.showPanelPicker()).resolves.toBeUndefined();
    });
  });
});
