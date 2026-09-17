/**
 * dsh-qqbot-bridge Settings Card Styles — visual language aligned with official
 * DSH plugin cards (`dsh-client-ui-settings-plugins` PluginCard / fields).
 *
 * Token surface: `var(--dsw-alias-*)` (official DSH design system tokens).
 */

export const QQBOT_CARD_CSS_ID = 'dsh-qqbot-bridge/card.module.css';

const QQBOT_CARD_CSS = `
.qqbot_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;margin:0;transition:border-color .16s,background .16s}
.qqbot_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.qqbot_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.qqbot_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.qqbot_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.qqbot_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.qqbot_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0}
.qqbot_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.qqbot_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.qqbot_chevronOpen{transform:rotate(180deg)}
.qqbot_badgePending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.qqbot_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.qqbot_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.qqbot_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.qqbot_discard,.qqbot_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.qqbot_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.qqbot_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.qqbot_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.qqbot_discard:disabled,.qqbot_save:disabled{opacity:.4;cursor:default}
.qqbot_discard:focus-visible,.qqbot_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.qqbot_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.qqbot_field+.qqbot_field{border-top:1px solid var(--dsw-alias-border-l2)}
.qqbot_switchRow{flex-direction:row;align-items:center;justify-content:space-between;gap:8px}
.qqbot_fieldHead{align-items:center;gap:8px;display:flex}
.qqbot_fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.qqbot_fieldBadges{align-items:center;gap:8px;display:inline-flex}
.qqbot_fieldBadge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.qqbot_fieldBadgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.qqbot_fieldReset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.qqbot_fieldReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.qqbot_fieldReset:disabled{cursor:default}
.qqbot_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.qqbot_textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:72px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.5;resize:vertical}
.qqbot_input:focus-visible,.qqbot_textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.qqbot_input:disabled,.qqbot_textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.qqbot_inputInvalid{border-color:var(--dsw-alias-label-error)}
.qqbot_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.qqbot_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.qqbot_checkbox{accent-color:var(--dsw-alias-brand-primary);width:18px;height:18px;cursor:pointer;flex:none}
.qqbot_checkbox:disabled{cursor:default;opacity:.4}
.qqbot_tabBar{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 0 0;margin:0;overflow-x:auto}
.qqbot_tab{appearance:none;background:0 0;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:1.5;padding:6px 12px 8px;cursor:pointer;border-radius:6px 6px 0 0;transition:color .16s,border-color .16s;white-space:nowrap}
.qqbot_tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.qqbot_tabActive{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary)}
.qqbot_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.qqbot_tabPanel{display:flex;flex-direction:column}
.qqbot_tabPanelHidden{display:none !important}
`;

export function injectCardStyles(): void {
  if (typeof document === 'undefined') return;
  const selector = `style[data-plugin-css=${JSON.stringify(QQBOT_CARD_CSS_ID)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.pluginCss = QQBOT_CARD_CSS_ID;
  tag.textContent = QQBOT_CARD_CSS;
  document.head.appendChild(tag);
}

export const cardStyle = {
  card: 'qqbot_card',
  cardOpen: 'qqbot_cardOpen',
  header: 'qqbot_header',
  headText: 'qqbot_headText',
  name: 'qqbot_name',
  description: 'qqbot_description',
  chevron: 'qqbot_chevron',
  chevronOpen: 'qqbot_chevronOpen',
  badgePending: 'qqbot_badgePending',
  body: 'qqbot_body',
  tabBar: 'qqbot_tabBar',
  tab: 'qqbot_tab',
  tabActive: 'qqbot_tabActive',
  tabPanel: 'qqbot_tabPanel',
  tabPanelHidden: 'qqbot_tabPanelHidden',
  footer: 'qqbot_footer',
  failed: 'qqbot_failed',
  discard: 'qqbot_discard',
  save: 'qqbot_save',
};

export const fieldStyle = {
  field: 'qqbot_field',
  head: 'qqbot_fieldHead',
  label: 'qqbot_fieldLabel',
  badges: 'qqbot_fieldBadges',
  badge: 'qqbot_fieldBadge',
  badgeMuted: 'qqbot_fieldBadgeMuted',
  reset: 'qqbot_fieldReset',
  input: 'qqbot_input',
  textarea: 'qqbot_textarea',
  inputInvalid: 'qqbot_inputInvalid',
  invalid: 'qqbot_invalid',
  hint: 'qqbot_hint',
  checkbox: 'qqbot_checkbox',
};