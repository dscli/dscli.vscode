/* eslint-env jest */
// Jest全局设置 - CommonJS格式
// 不需要导入jest，它已经是全局变量

// Mock VSCode API
jest.mock('vscode', () => {
  return {
    window: {
      showInformationMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showQuickPick: jest.fn(),
      showOpenDialog: jest.fn(),
      createOutputChannel: jest.fn(() => ({
        appendLine: jest.fn(),
        show: jest.fn(),
        dispose: jest.fn()
      })),
      createWebviewPanel: jest.fn(),
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: jest.fn(() => ({
        dispose: jest.fn()
      })),
      executeCommand: jest.fn(),
    },
    workspace: {
      getConfiguration: jest.fn(() => ({
        get: jest.fn(),
        update: jest.fn()
      })),
      getWorkspaceFolder: jest.fn(),
      workspaceFolders: []
    },
    QuickPickItemKind: {
      Separator: -1,
      Default: 0,
    },
    ExtensionContext: jest.fn(),
    StatusBarAlignment: {
      Left: 1,
      Right: 2
    },
    ViewColumn: {
      Active: -1,
      Beside: 2,
      One: 1,
      Two: 2,
      Three: 3,
      Four: 4,
      Five: 5,
      Six: 6,
      Seven: 7,
      Eight: 8,
      Nine: 9
    },
    Uri: {
      file: (p) => ({ fsPath: p, scheme: 'file', path: p }),
      parse: (s) => ({ fsPath: s, scheme: 'file', path: s }),
    },
    version: '1.85.0'
  };
}, { virtual: true });

// 全局测试超时
jest.setTimeout(10000);

// 测试前后的清理
beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  // 清理所有模拟
  jest.restoreAllMocks();
});
