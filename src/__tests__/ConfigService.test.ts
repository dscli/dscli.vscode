/**
 * ConfigService 单元测试
 *
 * 测试配置读取逻辑：默认值、自定义值、不可变返回
 * 新增：streaming 配置开关测试
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
      expect(config.streaming).toBe(true);
    });

    it('should return user-configured values', () => {
      mockGet.mockImplementation((key: string) => {
        if (key === 'executablePath') return '/usr/local/bin/dscli';
        if (key === 'model') return 'deepseek-reasoner';
        if (key === 'streaming') return false;
        return undefined;
      });

      const service = new ConfigService();
      const config = service.getConfig();

      expect(config.executablePath).toBe('/usr/local/bin/dscli');
      expect(config.model).toBe('deepseek-reasoner');
      expect(config.streaming).toBe(false);
    });

    it('should return a defensive copy (mutations do not affect internal state)', () => {
      mockGet.mockReturnValue(undefined);

      const service = new ConfigService();
      const config1 = service.getConfig();
      config1.executablePath = 'MUTATED';
      config1.streaming = false;

      const config2 = service.getConfig();
      expect(config2.executablePath).toBe('dscli');
      expect(config2.streaming).toBe(true);
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
