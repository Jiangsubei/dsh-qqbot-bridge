/**
 * dsh-qqbot-bridge Settings Card
 *
 * DSH WebUI 设置卡片组件：
 * 支持连接凭据、流式传输、多媒体存储及命令参数的可视化表单配置与热生效。
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import { QqbotFormModel, SettingsConflictError } from './model.js';
import { ValueField, SwitchField } from './fields.js';
import { cardStyle, injectCardStyles } from './card-styles.js';
import type { PluginConfig } from '../types/index.js';
import {
  LIST_PAGE_SIZE,
  QQ_MEDIA_DEFAULT_DIR,
  QQ_MEDIA_HARD_LIMIT,
  QQ_STREAM_THROTTLE_MS,
  REPLY_MAX_CHARS,
} from '../constants/index.js';
import { t, zhCN } from '../i18n/index.js';

export type SettingsTabId = 'connection' | 'behavior' | 'files' | 'commands';

export interface TabItem {
  id: SettingsTabId;
  label: string;
}

export const SETTINGS_TABS: readonly TabItem[] = [
  { id: 'connection', label: zhCN.settings.tabs.connection },
  { id: 'behavior', label: zhCN.settings.tabs.behavior },
  { id: 'files', label: zhCN.settings.tabs.files },
  { id: 'commands', label: zhCN.settings.tabs.commands },
] as const;

/** 设置卡片字段文案（集中表；标签只留中文通用术语，占位符只留纯格式提示） */
const F = zhCN.settings.fields;

export interface CardController {
  activeTab: SettingsTabId;
  setActiveTab: (tab: SettingsTabId) => void;
  model: QqbotFormModel;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  isDirty: boolean;
  saving: boolean;
  errorMessage: string | null;
  handleFieldChange: (key: keyof PluginConfig, val: any) => void;
  handleResetField: (key: keyof PluginConfig) => void;
  handleDiscard: () => void;
  handleSave: () => Promise<void>;
}

export interface CardProps {
  initialConfig?: Partial<PluginConfig>;
  hasSecret?: boolean;
  revision?: number;
  baseDefaults?: Partial<PluginConfig>;
  initialExpanded?: boolean;
  initialTab?: SettingsTabId;
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
  controllerRef?:
    | React.MutableRefObject<CardController | null>
    | ((controller: CardController) => void);
  onSaveSettings?: (
    values: Partial<PluginConfig>,
    options: { expectedRevision: number },
    resetFields?: ReadonlySet<string>
  ) => Promise<{ revision?: number } | void>;
}

/**
 * 与 `src/config/schema.ts` 的 `.default(...)` 一一对齐（**不得**在此另立默认值）。
 *
 * D51 修正：`media_dir` 基线原先硬编码 `.dsh/qqbot/media`，与 schema 默认（相对 DSH_HOME 的
 * `qqbot/media`）不一致 ⇒ 卡片未设置时显示的值、以及「重置」写回的值都不是插件真实落点。
 * 现统一引用 `QQ_MEDIA_DEFAULT_DIR`；本对象同时**导出**，由契约测试逐字段与 schema 解析出的
 * 默认值比对（`client-settings.test.ts`），防止同类漂移再次发生。
 */
export const DEFAULT_BASE_CONFIG: Partial<PluginConfig> = {
  app_id: '',
  app_secret: '',
  default_workspace: '',
  stream_enabled: true,
  stream_throttle_ms: QQ_STREAM_THROTTLE_MS,
  allow_create_session: true,
  media_dir: QQ_MEDIA_DEFAULT_DIR,
  media_max_bytes: QQ_MEDIA_HARD_LIMIT,
  reply_max_chars: REPLY_MAX_CHARS,
  list_page_size: LIST_PAGE_SIZE,
  status_show_usage: true,
};

export function QqbotSettingsCard(props: CardProps): React.JSX.Element {
  injectCardStyles();
  const [expanded, setExpanded] = useState(props.initialExpanded ?? false);
  const [activeTabState, setActiveTabState] = useState<SettingsTabId>(
    props.initialTab ?? 'connection'
  );
  const activeTab = props.activeTab ?? activeTabState;
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setRerenderKey] = useState(0);

  const activeTabRef = useRef<SettingsTabId>(activeTab);
  activeTabRef.current = activeTab;

  const errRef = useRef<string | null>(errorMessage);
  errRef.current = errorMessage;

  const savingRef = useRef<boolean>(saving);
  savingRef.current = saving;

  const expandedRef = useRef<boolean>(expanded);
  expandedRef.current = expanded;

  const updateError = (msg: string | null) => {
    errRef.current = msg;
    setErrorMessage(msg);
  };

  const model = useMemo(() => {
    return new QqbotFormModel({
      initialValues: props.initialConfig || {},
      revision: props.revision ?? 0,
      baseDefaults: props.baseDefaults || DEFAULT_BASE_CONFIG,
    });
  }, [props.initialConfig, props.baseDefaults]);

  useEffect(() => {
    if (props.revision !== undefined) {
      model.setRevision(props.revision);
    }
  }, [props.revision, model]);

  const forceUpdate = useCallback(() => {
    setRerenderKey((k) => k + 1);
  }, []);

  const handleTabClick = (tabId: SettingsTabId) => {
    activeTabRef.current = tabId;
    setActiveTabState(tabId);
    props.onTabChange?.(tabId);
    forceUpdate();
  };

  const handleFieldChange = (key: keyof PluginConfig, val: any) => {
    model.setField(key, val);
    updateError(null);
    forceUpdate();
  };

  const handleResetField = (key: keyof PluginConfig) => {
    model.resetField(key);
    forceUpdate();
  };

  const handleDiscard = () => {
    model.discard();
    updateError(null);
    forceUpdate();
  };

  const handleSave = async () => {
    if (!props.onSaveSettings) return;
    savingRef.current = true;
    setSaving(true);
    updateError(null);

    try {
      await model.save({
        saveSettings: (values, options) => {
          if (!props.onSaveSettings) return Promise.resolve();
          return props.onSaveSettings(values, options, model.getResetFields());
        },
      });
      forceUpdate();
    } catch (err: any) {
      if (err instanceof SettingsConflictError || err?.code === 'SETTINGS_CONFLICT') {
        updateError(t('settings.card.saveConflict'));
      } else {
        updateError(err?.message || t('settings.card.saveFailed'));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const draft = model.getDraft();
  const isDirty = model.isDirty();
  const blocked = !isDirty || saving;

  const controller: CardController = {
    get activeTab() {
      return activeTabRef.current;
    },
    setActiveTab: handleTabClick,
    model,
    get expanded() {
      return expandedRef.current;
    },
    setExpanded: (exp: boolean) => {
      expandedRef.current = exp;
      setExpanded(exp);
    },
    get isDirty() {
      return model.isDirty();
    },
    get saving() {
      return savingRef.current;
    },
    get errorMessage() {
      return errRef.current;
    },
    handleFieldChange,
    handleResetField,
    handleDiscard,
    handleSave,
  };

  if (props.controllerRef) {
    if (typeof props.controllerRef === 'function') {
      props.controllerRef(controller);
    } else {
      props.controllerRef.current = controller;
    }
  }

  const tabPanelClass = (tab: SettingsTabId) =>
    [cardStyle.tabPanel, activeTab !== tab ? cardStyle.tabPanelHidden : '']
      .filter(Boolean)
      .join(' ');

  const tabPanelStyle = (tab: SettingsTabId) =>
    activeTab !== tab ? { display: 'none' } : undefined;

  return (
    <div
      className={[cardStyle.card, expanded ? cardStyle.cardOpen : ''].filter(Boolean).join(' ')}
      data-testid="qqbot-bridge-card"
    >
      <button
        type="button"
        className={cardStyle.header}
        aria-expanded={expanded}
        aria-label={`${expanded ? t('settings.card.collapse') : t('settings.card.expand')}: ${zhCN.plugin.name}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={cardStyle.headText}>
          <span className={cardStyle.name}>{zhCN.plugin.name}</span>
          <span className={cardStyle.description}>{zhCN.plugin.description}</span>
        </span>
        {isDirty && <span className={cardStyle.badgePending}>{t('settings.card.dirty')}</span>}
        <IconChevronDownOutline14
          className={[cardStyle.chevron, expanded ? cardStyle.chevronOpen : '']
            .filter(Boolean)
            .join(' ')}
        />
      </button>

      {expanded && (
        <div className={cardStyle.body}>
          <div className={cardStyle.tabBar} role="tablist" aria-label={t('settings.card.tabsLabel')}>
            {SETTINGS_TABS.map((tab) => {
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`qqbot-tab-${tab.id}`}
                  data-testid={`qqbot-tab-${tab.id}`}
                  aria-selected={isSelected}
                  aria-controls={`qqbot-tabpanel-${tab.id}`}
                  tabIndex={isSelected ? 0 : -1}
                  className={[cardStyle.tab, isSelected ? cardStyle.tabActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => handleTabClick(tab.id)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div
            id="qqbot-tabpanel-connection"
            data-testid="qqbot-tabpanel-connection"
            role="tabpanel"
            aria-labelledby="qqbot-tab-connection"
            hidden={activeTab !== 'connection'}
            className={tabPanelClass('connection')}
            style={tabPanelStyle('connection')}
          >
            <ValueField
              id="qqbot-app-id"
              label={F.appId.label}
              hint={F.appId.hint}
              placeholder={F.appId.placeholder}
              value={draft.app_id || ''}
              disabled={saving}
              overridden={model.isOverridden('app_id')}
              onReset={() => handleResetField('app_id')}
              onChange={(val) => handleFieldChange('app_id', val)}
            />

            <ValueField
              id="qqbot-app-secret"
              label={F.appSecret.label}
              hint={F.appSecret.hint}
              type="password"
              value={draft.app_secret || ''}
              disabled={saving}
              overridden={model.isOverridden('app_secret')}
              onReset={() => handleResetField('app_secret')}
              onChange={(val) => handleFieldChange('app_secret', val)}
            />

            <ValueField
              id="qqbot-default-workspace"
              label={F.defaultWorkspace.label}
              hint={F.defaultWorkspace.hint}
              placeholder={F.defaultWorkspace.placeholder}
              value={draft.default_workspace || ''}
              disabled={saving}
              overridden={model.isOverridden('default_workspace')}
              onReset={() => handleResetField('default_workspace')}
              onChange={(val) => handleFieldChange('default_workspace', val)}
            />
          </div>

          <div
            id="qqbot-tabpanel-behavior"
            data-testid="qqbot-tabpanel-behavior"
            role="tabpanel"
            aria-labelledby="qqbot-tab-behavior"
            hidden={activeTab !== 'behavior'}
            className={tabPanelClass('behavior')}
            style={tabPanelStyle('behavior')}
          >
            <SwitchField
              id="qqbot-stream-enabled"
              label={F.streamEnabled.label}
              hint={F.streamEnabled.hint}
              checked={draft.stream_enabled ?? true}
              disabled={saving}
              overridden={model.isOverridden('stream_enabled')}
              onReset={() => handleResetField('stream_enabled')}
              onChange={(checked) => handleFieldChange('stream_enabled', checked)}
            />

            <ValueField
              id="qqbot-stream-throttle-ms"
              label={F.streamThrottleMs.label}
              hint={F.streamThrottleMs.hint}
              placeholder={F.streamThrottleMs.placeholder}
              numeric
              value={String(draft.stream_throttle_ms ?? QQ_STREAM_THROTTLE_MS)}
              disabled={saving || !(draft.stream_enabled ?? true)}
              overridden={model.isOverridden('stream_throttle_ms')}
              onReset={() => handleResetField('stream_throttle_ms')}
              onChange={(val) => {
                const parsed = parseInt(val, 10);
                handleFieldChange(
                  'stream_throttle_ms',
                  Number.isNaN(parsed) ? QQ_STREAM_THROTTLE_MS : parsed
                );
              }}
            />

            <SwitchField
              id="qqbot-allow-create-session"
              label={F.allowCreateSession.label}
              hint={F.allowCreateSession.hint}
              checked={draft.allow_create_session ?? true}
              disabled={saving}
              overridden={model.isOverridden('allow_create_session')}
              onReset={() => handleResetField('allow_create_session')}
              onChange={(checked) => handleFieldChange('allow_create_session', checked)}
            />
          </div>

          <div
            id="qqbot-tabpanel-files"
            data-testid="qqbot-tabpanel-files"
            role="tabpanel"
            aria-labelledby="qqbot-tab-files"
            hidden={activeTab !== 'files'}
            className={tabPanelClass('files')}
            style={tabPanelStyle('files')}
          >
            <ValueField
              id="qqbot-media-dir"
              label={F.mediaDir.label}
              hint={F.mediaDir.hint}
              placeholder={F.mediaDir.placeholder}
              value={draft.media_dir || QQ_MEDIA_DEFAULT_DIR}
              disabled={saving}
              overridden={model.isOverridden('media_dir')}
              onReset={() => handleResetField('media_dir')}
              onChange={(val) => handleFieldChange('media_dir', val)}
            />

            <ValueField
              id="qqbot-media-max-bytes"
              label={F.mediaMaxBytes.label}
              hint={F.mediaMaxBytes.hint}
              placeholder={F.mediaMaxBytes.placeholder}
              numeric
              value={String(draft.media_max_bytes ?? QQ_MEDIA_HARD_LIMIT)}
              disabled={saving}
              overridden={model.isOverridden('media_max_bytes')}
              onReset={() => handleResetField('media_max_bytes')}
              onChange={(val) => {
                const parsed = parseInt(val, 10);
                handleFieldChange(
                  'media_max_bytes',
                  Number.isNaN(parsed) ? QQ_MEDIA_HARD_LIMIT : parsed
                );
              }}
            />
          </div>

          <div
            id="qqbot-tabpanel-commands"
            data-testid="qqbot-tabpanel-commands"
            role="tabpanel"
            aria-labelledby="qqbot-tab-commands"
            hidden={activeTab !== 'commands'}
            className={tabPanelClass('commands')}
            style={tabPanelStyle('commands')}
          >
            <ValueField
              id="qqbot-reply-max-chars"
              label={F.replyMaxChars.label}
              hint={F.replyMaxChars.hint}
              placeholder={F.replyMaxChars.placeholder}
              numeric
              value={String(draft.reply_max_chars ?? REPLY_MAX_CHARS)}
              disabled={saving}
              overridden={model.isOverridden('reply_max_chars')}
              onReset={() => handleResetField('reply_max_chars')}
              onChange={(val) => {
                const parsed = parseInt(val, 10);
                handleFieldChange(
                  'reply_max_chars',
                  Number.isNaN(parsed) ? REPLY_MAX_CHARS : parsed
                );
              }}
            />

            <ValueField
              id="qqbot-list-page-size"
              label={F.listPageSize.label}
              hint={F.listPageSize.hint}
              placeholder={F.listPageSize.placeholder}
              numeric
              value={String(draft.list_page_size ?? LIST_PAGE_SIZE)}
              disabled={saving}
              overridden={model.isOverridden('list_page_size')}
              onReset={() => handleResetField('list_page_size')}
              onChange={(val) => {
                const parsed = parseInt(val, 10);
                handleFieldChange(
                  'list_page_size',
                  Number.isNaN(parsed) ? LIST_PAGE_SIZE : parsed
                );
              }}
            />

            <SwitchField
              id="qqbot-status-show-usage"
              label={F.statusShowUsage.label}
              hint={F.statusShowUsage.hint}
              checked={draft.status_show_usage ?? true}
              disabled={saving}
              overridden={model.isOverridden('status_show_usage')}
              onReset={() => handleResetField('status_show_usage')}
              onChange={(checked) => handleFieldChange('status_show_usage', checked)}
            />
          </div>

          <div className={cardStyle.footer}>
            {errorMessage && (
              <p className={cardStyle.failed} role="alert">
                {errorMessage}
              </p>
            )}
            <button
              type="button"
              className={cardStyle.discard}
              disabled={blocked}
              onClick={handleDiscard}
            >
              {t('settings.card.discard')}
            </button>
            <button
              type="button"
              className={cardStyle.save}
              disabled={blocked}
              onClick={handleSave}
            >
              {saving ? t('settings.card.saving') : t('settings.card.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}