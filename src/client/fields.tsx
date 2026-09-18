/**
 * dsh-qqbot-bridge Settings Card Field Primitives
 *
 * 设置面板基础表单控件（文本输入、开关、数字输入与状态指示器）。
 */

import React from 'react';
import { fieldStyle } from './card-styles.js';
import { t } from '../i18n/index.js';

export interface ValueFieldProps {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  disabled?: boolean;
  numeric?: boolean;
  type?: 'text' | 'password' | 'number';
  overridden?: boolean;
  onReset?: () => void;
  onChange: (value: string) => void;
}

export function ValueField(props: ValueFieldProps): React.JSX.Element {
  return (
    <div className={fieldStyle.field}>
      <div className={fieldStyle.head}>
        <label htmlFor={props.id} className={fieldStyle.label}>
          {props.label}
        </label>
        <div className={fieldStyle.badges}>
          {props.overridden && (
            <>
              <span className={fieldStyle.badge}>{t('settings.card.overridden')}</span>
              {props.onReset && (
                <button
                  type="button"
                  className={fieldStyle.reset}
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  {t('settings.card.reset')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <input
        id={props.id}
        type={props.type || (props.numeric ? 'number' : 'text')}
        className={fieldStyle.input}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <p className={fieldStyle.hint}>{props.hint}</p>}
    </div>
  );
}

export interface TextAreaFieldProps {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  disabled?: boolean;
  overridden?: boolean;
  onReset?: () => void;
  onChange: (value: string) => void;
}

export function TextAreaField(props: TextAreaFieldProps): React.JSX.Element {
  return (
    <div className={fieldStyle.field}>
      <div className={fieldStyle.head}>
        <label htmlFor={props.id} className={fieldStyle.label}>
          {props.label}
        </label>
        <div className={fieldStyle.badges}>
          {props.overridden && (
            <>
              <span className={fieldStyle.badge}>{t('settings.card.overridden')}</span>
              {props.onReset && (
                <button
                  type="button"
                  className={fieldStyle.reset}
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  {t('settings.card.reset')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <textarea
        id={props.id}
        className={fieldStyle.textarea}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <p className={fieldStyle.hint}>{props.hint}</p>}
    </div>
  );
}

export interface SwitchFieldProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  overridden?: boolean;
  onReset?: () => void;
  onChange: (checked: boolean) => void;
}

export function SwitchField(props: SwitchFieldProps): React.JSX.Element {
  return (
    <div className={[fieldStyle.field, 'qqbot_switchRow'].join(' ')}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={fieldStyle.head}>
          <label htmlFor={props.id} className={fieldStyle.label}>
            {props.label}
          </label>
          <div className={fieldStyle.badges}>
            {props.overridden && (
              <>
                <span className={fieldStyle.badge}>{t('settings.card.overridden')}</span>
                {props.onReset && (
                  <button
                    type="button"
                    className={fieldStyle.reset}
                    disabled={props.disabled}
                    onClick={props.onReset}
                  >
                    {t('settings.card.reset')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {props.hint && <p className={fieldStyle.hint}>{props.hint}</p>}
      </div>
      <input
        id={props.id}
        type="checkbox"
        className={fieldStyle.checkbox}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </div>
  );
}

export interface SelectFieldProps {
  id: string;
  label: string;
  hint?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  overridden?: boolean;
  onReset?: () => void;
  onChange: (value: string) => void;
}

export function SelectField(props: SelectFieldProps): React.JSX.Element {
  return (
    <div className={fieldStyle.field}>
      <div className={fieldStyle.head}>
        <label htmlFor={props.id} className={fieldStyle.label}>
          {props.label}
        </label>
        <div className={fieldStyle.badges}>
          {props.overridden && (
            <>
              <span className={fieldStyle.badge}>{t('settings.card.overridden')}</span>
              {props.onReset && (
                <button
                  type="button"
                  className={fieldStyle.reset}
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  {t('settings.card.reset')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <select
        id={props.id}
        className={fieldStyle.input}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {props.hint && <p className={fieldStyle.hint}>{props.hint}</p>}
    </div>
  );
}