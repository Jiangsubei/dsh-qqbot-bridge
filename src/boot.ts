/**
 * dsh-qqbot-bridge: DSH 真实服务装配运行时 (Boot Helper)
 *
 * 通过 @deepseek-ai/dsh-app-boot 装配真实的 DeepSeek Harness 基础环境（storage / agents / llm /
 * settings / credentials / workspace 等官方服务），并支持挂载 dsh-qqbot-bridge 插件。
 *
 * 主要用于契约测试的端到端真实装配验证与集成运行。
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import {
  boot,
  loadOverlayPatches,
  healProfilesModuleFallback,
  resolveBundleDir,
} from '@deepseek-ai/dsh-app-boot';

const require = createRequire(import.meta.url);

/** 测试/探针专用 profile 名（与生产 profile `web` 隔离） */
const TEST_PROFILE = 'qqbot-test';

export interface BootDshOptions {
  dshHome?: string;
  configPath?: string;
  /** 插件配置；仅在 mountPlugin 为 true 时消费 */
  config?: Record<string, unknown>;
  extraPatches?: any[];
  prepare?: (ctx: Context) => Promise<void> | void;
  /**
   * 是否挂载本插件。默认 **false**：探针阶段（P1）尚无 `src/index.ts`，
   * 只装配 DSH 基础环境即可；P2 起契约测试可显式置 true。
   */
  mountPlugin?: boolean;
}

export interface BootedDsh {
  ctx: Context;
  dshHome: string;
  dispose: () => Promise<void>;
}

export function resolveDshHome(customHome?: string): string {
  if (customHome) return path.resolve(customHome);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.resolve(home, '.dsh');
}

/**
 * 装配并启动真实的 DeepSeek Harness 服务栈。
 */
export async function bootDshQqbotBridge(options: BootDshOptions = {}): Promise<BootedDsh> {
  const dshHome = resolveDshHome(options.dshHome);
  process.env.DSH_HOME = dshHome;

  // 1. 定位 DSH 安装锚点
  let installAnchor: string;
  try {
    installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  } catch {
    installAnchor = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../node_modules/@deepseek-ai/dsh/package.json'
    );
  }

  await healProfilesModuleFallback({ installAnchor, home: dshHome });

  // 2. 准备 profile 目录与 cordis.yml 根配置
  const profileDir = path.join(dshHome, 'profiles', TEST_PROFILE);
  await fsp.mkdir(profileDir, { recursive: true });

  const rootConfig = path.join(profileDir, 'cordis.yml');
  if (!fs.existsSync(rootConfig)) {
    await fsp.writeFile(rootConfig, '[]\n', 'utf8');
  }

  const profilePackageJson = path.join(profileDir, 'package.json');
  if (!fs.existsSync(profilePackageJson)) {
    const manifest = {
      name: `dsh-profile-${TEST_PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    };
    await fsp.writeFile(profilePackageJson, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  // 3. 加载 @deepseek-ai/dsh-base 的 bundle patch
  const baseDir = resolveBundleDir(TEST_PROFILE, '@deepseek-ai/dsh-base', installAnchor, profileDir);
  const baseManifest = JSON.parse(await fsp.readFile(path.join(baseDir, 'package.json'), 'utf8'));
  const declaredPatch = baseManifest.dsh?.bundle?.patch || 'cordis.patch.yml';
  const basePatchPath = path.join(baseDir, declaredPatch);
  const basePatches = loadOverlayPatches(TEST_PROFILE, basePatchPath);

  // 4. 组装 overlay patches
  const storagesDir = path.join(dshHome, 'storages');
  await fsp.mkdir(storagesDir, { recursive: true });

  const configPath = options.configPath || path.join(dshHome, 'settings.yaml');

  const defaultOverlays: any[] = [
    { id: 'hmr', disabled: true },
    {
      id: 'settings',
      config: {
        path: configPath,
        dshHome,
        watch: false,
      },
    },
    {
      id: 'credentials',
      config: {
        dshHome,
        watch: false,
      },
    },
    {
      id: 'session-query-sqlite',
      config: {
        path: ':memory:',
        openAt: 'never',
      },
    },
    {
      id: 'storage-json',
      config: {
        root: storagesDir,
      },
    },
    {
      insert: [
        {
          id: 'workspace',
          name: '@deepseek-ai/dsh-workspace',
        },
      ],
    },
    ...(options.extraPatches || []),
  ];

  // 5. 调用 DSH 官方 boot()
  const ctx = await boot('dsh-qqbot-bridge', rootConfig, [...basePatches, ...defaultOverlays], async (hostCtx) => {
    if (options.prepare) {
      await options.prepare(hostCtx);
    }
  });

  // 6. 按需挂载本插件（动态导入：P1 探针阶段 src/index.ts 尚不存在）
  if (options.mountPlugin === true) {
    // 用变量 specifier：P1 阶段 src/index.ts 尚未创建，字面量导入会让 tsc 编译期报 TS2307。
    // P2 创建 src/index.ts 后，此处即可改回字面量导入以获得完整的静态检查。
    const pluginEntry = './index.js';
    const mod = await import(pluginEntry);
    ctx.plugin(mod as any, options.config || {});
  }

  const dispose = async () => {
    await (ctx as any).emit?.('dispose');
    await (ctx as any).fiber?.dispose?.();
  };

  return {
    ctx,
    dshHome,
    dispose,
  };
}