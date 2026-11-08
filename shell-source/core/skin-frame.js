/* Declarative skin frame vocabulary. No CSS, URLs, selectors, scripts or app capabilities. */
(() => {
  'use strict';
  const foundations = Object.freeze({
    framed: Object.freeze({ foundation: 'framed' }),
    borderless: Object.freeze({ foundation: 'borderless', border: 0, radius: 0, gutter: 0, padding: 16, gap: 8 }),
  });
  const bounds = { border: [0, 2], radius: [0, 28], gutter: [0, 16], padding: [0, 32], gap: [4, 16] };
  const object = (o, field) => { if (!o || typeof o !== 'object' || Array.isArray(o) || ![Object.prototype, null].includes(Object.getPrototypeOf(o))) throw new Error(`${field}: expected an object`); };
  function frame(value = {}) {
    object(value, 'frame');
    for (const key of Object.keys(value)) if (key !== 'foundation' && !Object.hasOwn(bounds, key)) throw new Error(`frame.${key}: unknown field`);
    const foundation = value.foundation ?? 'framed';
    if (!Object.hasOwn(foundations, foundation)) throw new Error('frame.foundation: use framed or borderless');
    const result = { ...foundations[foundation] };
    for (const [key, range] of Object.entries(bounds)) if (Object.hasOwn(value, key)) {
      const n = value[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < range[0] || n > range[1]) throw new Error(`frame.${key}: expected ${range[0]}–${range[1]}`);
      result[key] = n;
    }
    return result;
  }
  function composition(value, skins) {
    object(value, 'skin');
    for (const key of Object.keys(value)) if (!['version', 'extends', 'frame'].includes(key)) throw new Error(`${key}: unknown field`);
    if (value.version !== 1) throw new Error('version: expected 1');
    if (typeof value.extends !== 'string' || !skins.some(s => s.id === value.extends)) throw new Error('extends: unknown skin');
    const parent = skins.find(s => s.id === value.extends);
    return { version: 1, extends: value.extends, frame: frame(value.frame ?? parent.frame ?? {}) };
  }
  function apply(value) {
    const f = frame(value), root = document.documentElement;
    root.dataset.skinFrame = f.foundation;
    for (const key of Object.keys(bounds)) {
      if (Object.hasOwn(f, key)) root.style.setProperty(`--sf-${key}`, `${f[key]}px`);
      else root.style.removeProperty(`--sf-${key}`);
    }
    return f;
  }
  function choices(current) { return `<div class="sf-choices" role="group" aria-label="Window foundation">${[['framed', 'Standard'], ['borderless', 'Borderless']].map(([id, name]) => `<button type="button" data-skinfoundation="${id}" aria-pressed="${current === id}">${name}</button>`).join('')}</div>`; }
  // Borderless has no auxiliary control overlay. Back stays with the existing shell.
  const back = () => false;
  const api = Object.freeze({ foundations, frame, composition, apply, choices, back });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.WosSkinFrame = api;
})();
