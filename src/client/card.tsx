/**
 * dsh-qqbot-bridge Settings Card
 *
 * DSH WebUI 设置卡片组件：
 * 支持连接凭据、流式传输、多媒体存储及命令参数的可视化表单配置与热生效。
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as DshPrimitives from '@deepseek-ai/dsh-client-ui-primitives';
import { QqbotFormModel, SettingsConflictError } from './model.js';

function resolveChevronDownIcon(): React.ComponentType<{ className?: string }> {
  try {
    const P = DshPrimitives as any;
    if (typeof P?.IconChevronDownOutlineMedium === 'function') return P.IconChevronDownOutlineMedium;
    if (typeof P?.IconChevronDownOutlineRegular === 'function') return P.IconChevronDownOutlineRegular;
    if (typeof P?.IconChevronDownOutline14 === 'function') return P.IconChevronDownOutline14;
  } catch {
    // ignore
  }
  return () => null;
}

const SafeIconChevronDown: React.ComponentType<{ className?: string }> = resolveChevronDownIcon();
import { ValueField, SwitchField } from './fields.js';
import { cardStyle, sectionStyle, injectCardStyles } from './card-styles.js';
import type { PluginConfig } from '../types/index.js';
import {
  DEFAULT_BASE_CONFIG,
  LIST_PAGE_SIZE,
  QQ_MEDIA_DEFAULT_DIR,
  QQ_MEDIA_HARD_LIMIT,
  QQ_STREAM_THROTTLE_MS,
  REPLY_MAX_CHARS,
} from '../constants/index.js';
import { t, zhCN } from '../i18n/index.js';

export { DEFAULT_BASE_CONFIG };

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
  layoutMode?: 'card' | 'section';
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

export function QqbotSettingsCard(props: CardProps): React.JSX.Element {
  injectCardStyles();
  const isSection = props.layoutMode === 'section';
  const [expandedState, setExpandedState] = useState(props.initialExpanded ?? false);
  const expanded = isSection ? true : expandedState;
  const setExpanded = useCallback(
    (exp: boolean) => {
      if (!isSection) setExpandedState(exp);
    },
    [isSection]
  );
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

  const isExternalControlled = Boolean(
    (props.initialConfig && Object.keys(props.initialConfig).length > 0) ||
      props.onSaveSettings
  );

  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteLoadError, setRemoteLoadError] = useState<string | null>(null);
  const [remoteHasSecret, setRemoteHasSecret] = useState(false);

  const loadRemoteConfig = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteLoadError(null);
    try {
      const res = await fetch('/plugins/dsh-qqbot-bridge/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.ok) {
        if (data.config) {
          model.setInitialValues(data.config);
        }
        if (data.baseDefaults) {
          model.setBaseDefaults(data.baseDefaults);
        }
        setRemoteHasSecret(Boolean(data.hasSecret));
        setRemoteLoaded(true);
        forceUpdate();
      } else {
        throw new Error(data?.error || 'Failed to load configuration');
      }
    } catch (err: any) {
      console.warn('[dsh-qqbot-bridge] Failed to fetch remote config:', err);
      setRemoteLoadError(err?.message || '加载配置失败');
    } finally {
      setRemoteLoading(false);
    }
  }, [model, forceUpdate]);

  useEffect(() => {
    if (!isExternalControlled && !remoteLoaded) {
      void loadRemoteConfig();
    }
  }, [isExternalControlled, remoteLoaded, loadRemoteConfig]);

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

  const draft = model.getDraft();
  const isDirty = model.isDirty();
  const isSecretConfigured = Boolean(
    props.hasSecret ||
      remoteHasSecret ||
      (draft.app_secret && draft.app_secret.length > 0) ||
      model.isOverridden('app_secret')
  );
  const secretPlaceholder = isSecretConfigured
    ? F.appSecret.configuredPlaceholder
    : F.appSecret.placeholder;

  const handleSave = async () => {
    savingRef.current = true;
    setSaving(true);
    updateError(null);

    try {
      await model.save({
        saveSettings: async (values, options) => {
          const cleanValues = { ...values };
          if (
            isSecretConfigured &&
            (!cleanValues.app_secret || cleanValues.app_secret === '') &&
            !model.getResetFields().has('app_secret')
          ) {
            delete cleanValues.app_secret;
          }

          if (props.onSaveSettings) {
            return props.onSaveSettings(cleanValues, options, model.getResetFields());
          }

          // 自驱动 REST 保存
          const res = await fetch('/plugins/dsh-qqbot-bridge/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(cleanValues),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            throw new Error(data?.error || `HTTP ${res.status}`);
          }
          if (data.hasSecret !== undefined) {
            setRemoteHasSecret(Boolean(data.hasSecret));
          }
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

  const formContent = (
    <>
      {remoteLoading && !remoteLoaded && (
        <div style={{ padding: '8px 12px', marginBottom: '12px', color: '#888', fontSize: '13px' }}>
          正在从服务端加载配置...
        </div>
      )}
      {remoteLoadError && !remoteLoaded && (
        <div style={{ padding: '10px 14px', marginBottom: '12px', background: 'rgba(255, 107, 107, 0.1)', border: '1px solid rgba(255, 107, 107, 0.3)', borderRadius: '6px', color: '#ff6b6b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>加载配置失败: {remoteLoadError}</span>
          <button type="button" onClick={() => void loadRemoteConfig()} style={{ background: 'transparent', border: '1px solid #ff6b6b', color: '#ff6b6b', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>重试</button>
        </div>
      )}
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
              placeholder={secretPlaceholder}
              type="password"
              value={draft.app_secret || ''}
              disabled={saving}
              overridden={isSecretConfigured}
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
    </>
  );

  if (isSection) {
    return (
      <div className={sectionStyle.section} data-testid="qqbot-bridge-section">
        <div className={sectionStyle.head}>
          <div className={sectionStyle.titleRow}>
            <h2 className={sectionStyle.title}>{t('settings.section.title')}</h2>
            {isDirty && <span className={sectionStyle.badgePending}>{t('settings.card.dirty')}</span>}
          </div>
          <p className={sectionStyle.description}>{t('settings.section.description')}</p>
        </div>

        <div className={sectionStyle.body}>
          {formContent}
        </div>
      </div>
    );
  }

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
        <SafeIconChevronDown
          className={[cardStyle.chevron, expanded ? cardStyle.chevronOpen : '']
            .filter(Boolean)
            .join(' ')}
        />
      </button>

      {expanded && (
        <div className={cardStyle.body}>
          {formContent}
        </div>
      )}
    </div>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class SectionErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[dsh-qqbot-bridge] Section render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '24px', color: '#ff6b6b' }}>
          <h3>QQ 机器人设置加载异常</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>
            {this.state.error?.stack || this.state.error?.message || String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export function QqbotSettingsSection(props: CardProps): React.JSX.Element {
  return (
    <SectionErrorBoundary>
      <QqbotSettingsCard {...props} layoutMode="section" initialExpanded={true} />
    </SectionErrorBoundary>
  );
}