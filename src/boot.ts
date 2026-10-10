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
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import {
  boot,
  readProfilePatches,
  type ProfileContext,
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

  // 2. 准备 profile 目录与 cordis.yml 根配置
  const profileDir = path.join(dshHome, 'profiles', TEST_PROFILE);
  await fsp.mkdir(profileDir, { recursive: true });

  // 链接安装 node_modules 到 profileDir/node_modules，供 profile preset 解析包依赖
  const profileNodeModules = path.join(profileDir, 'node_modules');
  if (!fs.existsSync(profileNodeModules)) {
    const dshNodeModules = path.resolve(path.dirname(installAnchor), '../..');
    if (fs.existsSync(dshNodeModules)) {
      try {
        fs.symlinkSync(dshNodeModules, profileNodeModules, 'junction');
      } catch {
        // ignore
      }
    }
  }

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

  // 准备 profile 的 cordis.patch.yml（声明 dsh-qqbot-bridge profile entry）
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) {
    const pluginEntry = path.resolve(process.cwd(), 'dist/index.js');
    const pluginUrl = pathToFileURL(pluginEntry).href;
    const initialPatch = `- insert:\n    - id: dsh-qqbot-bridge\n      name: ${JSON.stringify(pluginUrl)}\n`;
    await fsp.writeFile(patchPath, initialPatch, 'utf8');
  }

  // 3. 组装 overlay patches
  const storagesDir = path.join(dshHome, 'storages');
  await fsp.mkdir(storagesDir, { recursive: true });

  const defaultOverlays: any[] = [
    { id: 'hmr', disabled: true },
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

  // 4. 调用 DSH 官方 boot()
  const bareModuleBaseUrl = pathToFileURL(installAnchor).href;
  const profileContext: ProfileContext = {
    name: TEST_PROFILE,
    dir: profileDir,
    patchPath,
    installAnchor,
    cwd: process.cwd(),
    home: dshHome,
    startedBundles: ['@deepseek-ai/dsh-base'],
    overlays: defaultOverlays,
    telemetryDisabledEnv: '1',
  };

  const patches = readProfilePatches('dsh', profileContext);

  const ctx = await boot(
    'dsh-qqbot-bridge',
    rootConfig,
    patches,
    async (hostCtx) => {
      hostCtx.provide('profileContext', profileContext);
      if (options.prepare) {
        await options.prepare(hostCtx);
      }
    },
    bareModuleBaseUrl
  );

  // 5. 按需挂载本插件或配置
  if (options.mountPlugin === true && options.config && Object.keys(options.config).length > 0) {
    const settings = (ctx as any).settings ?? (ctx as any).get?.('settings');
    if (settings?.update) {
      await settings.update('dsh-qqbot-bridge', options.config);
    }
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