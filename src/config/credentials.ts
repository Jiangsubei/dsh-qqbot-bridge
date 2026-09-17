/**
 * dsh-qqbot-bridge: 凭据安全解析
 *
 * 按照安全性分级依次解析 QQ Bot 的 AppID 与 AppSecret：
 * 1. 进程环境变量（QQ_BOT_APP_ID / QQ_BOT_SECRET）；
 * 2. `$DSH_HOME/.credentials.yaml` 的 refs 引用；
 * 3. 插件配置项（显式配置优先，缺省回退）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CRED_APP_ID, CRED_SECRET } from '../constants/index.js';
import type { PluginConfig, QqCredential } from '../types/index.js';

/**
 * 从 `.credentials.yaml` 的 `refs:` 块读取键值。
 * 只做最小 YAML 解析（仅 refs 块内的 `KEY: value`），**不引入 yaml 依赖**——
 * 与探针 `scripts/lib/qq-probe-client.ts` 的实现保持一致，便于对拍。
 */
export function readCredentialRefs(dshHome: string): Record<string, string> {
  const file = path.join(dshHome, '.credentials.yaml');
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  let inRefs = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^[a-zA-Z@]/.test(line)) break; // 出了 refs 块
    if (!inRefs) continue;
    const m = /^\s{2}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function resolveDshHome(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.resolve(os.homedir(), '.dsh');
}

/**
 * 解析 QQ 凭据。任一项缺失都返回 `undefined`（由调用方决定是"离线待机"还是报错），
 * 并给出**缺失原因**便于设置卡诊断展示。
 */
export function resolveCredentials(
  config: PluginConfig,
  options: { dshHome?: string; env?: NodeJS.ProcessEnv } = {}
): { credential?: QqCredential; reason?: string } {
  const env = options.env ?? process.env;
  const dshHome = resolveDshHome(options.dshHome);
  const refs = readCredentialRefs(dshHome);

  const appId = env[CRED_APP_ID] || refs[CRED_APP_ID] || config.app_id || '';
  const appSecret = env[CRED_SECRET] || refs[CRED_SECRET] || config.app_secret || '';

  if (!appId) return { reason: `缺少 AppID：环境变量 ${CRED_APP_ID} / ${path.join(dshHome, '.credentials.yaml')} 的 refs.${CRED_APP_ID} / 配置 app_id 均未提供` };
  if (!appSecret) return { reason: `缺少 AppSecret：环境变量 ${CRED_SECRET} / ${path.join(dshHome, '.credentials.yaml')} 的 refs.${CRED_SECRET} / 配置 app_secret 均未提供` };
  return { credential: { appId, appSecret } };
}