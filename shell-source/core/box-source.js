/* Wizard OS · Settings › About: where this box stands against main (wizard-ux#887 rule 5). One row, plain words:
 *   Built on main f3cb2e21 · "2 behind main · 120 own changes"
 * Sources, nothing polled, no token in the browser:
 *   my-release.json  an owner's own release (written by my-release): the main commit it sits on and his own changes;
 *                    "behind" is the App Manager's updates status (WosUpdates.state.release.behind) where my-release
 *                    keeps it current, so nothing extra is asked. Public WAM's updates status has no release.behind:
 *                    then, if my-release.json names the full base commit (base.sha, or a 40-hex base.ref), the base is
 *                    compared with main the same way as a published image (store-install/_main-compare).
 *   build.json       stamped into every published image (Dockerfile, WIZARD_UX_COMMIT): the commit it was built
 *                    from. The App Manager compares it with main (store-install/_main-compare, GitHub's public API,
 *                    cached an hour there); asked when About is drawn, at most once an hour (10 min after a failure).
 * Neither (a dev checkout, an image from before the stamp): the row says the build carries no stamp. */
(() => {
  'use strict';
  const S = window.WosSettings;
  if (!S || S.features?.some(f => f.id === 'box-source')) return;
  const src = document.currentScript?.src || location.href;
  const at = p => new URL(p, new URL('../', src)).href;
  const COMPARE = new URL('../store-install/_main-compare', src).href;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FULL = /^[0-9a-f]{40}$/, SHORT = /^[0-9a-f]{7,40}$/, count = n => Number.isInteger(n) && n >= 0;
  const HOUR = 3600e3, RETRY = 600e3;
  let info = null, loading = false, cmp = null, cmpAt = 0, cmpBusy = false, updAt = 0, updBusy = false, updFailed = false;

  const refresh = () => { try { S.refresh(); } catch (_) {} };
  async function json(u) {
    try {
      const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      return d && typeof d === 'object' ? d : null;
    } catch (_) { return null; }
  }
  function load() {
    if (info || loading) return;
    loading = true;
    (async () => {
      const mine = await json(at('my-release.json'));
      if (mine && SHORT.test(mine.base?.ref || '') && Array.isArray(mine.changes)) {
        const full = [mine.base.sha, mine.base.ref].find(c => FULL.test(c || '')) || null;
        info = { kind: 'mine', base: mine.base.ref, own: mine.changes.length, commit: full };
      }
      else {
        const b = await json(at('build.json'));
        info = FULL.test(b?.commit || '') ? { kind: 'image', commit: b.commit } : { kind: 'none' };
      }
      loading = false; refresh();
    })();
  }
  function compare() {
    if (cmpBusy || (cmpAt && Date.now() - cmpAt < (cmp && !cmp.error ? HOUR : RETRY))) return;
    cmpBusy = true;
    json(COMPARE + '?commit=' + info.commit).then(d => {
      cmp = d && FULL.test(d.base || '') && count(d.behind) && count(d.own) ? d : { error: d?.error || 'unavailable' };
      cmpAt = Date.now(); cmpBusy = false; refresh();
    });
  }
  // The App Manager's updates status (my-release keeps .release.behind current). If it never loads (request failed,
  // older App Manager, no WosUpdates) os-updates.js stops asking, so settle on "couldn't check main" instead of
  // "checking main…" forever; ask again at most every 10 minutes while About is drawn.
  function updates() {
    const U = window.WosUpdates;
    if (U?.state) { updFailed = false; return U.state; }
    if (typeof U?.load !== 'function') { updFailed = true; return null; }
    if (!updBusy && (!updAt || Date.now() - updAt >= RETRY)) {
      updBusy = true;
      Promise.resolve().then(() => U.load()).catch(() => null).then(st => {
        updBusy = false; updAt = Date.now(); updFailed = !(st || U.state); refresh();
      });
    }
    return null;
  }
  // "2 behind main · 120 own changes"; both zero = "Up to date with main".
  function words(behind, own) {
    const mineTxt = count(own) && own > 0 ? `${own} own ${own === 1 ? 'change' : 'changes'}` : '';
    if (!count(behind)) return [mineTxt, 'couldn’t check main'].filter(Boolean).join(' · ');
    if (!behind && !own) return 'Up to date with main';
    return [`${behind} behind main`, mineTxt].filter(Boolean).join(' · ');
  }
  const row = (title, sub) => `<div class="st-group" data-box-source><div class="st-row static"><span class="st-tx"><b>${esc(title)}</b><small>${esc(sub)}</small></span></div></div>`;
  function html() {
    load();
    if (!info) return '';
    if (info.kind === 'none') return row('Main commit unknown', 'This build carries no stamp of the main commit it came from');
    if (info.kind === 'mine') {
      const st = updates(), behind = count(st?.release?.behind) ? st.release.behind : null;
      const own = info.own ? `${info.own} own ${info.own === 1 ? 'change' : 'changes'} · ` : '';
      const title = `Built on main ${info.base.slice(0, 8)}`;
      if (!st && !updFailed) return row(title, `${own}checking main…`);
      if (behind !== null || !info.commit) return row(title, words(behind, info.own));
      // No release.behind (public WAM): compare the full base commit with main; own changes stay my-release's count.
      compare();
      if (!cmp) return row(title, `${own}checking main…`);
      return row(title, words(cmp.error ? null : cmp.behind, info.own));
    }
    compare();
    if (!cmp) return row(`Built from ${info.commit.slice(0, 8)}`, 'Checking main…');
    if (cmp.error) return row(`Built from ${info.commit.slice(0, 8)}`, cmp.error === 'not on GitHub' ? 'This commit isn’t on GitHub, so it can’t be compared with main' : 'Couldn’t check main just now');
    return row(`Built on main ${cmp.base.slice(0, 8)}`, words(cmp.behind, cmp.own));
  }
  S.register({ id: 'box-source', page: 'about', aliases: ['box-source'], html: () => html() });
})();
