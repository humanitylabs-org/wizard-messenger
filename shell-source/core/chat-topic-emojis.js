/* Stable, owner-selected topic emoji for Chats rows. Shared by phone and desktop shells. */
(() => {
  'use strict';
  const KEY = 'wos.chats.topicEmoji.v1';
  const data = Array.isArray(window.WosTopicEmojiData) ? window.WosTopicEmojiData : [];
  const categorySpecs = [
    ['Smileys & People', [0, 1]],
    ['Animals & Nature', [3]],
    ['Food & Drink', [4]],
    ['Activity', [6]],
    ['Travel & Places', [5]],
    ['Objects', [7]],
    ['Symbols', [8]],
    ['Flags', [9]],
  ];
  const categories = Object.freeze(categorySpecs.map(([label, groups]) => Object.freeze({
    label,
    emoji: Object.freeze(data.filter(item => groups.includes(item[3])).map(item => item[0])),
  })));
  const choices = Object.freeze(categories.flatMap(category => category.emoji));
  const allowed = new Set(choices);
  const records = data.map((item, order) => ({
    emoji: item[0],
    label: String(item[1] || '').toLowerCase(),
    tags: (Array.isArray(item[2]) ? item[2] : []).map(tag => String(tag).toLowerCase()),
    order,
  }));
  const normalize = value => String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const words = value => normalize(value).split(/[^a-z0-9]+/).filter(Boolean);
  const fitnessQueries = new Set(['workout', 'exercise', 'gym', 'sports', 'sport', 'strong', 'muscle']);
  const fitnessEmoji = new Set(['🏋️', '🏃', '🤸', '⛹️', '🤼', '⚽', '🏀', '🏈', '⚾', '🎾', '🚴', '🏊']);
  const priorityAliases = Object.freeze({
    '💪': ['workout', 'exercise', 'gym', 'sports', 'sport', 'strong', 'muscle'],
    '🚆': ['train'],
    '✈️': ['plane'],
    '😀': ['happy'],
    '💰': ['money'],
    '💻': ['computer'],
  });
  const score = (record, query) => {
    if (priorityAliases[record.emoji]?.includes(query)) return record.emoji === '💪' ? 1000 : 900;
    if (fitnessQueries.has(query) && fitnessEmoji.has(record.emoji)) return 800;
    if (record.emoji === query || record.label === query) return 700;
    if (record.label.startsWith(query)) return 600;
    const labelWords = words(record.label);
    if (labelWords.some(word => word.startsWith(query))) return 550;
    if (record.tags.includes(query)) return 500;
    if (record.tags.some(tag => tag.startsWith(query))) return 400;
    if (query.length >= 3 && record.label.includes(query)) return 300;
    if (query.length >= 3 && record.tags.some(tag => tag.includes(query))) return 200;
    return 0;
  };
  // A single result group preserves global match ranking. Category labels never participate in matching.
  const search = query => {
    const q = normalize(query);
    if (!q) return categories;
    const emoji = records.map(record => ({ record, rank: score(record, q) }))
      .filter(result => result.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.record.order - b.record.order)
      .map(result => result.record.emoji);
    return emoji.length ? [Object.freeze({ label: 'Search results', emoji: Object.freeze(emoji) })] : [];
  };
  const rules = [
    [/(?:\bdev\b|develop|code|coding|software|github|bug|build|deploy|server|hermes|wizard\s*os)/i, '💻'],
    [/(?:shorts?|reels?|tiktok|vertical\s+video)/i, '🏹'],
    [/(?:rail|railway|train|trans[- ]?siberian)/i, '🚆'],
    [/(?:video|film|movie|clip|youtube|media)/i, '🎬'],
    [/(?:ship|shipment|delivery|parcel|package|order)/i, '📦'],
    [/(?:market|fund|portfolio|stock|invest|finance|trading)/i, '📈'],
    [/(?:health|fitness|workout|exercise|gym|sport|strong|muscle|sleep|energy)/i, '💪'],
    [/(?:music|audio|song|playlist|podcast)/i, '🎧'],
    [/(?:book|read|library|canon|wisdom)/i, '📚'],
    [/(?:research|idea|think|strategy)/i, '🧠'],
    [/(?:travel|flight|trip|hotel|airbnb)/i, '✈️'],
  ];
  let selected = {};
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      selected = Object.fromEntries(Object.entries(value).filter(([key, emoji]) => key && allowed.has(emoji)));
    }
  } catch (_) {}
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(selected)); return true; } catch (_) { return false; }
  };
  const infer = (text, fallback = '💬') => {
    const value = String(text || '');
    for (const [pattern, emoji] of rules) if (pattern.test(value)) return emoji;
    return allowed.has(fallback) ? fallback : '💬';
  };
  window.WosTopicEmoji = Object.freeze({
    categories,
    choices,
    search,
    infer,
    get(key, text, fallback = '💬') { return selected[String(key || '')] || infer(text, fallback); },
    set(key, emoji) {
      key = String(key || '');
      if (!key || !allowed.has(emoji)) return false;
      const before = selected[key]; selected[key] = emoji;
      if (save()) return true;
      if (before) selected[key] = before; else delete selected[key];
      return false;
    },
  });
})();
