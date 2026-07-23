/**
 * ConfigService 单元测试
 *
 * 测试配置读取逻辑：默认值、自定义值、不可变返回
 */

import * as vscode from 'vscode';
import { ConfigService } from '../services/ConfigService';

describe('ConfigService', () => {
  const mockGet = jest.fn();

  beforeEach(() => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: mockGet,
      update: jest.fn(),
    });
  });

  describe('getConfig', () => {
    it('should return default values when no config is set', () => {
      mockGet.mockReturnValue(undefined);

      const service = new ConfigService();
      const config = service.getConfig();

      expect(config.executablePath).toBe('dscli');
      expect(config.model).toBe('deepseek-v4-flash');
      expect(config.agentName).toBe('Galileo');
    });

    it('should return user-configured values', () => {
      mockGet.mockImplementation((key: string) => {
        if (key === 'executablePath') return '/usr/local/bin/dscli';
        if (key === 'model') return 'deepseek-reasoner';
        if (key === 'agentName') return 'DeepSeek';
        return undefined;
      });

      const service = new ConfigService();
      const config = service.getConfig();

      expect(config.executablePath).toBe('/usr/local/bin/dscli');
      expect(config.model).toBe('deepseek-reasoner');
      expect(config.agentName).toBe('DeepSeek');
    });

    it('should return a defensive copy (mutations do not affect internal state)', () => {
      mockGet.mockReturnValue(undefined);

      const service = new ConfigService();
      const config1 = service.getConfig();
      config1.executablePath = 'MUTATED';

      const config2 = service.getConfig();
      expect(config2.executablePath).toBe('dscli');
    });
  });

  describe('initialize', () => {
    it('should resolve without error', async () => {
      mockGet.mockReturnValue(undefined);
      const service = new ConfigService();
      await expect(service.initialize()).resolves.toBeUndefined();
    });
  });
});
