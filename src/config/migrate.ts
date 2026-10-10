/**
 * dsh-qqbot-bridge: 旧版配置静默迁移
 *
 * 将 0.1.5 时代的 settings.yaml 中的 dsh-qqbot-bridge 配置
 * 迁移至 0.2.0 Profile Patch / Volatile Settings 体系。
 * 迁移过程不阻断应用启动，迁移后内部不再保留任何对旧配置文件的读写技术债。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from '../types/index.js';
import { resolveDshHome } from './credentials.js';
import { resolveLogger } from '../utils/logger.js';
import { PLUGIN_NAME, SETTINGS_NAMESPACE } from '../constants/index.js';

const require = createRequire(import.meta.url);

function parseYaml(content: string): any {
  // 1. 优先通过 @deepseek-ai/dsh-app-boot 加载 js-yaml
  try {
    const bootPkg = require.resolve('@deepseek-ai/dsh-app-boot/package.json');
    const bootReq = createRequire(bootPkg);
    const jsYaml = bootReq('js-yaml');
    if (typeof jsYaml.load === 'function') {
      return jsYaml.load(content);
    }
  } catch {
    // ignore
  }

  // 2. 回退通过 @deepseek-ai/dsh-settings 加载 yaml
  try {
    const settingsPkg = require.resolve('@deepseek-ai/dsh-settings/package.json');
    const settingsReq = createRequire(settingsPkg);
    const yaml = settingsReq('yaml');
    if (typeof yaml.parse === 'function') {
      return yaml.parse(content);
    }
  } catch {
    // ignore
  }

  // 3. 兜底直接 require('js-yaml')
  try {
    const jsYaml = require('js-yaml');
    if (typeof jsYaml.load === 'function') {
      return jsYaml.load(content);
    }
  } catch {
    // ignore
  }

  return undefined;
}

/**
 * 探测并读取旧版配置文件中的 dsh-qqbot-bridge 配置字典。
 * 用于首次启动且 profile 配置尚未持久化时的内存兼容。
 */
export function readLegacyConfig(explicitHome?: string): PluginConfig | undefined {
  const dshHome = resolveDshHome(explicitHome);
  const candidateFiles = [
    path.join(dshHome, 'settings.yaml'),
    path.join(dshHome, 'settings.yaml.imported'),
  ];

  for (const file of candidateFiles) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes(SETTINGS_NAMESPACE)) {
          const doc = parseYaml(content);
          const legacyValues = doc?.[SETTINGS_NAMESPACE];
          if (legacyValues && typeof legacyValues === 'object' && Object.keys(legacyValues).length > 0) {
            return legacyValues as PluginConfig;
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

let migrationExecuted = false;

/**
 * 探测旧版配置文件并静默迁移 dsh-qqbot-bridge 配置到当前 profile。
 * 必须在应用 ready 或异步非阻塞状态下调用，避免死锁。
 */
export async function migrateLegacyConfig(ctx: Context, currentConfig: PluginConfig): Promise<void> {
  if (migrationExecuted) {
    return;
  }
  migrationExecuted = true;

  const logger = resolveLogger(ctx, PLUGIN_NAME);
  try {
    // a. 若当前配置 currentConfig 已有真实 app_id，视为已配置，直接跳过
    const rawAppId =
      typeof (currentConfig?.app_id as any)?.get === 'function'
        ? (currentConfig.app_id as any).get()
        : currentConfig?.app_id;

    if (rawAppId && String(rawAppId).trim() !== '') {
      return;
    }

    // b. 探测旧版配置
    const legacyValues = readLegacyConfig();
    if (!legacyValues) {
      return;
    }

    logger.info(`检测到旧版配置文件中的 ${SETTINGS_NAMESPACE} 配置，开始静默迁移至当前 profile...`);

    // d. 若解析出旧配置中的 app_id 等字段，通过 settingsService.update 写入当前 profile
    const applyToSettings = async (settingsService: any): Promise<boolean> => {
      const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Settings operation timed out')), ms);
        });
        try {
          return await Promise.race([promise, timeout]);
        } finally {
          clearTimeout(timer!);
        }
      };

      if (typeof settingsService?.update === 'function') {
        await withTimeout(settingsService.update(SETTINGS_NAMESPACE, legacyValues), 3000);
        return true;
      }
      if (typeof settingsService?.mutate === 'function') {
        const ops = Object.entries(legacyValues).map(([key, value]) => ({
          op: 'set' as const,
          path: [key],
          value,
        }));
        await withTimeout(settingsService.mutate(SETTINGS_NAMESPACE, ops), 3000);
        return true;
      }
      return false;
    };

    const directSettings = (ctx as any).get?.('settings');
    if (directSettings) {
      try {
        const migrated = await applyToSettings(directSettings);
        if (migrated) {
          logger.info(`旧版配置已成功静默迁移至当前 profile`);
          return;
        }
      } catch (err) {
        logger.warn('静默迁移写入 settings 异常（非致命）：', err);
      }
    }

    // 若 settings 尚未注入，异步等待 settings 服务准备就绪（最多等待 3 秒）
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      const dispose = ctx.inject(['settings'], async (subCtx) => {
        try {
          clearTimeout(timeout);
          if (typeof dispose === 'function') (dispose as any)();
          const s = (subCtx as any).settings;
          const migrated = await applyToSettings(s);
          if (migrated) {
            logger.info(`旧版配置已成功静默迁移至当前 profile (via settings inject)`);
          }
        } catch (e) {
          logger.info('静默迁移写入 settings 失败：', e);
        } finally {
          resolve();
        }
      });
    });
  } catch (err) {
    // e. 整个过程 try-catch 包裹，只记录 info 日志，失败不阻断应用启动
    logger.info('静默迁移检查跳过或未执行：', err);
  }
}
