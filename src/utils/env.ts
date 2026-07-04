/**
 * 环境工具 — 跨平台查找 VSCode CLI (code) 路径
 *
 * dscli 的 AskUser 功能依赖 $EDITOR 环境变量。
 * 在 VSCode 扩展宿主中，$EDITOR 往往未设置且 launchctl setenv 不可靠。
 *
 * 此模块通过 vscode.env.appRoot 定位 code CLI（不依赖 PATH），
 * 使扩展能自动注入 EDITOR 环境变量。
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * 获取平台对应的 code CLI 候选路径列表。
 *
 * 策略：基于 vscode.env.appRoot 的目录结构推算 code 可执行文件位置。
 *
 * - **macOS**:  appRoot = .../Contents/Resources/app
 *   code CLI 位于 appRoot/bin/code
 *
 * - **Linux**:  appRoot = .../resources/app
 *   code CLI 位于 appRoot/../../bin/code（官方 .deb/.rpm 安装）
 *   也检查 /snap/bin/code（Snap 安装）
 *
 * - **Windows**: appRoot = ...\resources\app
 *   code CLI 位于 appRoot\..\..\bin\code.cmd 或 code.bat
 */
function getCodeCliCandidates(appRoot: string): string[] {
    const platform = process.platform;

    switch (platform) {
        case 'darwin': {
            // macOS: Visual Studio Code.app/Contents/Resources/app/bin/code
            return [path.join(appRoot, 'bin', 'code')];
        }
        case 'linux': {
            // Linux (deb/rpm): /usr/share/code/resources/app → /usr/share/code/bin/code
            // Linux (Snap):    /snap/bin/code
            return [
                path.join(appRoot, '..', '..', 'bin', 'code'),
                '/snap/bin/code',
            ];
        }
        case 'win32': {
            // Windows: <install>\resources\app → <install>\bin\code.cmd
            const base = path.join(appRoot, '..', '..', 'bin');
            return [
                path.join(base, 'code.cmd'),
                path.join(base, 'code.bat'),
            ];
        }
        default: {
            return [];
        }
    }
}

/**
 * 查找 VSCode CLI (code) 的完整可执行路径。
 *
 * @param appRoot - vscode.env.appRoot 的值（传入而非内部 import vscode，
 *                  便于单测且不依赖 vscode API 初始化时机）
 * @returns 可执行文件的绝对路径，若找不到则返回 null
 *
 * 使用示例：
 * ```ts
 * import { findVscodeCliPath } from './utils/env';
 * const codePath = findVscodeCliPath(vscode.env.appRoot);
 * ```
 */
export function findVscodeCliPath(appRoot: string): string | null {
    if (!appRoot) {
        return null;
    }

    const candidates = getCodeCliCandidates(appRoot);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            try {
                // 验证文件可执行（Unix 权限位 / Windows 扩展名）
                fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            } catch {
                // 存在但不可执行 ⇒ 尝试下一个候选
                continue;
            }
        }
    }

    return null;
}

/**
 * 获取 VSCode CLI (code) 所在目录的完整路径。
 *
 * 返回的目录可注入到子进程的 PATH 环境变量，使 Go 后端能通过
 * `exec.CommandContext("code", ...)` 找到 code CLI。
 *
 * macOS 上 code 默认不在 PATH 中（除非用户执行了 "Install 'code' command in PATH"），
 * 此函数配合 PATH 注入可确保所有场景下 AskUser 正常工作。
 *
 * @param appRoot - vscode.env.appRoot 的值
 * @returns 包含 code CLI 的目录绝对路径，或 null（code CLI 不可用）
 */
export function getVscodeCliDir(appRoot: string): string | null {
    const codePath = findVscodeCliPath(appRoot);
    return codePath ? path.dirname(codePath) : null;
}

/**
 * 构建可用的 EDITOR 环境变量值 + 增强 PATH。
 *
 * 规则：
 * 1. 如果找到了 code CLI 路径，返回 `code --wait`（依赖 Go 通过 PATH 查找 code）
 * 2. 如果找不到 code CLI，返回 null（让 Go 后端走自身的 fallback 链）
 *
 * 注意：不检查 process.env.EDITOR —— 系统已有的 EDITOR 可能包含
 * 带空格的全路径（如 macOS 上 "/Applications/Visual Studio .../bin/code"），
 * Go 后端 editor.go 用 strings.Fields 解析会错误截断。统一覆盖。
 *
 * @param appRoot - vscode.env.appRoot 的值
 * @returns EDITOR 值（不含引号），或 null（code CLI 不可用）
 */
export function resolveEditorValue(appRoot: string): string | null {
    // 查找 VSCode 内置的 code CLI——验证 VSCode 已安装即可
    const codePath = findVscodeCliPath(appRoot);
    if (codePath) {
        // Go 后端 editor.go 用 strings.Fields + exec.CommandContext
        // 解析 EDITOR，不支持 shell 引号。若直接用完整路径（macOS
        // 上常含空格），strings.Fields 会错误截断。
        // 统一用 'code --wait'，依靠 exec.CommandContext 的 PATH 查找
        // 定位可执行文件。
        return 'code --wait';
    }

    // VSCode 内置 CLI 找不到 → 不设 EDITOR，
    // 让 Go 后端走自身的 fallback 链（vi/nano/vim）
    return null;
}
