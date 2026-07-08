/**
 * env.ts 单元测试
 *
 * 测试策略：
 * - jest.mock('fs') 将 existsSync / accessSync 替换为 jest.fn，
 *   默认委托给真实实现，在需要时可通过 mockReturnValue / mockImplementation 覆盖
 * - macOS 测试使用真实文件系统（路径实际存在）
 * - Linux / Windows 测试通过 mock 控制文件系统 + 模拟 process.platform
 *
 * 注意：所有平台测试运行在 macOS 主机上。Windows 路径使用类 Unix 绝对路径，
 * 以兼容 path.join —— 测试的是路径拼接逻辑，不是 Windows 路径语义。
 */
jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
        ...real,
        existsSync: jest.fn().mockImplementation((...args: any[]) =>
            (real.existsSync as Function)(...args)
        ),
        accessSync: jest.fn().mockImplementation((...args: any[]) =>
            (real.accessSync as Function)(...args)
        ),
    };
});

import * as fs from 'fs';
import { findVscodeCliPath, resolveEditorValue, getVscodeCliDir } from '../utils/env';

const mockExists = fs.existsSync as jest.Mock;
const mockAccess = fs.accessSync as jest.Mock;

// 保存原始值
const ORIGINAL_PLATFORM = Reflect.get(process, 'platform');
const ORIGINAL_EDITOR = process.env.EDITOR;

function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function restorePlatform(): void {
    Object.defineProperty(process, 'platform', {
        value: ORIGINAL_PLATFORM,
        configurable: true,
    });
}

beforeEach(() => {
    delete process.env.EDITOR;
    mockExists.mockClear();
    mockAccess.mockClear();
    // 确保 mock 恢复默认行为（委托给真实 fs）
    mockExists.mockImplementation((...args: any[]) =>
        (jest.requireActual('fs').existsSync as Function)(...args)
    );
    mockAccess.mockImplementation((...args: any[]) =>
        (jest.requireActual('fs').accessSync as Function)(...args)
    );
});

afterAll(() => {
    restorePlatform();
    jest.restoreAllMocks();
    if (ORIGINAL_EDITOR !== undefined) {
        process.env.EDITOR = ORIGINAL_EDITOR;
    }
});

// ─── findVscodeCliPath ───────────────────────────────────────

describe('findVscodeCliPath', () => {
    it('should return null for empty appRoot', () => {
        expect(findVscodeCliPath('')).toBeNull();
    });

    describe('macOS (mocked platform + fs)', () => {
        beforeEach(() => {
            setPlatform('darwin');
            mockExists.mockImplementation(() => true);
            mockAccess.mockImplementation(() => undefined);
        });
        afterEach(restorePlatform);

        it('should return macOS-specific path', () => {
            const appRoot = '/Applications/Visual Studio Code.app/Contents/Resources/app';
            expect(findVscodeCliPath(appRoot)).toBe(`${appRoot}/bin/code`);
        });

        it('should resolve resolveEditorValue correctly', () => {
            const appRoot = '/Applications/Visual Studio Code.app/Contents/Resources/app';
            const result = resolveEditorValue(appRoot);
            expect(result).toBe('code --wait');
        });
    });

    describe('Linux (mocked platform + fs)', () => {
        beforeEach(() => {
            setPlatform('linux');
            mockExists.mockImplementation(() => true);
            mockAccess.mockImplementation(() => undefined);
        });
        afterEach(restorePlatform);

        it('should return deb/rpm path', () => {
            const appRoot = '/usr/share/code/resources/app';
            expect(findVscodeCliPath(appRoot)).toBe('/usr/share/code/bin/code');
        });

        it('should fall back to Snap path when deb/rpm missing', () => {
            mockExists
                .mockImplementationOnce(() => false)  // /usr/share/code/bin/code
                .mockImplementationOnce(() => true);   // /snap/bin/code

            expect(findVscodeCliPath('/usr/share/code/resources/app')).toBe('/snap/bin/code');
        });

        it('should return null when all candidates missing', () => {
            mockExists.mockReturnValue(false);
            expect(findVscodeCliPath('/usr/share/code/resources/app')).toBeNull();
        });
    });

    describe('Windows (mocked platform + fs)', () => {
        beforeEach(() => {
            setPlatform('win32');
            mockExists.mockImplementation(() => true);
            mockAccess.mockImplementation(() => undefined);
        });
        afterEach(restorePlatform);

        it('should return code.cmd path', () => {
            const appRoot = '/vscode/install/resources/app';
            expect(findVscodeCliPath(appRoot)).toBe('/vscode/install/bin/code.cmd');
        });

        it('should fall back to code.bat when code.cmd missing', () => {
            mockExists
                .mockImplementationOnce(() => false)   // code.cmd
                .mockImplementationOnce(() => true);    // code.bat

            expect(findVscodeCliPath('/vscode/install/resources/app'))
                .toBe('/vscode/install/bin/code.bat');
        });
    });

    it('should return null when file exists but is not executable', () => {
        setPlatform('linux');
        mockExists.mockReturnValue(true);
        mockAccess.mockImplementation(() => { throw new Error('EACCES'); });

        expect(findVscodeCliPath('/any/appRoot')).toBeNull();
        restorePlatform();
    });
});

// ─── resolveEditorValue ──────────────────────────────────────

describe('resolveEditorValue', () => {
    it('should return "code --wait" even when EDITOR is already set', () => {
        process.env.EDITOR = 'vim';
        setPlatform('linux');
        mockExists.mockReturnValue(true);
        mockAccess.mockImplementation(() => undefined);

        expect(resolveEditorValue('/usr/share/code/resources/app'))
            .toBe('code --wait');
        restorePlatform();
    });

    it('should use "code --wait" when code CLI found on macOS/Linux', () => {
        setPlatform('linux');
        mockExists.mockReturnValue(true);
        mockAccess.mockImplementation(() => undefined);

        expect(resolveEditorValue('/usr/share/code/resources/app'))
            .toBe('code --wait');
        restorePlatform();
    });

    it('should use "code --wait" when code CLI found on Windows', () => {
        setPlatform('win32');
        mockExists.mockReturnValue(true);
        mockAccess.mockImplementation(() => undefined);

        expect(resolveEditorValue('/vscode/install/resources/app'))
            .toBe('code --wait');
        restorePlatform();
    });

    it('should return null when code CLI not found (no fallback)', () => {
        setPlatform('linux');
        mockExists.mockReturnValue(false);

        expect(resolveEditorValue('/nonexistent')).toBeNull();
        restorePlatform();
    });
});
// ─── getVscodeCliDir ─────────────────────────────────────────

describe('getVscodeCliDir', () => {
    describe('macOS (mocked platform + fs)', () => {
        beforeEach(() => {
            setPlatform('darwin');
            mockExists.mockImplementation(() => true);
            mockAccess.mockImplementation(() => undefined);
        });
        afterEach(restorePlatform);

        it('should return directory containing code CLI on macOS', () => {
            const appRoot = '/Applications/Visual Studio Code.app/Contents/Resources/app';
            const dir = getVscodeCliDir(appRoot);
            expect(dir).toBe(`${appRoot}/bin`);
        });
    });

    it('should return parent dir of deb/rpm path on Linux', () => {
        setPlatform('linux');
        mockExists.mockReturnValue(true);
        mockAccess.mockImplementation(() => undefined);

        const appRoot = '/usr/share/code/resources/app';
        expect(getVscodeCliDir(appRoot)).toBe('/usr/share/code/bin');
        restorePlatform();
    });

    it('should return parent dir of code.cmd on Windows', () => {
        setPlatform('win32');
        mockExists.mockReturnValue(true);
        mockAccess.mockImplementation(() => undefined);

        const appRoot = '/vscode/install/resources/app';
        expect(getVscodeCliDir(appRoot)).toBe('/vscode/install/bin');
        restorePlatform();
    });

    it('should return Snap path dir on Linux when deb/rpm missing', () => {
        setPlatform('linux');
        mockAccess.mockImplementation(() => undefined); // succeed access check
        mockExists
            .mockImplementationOnce(() => false)  // /usr/share/code/bin/code
            .mockImplementationOnce(() => true);   // /snap/bin/code

        expect(getVscodeCliDir('/usr/share/code/resources/app')).toBe('/snap/bin');
        restorePlatform();
    });

    it('should return null when no code CLI found', () => {
        setPlatform('linux');
        mockExists.mockReturnValue(false);

        expect(getVscodeCliDir('/nonexistent')).toBeNull();
        restorePlatform();
    });

    it('should return null for empty appRoot', () => {
        expect(getVscodeCliDir('')).toBeNull();
    });
});
