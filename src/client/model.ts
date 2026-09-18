/**
 * dsh-qqbot-bridge Settings Card Form Model
 *
 * 管理设置表单状态、脏检查 (isDirty) 与版本冲突解决 (expectedRevision / SETTINGS_CONFLICT)。
 */

import type { PluginConfig } from '../types/index.js';

export class SettingsConflictError extends Error {
  public code = 'SETTINGS_CONFLICT';
  constructor(message = 'Settings revision conflict') {
    super(message);
    this.name = 'SettingsConflictError';
  }
}

export interface FormModelOptions {
  initialValues?: Partial<PluginConfig>;
  revision?: number;
  baseDefaults?: Partial<PluginConfig>;
}

export class QqbotFormModel {
  private initialValues: Partial<PluginConfig>;
  private draft: Partial<PluginConfig>;
  private revision: number;
  private baseDefaults: Partial<PluginConfig>;
  private resetFields: Set<keyof PluginConfig> = new Set();

  constructor(options: FormModelOptions = {}) {
    this.initialValues = { ...options.initialValues };
    this.draft = { ...options.initialValues };
    this.revision = options.revision ?? 0;
    this.baseDefaults = { ...options.baseDefaults };
  }

  setRevision(revision: number) {
    this.revision = revision;
  }

  getRevision(): number {
    return this.revision;
  }

  getDraft(): Partial<PluginConfig> {
    return this.draft;
  }

  getResetFields(): ReadonlySet<keyof PluginConfig> {
    return this.resetFields;
  }

  setField<K extends keyof PluginConfig>(key: K, value: PluginConfig[K]) {
    this.draft[key] = value;
    this.resetFields.delete(key);
  }

  resetField<K extends keyof PluginConfig>(key: K) {
    this.resetFields.add(key);
    if (this.baseDefaults[key] !== undefined) {
      this.draft[key] = this.baseDefaults[key];
    } else {
      delete this.draft[key];
    }
  }

  isOverridden<K extends keyof PluginConfig>(key: K): boolean {
    const draftVal = this.draft[key];
    const defaultVal = this.baseDefaults[key];
    if (draftVal === undefined && defaultVal === undefined) return false;
    return draftVal !== defaultVal;
  }

  isDirty(): boolean {
    if (this.resetFields.size > 0) return true;
    const keys = Array.from(
      new Set([...Object.keys(this.initialValues), ...Object.keys(this.draft)])
    ) as Array<keyof PluginConfig>;

    for (const key of keys) {
      const initVal = this.initialValues[key];
      const draftVal = this.draft[key];
      if (Array.isArray(initVal) || Array.isArray(draftVal)) {
        if (JSON.stringify(initVal || []) !== JSON.stringify(draftVal || [])) {
          return true;
        }
      } else if (initVal !== draftVal) {
        return true;
      }
    }
    return false;
  }

  discard() {
    this.draft = { ...this.initialValues };
    this.resetFields.clear();
  }

  async save(callbacks: {
    saveSettings: (
      values: Partial<PluginConfig>,
      options: { expectedRevision: number }
    ) => Promise<{ revision?: number } | void>;
  }): Promise<void> {
    const res = await callbacks.saveSettings(this.draft, {
      expectedRevision: this.revision,
    });
    if (res && typeof res.revision === 'number') {
      this.revision = res.revision;
    }
    this.initialValues = { ...this.draft };
    this.resetFields.clear();
  }
}