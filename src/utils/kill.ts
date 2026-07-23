/**
 * 紧急终止所有 dscli 进程
 *
 * 当普通 interrupt 失效时使用。
 * macOS/Linux: pkill -9 -f dscli
 * Windows: taskkill /F /IM dscli*
 */
import { exec } from 'child_process';
import { logger } from './logger';

export async function emergencyKillAll(): Promise<{ killed: boolean; message: string }> {
  const isWin = process.platform === 'win32';
  const command = isWin ? 'taskkill /F /IM dscli*' : 'pkill -9 -f dscli';

  return new Promise((resolve) => {
    exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
      if (!error) {
        logger.info('Emergency kill-all 成功', { command, stdout: stdout.trim() });
        resolve({ killed: true, message: '已终止所有 dscli 进程' });
        return;
      }

      // pkill 退出码 1 = 没有匹配进程，不是错误
      if (!isWin && (error as any).code === 1) {
        logger.debug('Emergency kill-all: 无运行中的 dscli 进程');
        resolve({ killed: false, message: '没有运行中的 dscli 进程' });
        return;
      }

      // taskkill 在 Win7+ 返回 128(无匹配)，WinXP 返回 1
      if (isWin && ((error as any).code === 128 || (error as any).code === 1)) {
        logger.debug('Emergency kill-all: 无运行中的 dscli 进程 (Windows)');
        resolve({ killed: false, message: '没有运行中的 dscli 进程' });
        return;
      }

      // 真实错误（command not found, permission denied 等）
      logger.error('Emergency kill-all 失败', { command, error: error.message });
      resolve({ killed: false, message: `终止失败: ${error.message}` });
    });
  });
}
