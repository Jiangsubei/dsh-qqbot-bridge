/**
 * dsh-qqbot-bridge Client WebUI Plugin Entry Point
 *
 * 客户端 WebUI 插件入口：向 DSH Settings 面板注册设置卡片与插槽绑定。
 */

import { QqbotSettingsCard } from './card.js';
import { SETTINGS_NAMESPACE } from '../constants/index.js';
import { t } from '../i18n/index.js';

export const name = 'dsh-qqbot-bridge/client';
export const inject = ['slots', 'settingsScope'];

const EMPTY_CONFIG: Record<string, unknown> = Object.freeze({});

/**
 * Build the card props bridge for one settings namespace.
 */
export function buildSettingsBridge(ctx: any, namespace: string = SETTINGS_NAMESPACE) {
  const describe = ctx.settingsScope?.describe?.() ?? null;
  const scope = ctx.settingsScope?.bind?.({ namespace }) ?? null;

  const readNamespace = () => {
    const view = describe?.getSnapshot?.().view;
    const row = view?.namespaces?.find((n: any) => n.ns === namespace);
    if (row) return row;
    const scopeSnap = scope?.getSnapshot?.();
    if (scopeSnap && scopeSnap.status !== 'unavailable') {
      return {
        value: scopeSnap.value ?? scopeSnap.user,
        revision: scopeSnap.revision,
        base: scopeSnap.base,
        secrets: scopeSnap.secrets,
      };
    }
    return undefined;
  };

  return {
    get initialConfig() {
      return readNamespace()?.value ?? EMPTY_CONFIG;
    },
    get revision() {
      return readNamespace()?.revision ?? 0;
    },
    get baseDefaults() {
      return readNamespace()?.base ?? EMPTY_CONFIG;
    },
    get hasSecret() {
      const row = readNamespace();
      return Array.isArray(row?.secrets) && row.secrets.length > 0;
    },
    onSaveSettings: async (
      values: Record<string, unknown>,
      options: { expectedRevision: number },
      resetFields?: ReadonlySet<string>
    ) => {
      const targetScope = scope ?? ctx.settingsScope?.bind?.({ namespace }) ?? ctx.settingsScope;
      if (!targetScope?.mutate) throw new Error(t('settings.errors.unavailable'));

      const resets = resetFields ?? new Set<string>();
      const ops = [
        ...Array.from(resets).map((field) => ({
          op: 'unset' as const,
          path: [field],
        })),
        ...Object.entries(values ?? {})
          .filter(([field]) => !resets.has(field))
          .map(([field, value]) => ({
            op: 'set' as const,
            path: [field],
            value,
          })),
      ];

      const latestRow = readNamespace();
      const expectedRevision =
        latestRow?.revision !== undefined ? latestRow.revision : options.expectedRevision;

      let res: any;
      try {
        res = await targetScope.mutate(ops, expectedRevision);
      } catch (err: any) {
        const errMsg = String(err?.message || '');
        if (
          errMsg.includes('changed since it was read') ||
          errMsg.includes('SETTINGS_CONFLICT') ||
          errMsg.includes('expected revision') ||
          errMsg.includes('conflict') ||
          err?.code === 'SETTINGS_CONFLICT'
        ) {
          const freshRow = readNamespace();
          const freshRev = freshRow?.revision ?? targetScope.getSnapshot?.().revision;
          if (freshRev !== undefined && freshRev !== expectedRevision) {
            res = await targetScope.mutate(ops, freshRev);
            if (res && typeof res === 'object') {
              const retryOk = res.ok ?? res.result?.ok;
              if (retryOk === false) {
                const retryErr = res.error || res.result?.error;
                throw new Error(retryErr?.message || t('settings.errors.rejected'));
              }
              return {
                revision:
                  res.value?.revision ?? res.result?.value?.revision ?? readNamespace()?.revision,
              };
            }
            const afterRetryRow = readNamespace();
            return { revision: afterRetryRow?.revision ?? targetScope.getSnapshot?.().revision };
          }
        }
        throw err;
      }

      // 1. If res returned an object (e.g. mock or RPC response)
      if (res && typeof res === 'object') {
        const isOk = res.ok ?? res.result?.ok;
        if (isOk === false) {
          const errMsg = String(res.error?.message || res.result?.error?.message || '');
          const isConflict =
            errMsg.includes('changed since it was read') ||
            errMsg.includes('SETTINGS_CONFLICT') ||
            errMsg.includes('expected revision') ||
            errMsg.includes('conflict') ||
            res.error?.code === 'SETTINGS_CONFLICT' ||
            res.result?.error?.code === 'SETTINGS_CONFLICT';

          if (isConflict || res.ok === false) {
            const freshRow = readNamespace();
            const freshRev = freshRow?.revision ?? targetScope.getSnapshot?.().revision;
            if (freshRev !== undefined && freshRev !== expectedRevision) {
              res = await targetScope.mutate(ops, freshRev);
            }
          }
        }

        const finalOk = res.ok ?? res.result?.ok;
        if (finalOk === false) {
          const err = res.error || res.result?.error;
          throw new Error(err?.message || t('settings.errors.rejected'));
        }

        const finalRev =
          res.value?.revision ?? res.result?.value?.revision ?? readNamespace()?.revision;
        return { revision: finalRev };
      }

      // 2. If res is undefined (official SettingsScopeController returns void)
      const afterRow = readNamespace();
      const afterRevision = afterRow?.revision ?? targetScope.getSnapshot?.().revision;

      if (afterRevision !== undefined && afterRevision > expectedRevision) {
        return { revision: afterRevision };
      }

      // Check if values landed
      const currentValues = afterRow?.value ?? targetScope.getSnapshot?.().value;
      const valuesLanded = Object.entries(values ?? {}).every(([k, v]) => {
        return JSON.stringify(currentValues?.[k]) === JSON.stringify(v);
      });

      if (valuesLanded) {
        return { revision: afterRevision };
      }

      // Values didn't land -> check if recover() reloaded a fresher revision
      if (afterRevision !== undefined && afterRevision !== expectedRevision) {
        const retryRes = await targetScope.mutate(ops, afterRevision);
        if (retryRes && typeof retryRes === 'object') {
          if (retryRes.ok ?? retryRes.result?.ok) {
            return {
              revision:
                retryRes.value?.revision ??
                retryRes.result?.value?.revision ??
                readNamespace()?.revision,
            };
          }
          throw new Error(
            retryRes.error?.message ||
              retryRes.result?.error?.message ||
              t('settings.errors.rejected')
          );
        }
        const retryRow = readNamespace();
        const retryRev = retryRow?.revision ?? targetScope.getSnapshot?.().revision;
        const retryValues = retryRow?.value ?? targetScope.getSnapshot?.().value;
        const retryLanded = Object.entries(values ?? {}).every(([k, v]) => {
          return JSON.stringify(retryValues?.[k]) === JSON.stringify(v);
        });
        if (retryLanded || (retryRev !== undefined && retryRev > afterRevision)) {
          return { revision: retryRev };
        }
      }

      throw new Error(t('settings.errors.conflict'));
    },
  };
}

export function apply(ctx: any) {
  if (!ctx?.slots?.inject) return;

  // 注册本插件设置卡片（key = 插件 id）
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'dsh-qqbot-bridge',
        inject: () => buildSettingsBridge(ctx, SETTINGS_NAMESPACE),
      },
      QqbotSettingsCard
    );
  });
}

export { QqbotSettingsCard };