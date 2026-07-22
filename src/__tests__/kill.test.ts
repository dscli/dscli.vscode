/**
 * Emergency kill-all 单元测试
 *
 * 验证紧急终止所有 dscli 进程的逻辑：
 *   1. 平台特定命令（pkill / taskkill）
 *   2. 无进程时的优雅降级
 *   3. 真实错误的传播
 */
import { exec } from 'child_process';
import { emergencyKillAll } from '../utils/kill';

// Mock child_process.exec
jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

// Mock logger
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockExec = exec as unknown as jest.Mock;
const OLD_PLATFORM = process.platform;

describe('emergencyKillAll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: OLD_PLATFORM });
  });

  it('should execute pkill -9 -f dscli on macOS/Linux', async () => {
    mockExec.mockImplementation((cmd: string, _opts: any, cb: Function) => {
      expect(cmd).toBe('pkill -9 -f dscli');
      cb(null, 'killed 2', '');
    });

    const result = await emergencyKillAll();
    expect(result.killed).toBe(true);
    expect(result.message).toContain('已终止');
  });

  it('should execute taskkill on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExec.mockImplementation((cmd: string, _opts: any, cb: Function) => {
      expect(cmd).toBe('taskkill /F /IM dscli*');
      cb(null, '', '成功: 已终止进程');
    });

    const result = await emergencyKillAll();
    expect(result.killed).toBe(true);
  });

  it('should handle no matching processes on Unix (exit code 1)', async () => {
    const error = new Error('no process found') as any;
    error.code = 1;
    error.killed = false;
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
      cb(error, '', '');
    });

    const result = await emergencyKillAll();
    expect(result.killed).toBe(false);
    expect(result.message).toContain('没有运行中');
  });

  it('should handle no matching processes on Windows (exit code 128)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const error = new Error('no process') as any;
    error.code = 128;
    error.killed = false;
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
      cb(error, '', '');
    });

    const result = await emergencyKillAll();
    expect(result.killed).toBe(false);
    expect(result.message).toContain('没有运行中');
  });

  it('should return error message on unexpected failures', async () => {
    const error = new Error('command not found');
    (error as any).code = 127;
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
      cb(error, '', '');
    });

    const result = await emergencyKillAll();
    expect(result.killed).toBe(false);
    expect(result.message).toContain('command not found');
  });
});
