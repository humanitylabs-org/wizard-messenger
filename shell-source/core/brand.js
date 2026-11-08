/* Supplied designer hat only. Explicit brand slots, never a global star/sigil replacement. */
(() => {
  'use strict';
  const html = '<img class="wizard-brand-mark" src="/wizard-os-home/brand/wizard-mark-white.png" alt="" aria-hidden="true">';
  const icon = value => value === '✦' ? html : String(value || '');
  const paint = (el, value) => { if (el) { if (value === '✦') el.innerHTML = html; else el.textContent = value || ''; } };
  window.WizBrand = Object.freeze({ html, icon, paint });
})();
