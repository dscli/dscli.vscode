/**
 * ProcessService 单元测试
 *
 * 测试进程生命周期管理：创建、回调、终止、dispose
 * 使用真实子进程（echo/cat），不 mock child_process
 */

import { ProcessService } from '../services/ProcessService';

describe('ProcessService', () => {
  let service: ProcessService;

  beforeEach(async () => {
    service = new ProcessService();
    await service.initialize();
  });

  afterEach(() => {
    service.dispose();
  });

  describe('createProcess', () => {
    it('should reject when cwd is empty', async () => {
      await expect(
        service.createProcess({ command: 'echo', args: ['hello'], cwd: '' })
      ).rejects.toThrow('cwd');
    });

    it('should return a process ID', async () => {
      const id = await service.createProcess({
        command: 'echo',
        args: ['test'],
        cwd: '/tmp',
      });

      expect(id).toMatch(/^proc-\d+$/);
    });

    it('should deliver stdout via onData callback', async () => {
      const chunks: string[] = [];

      await new Promise<void>((resolve, reject) => {
        service.createProcess({
          command: 'echo',
          args: ['hello world'],
          cwd: '/tmp',
          onData: (data) => chunks.push(data),
          onExit: (code) => {
            if (code === 0) resolve();
            else reject(new Error(`exit code ${code}`));
          },
        });
      });

      expect(chunks.join('').trim()).toBe('hello world');
    });

    it('should write input to stdin', async () => {
      const chunks: string[] = [];

      await new Promise<void>((resolve, reject) => {
        service.createProcess({
          command: 'cat',
          cwd: '/tmp',
          input: 'stdin content',
          onData: (data) => chunks.push(data),
          onExit: (code) => {
            if (code === 0) resolve();
            else reject(new Error(`exit code ${code}`));
          },
        });
      });

      expect(chunks.join('').trim()).toBe('stdin content');
    });

    it('should report non-zero exit code via onExit', async () => {
      const exitCode = await new Promise<number | null>((resolve) => {
        service.createProcess({
          command: 'sh',
          args: ['-c', 'exit 42'],
          cwd: '/tmp',
          onExit: (code) => resolve(code),
        });
      });

      expect(exitCode).toBe(42);
    });

    it('should support multiple concurrent processes', async () => {
      const results: string[] = [];

      const p1 = new Promise<void>((resolve, reject) => {
        service.createProcess({
          command: 'sh',
          args: ['-c', 'echo proc1'],
          cwd: '/tmp',
          onData: (data) => { results.push('p1:' + data.trim()); },
          onExit: (code) => {
            if (code === 0) resolve();
            else reject(new Error(`p1 exit code ${code}`));
          },
        });
      });

      const p2 = new Promise<void>((resolve, reject) => {
        service.createProcess({
          command: 'sh',
          args: ['-c', 'echo proc2'],
          cwd: '/tmp',
          onData: (data) => { results.push('p2:' + data.trim()); },
          onExit: (code) => {
            if (code === 0) resolve();
            else reject(new Error(`p2 exit code ${code}`));
          },
        });
      });

      await Promise.all([p1, p2]);

      expect(results).toContain('p1:proc1');
      expect(results).toContain('p2:proc2');
    });
  });

  describe('killProcess', () => {
    it('should return false for unknown process ID', () => {
      expect(service.killProcess('nonexistent')).toBe(false);
    });

    it('should kill a running process', async () => {
      const exitPromise = new Promise<number | null>((resolve) => {
        service.createProcess({
          command: 'sleep',
          args: ['60'],
          cwd: '/tmp',
          onExit: (code) => resolve(code),
        }).then((id) => {
          // 等待进程启动后再终止
          setTimeout(() => service.killProcess(id), 100);
        });
      });

      const code = await exitPromise;
      // 被终止的进程返回 null 退出码
      expect(code).toBeNull();
    });
  });

  describe('getRunningCount', () => {
    it('should return 0 when no processes are running', () => {
      expect(service.getRunningCount()).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should kill all running processes', async () => {
      const exitPromise = new Promise<void>((resolve) => {
        service.createProcess({
          command: 'sleep',
          args: ['60'],
          cwd: '/tmp',
          onExit: () => resolve(),
        });
      });

      expect(service.getRunningCount()).toBe(1);
      service.dispose();

      // 等待被终止进程的 exit 回调触发
      await exitPromise;
      expect(service.getRunningCount()).toBe(0);
    });
  });
});
