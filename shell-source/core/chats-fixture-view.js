// Development example: a different list, shared Agent Service state and the standard thread/composer.
export default {
  contract: 'wizard.chats-view/1', id: 'chats-fixture', name: 'Chats by subject (fixture)',
  mount(el, host) {
    let signature = '';
    const update = () => {
      if (host.thread) { signature = ''; host.renderDefault(); return; }
      const threads = host.threads;
      const next = JSON.stringify(threads.map(s => [s.id, s.title, s.attention?.subject, host.isUnread(s)]));
      if (signature === next && el.querySelector('[data-chats-fixture]')) return;
      signature = next;
      const list = host.element('div'); list.className = 'ch-list chats-fixture'; list.dataset.chatsFixture = '';
      const title = host.element('h2'); title.textContent = 'Chats by subject'; list.append(title);
      const hint = host.element('p'); hint.textContent = 'Same conversations. A different view.'; list.append(hint);
      const groups = new Map();
      for (const s of threads) { const subject = s.attention?.subject || 'Other conversations'; if (!groups.has(subject)) groups.set(subject, []); groups.get(subject).push(s); }
      for (const [subject, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        const heading = host.element('h3'); heading.textContent = subject; list.append(heading);
        for (const s of rows) {
          const button = host.element('button'); button.type = 'button'; button.dataset.fixtureThread = s.id;
          button.textContent = s.title || 'Thread'; button.className = host.isUnread(s) ? 'unread' : '';
          if (host.live?.isPrivate?.(s.id)) button.dataset.wizPrivate = '';
          list.append(button);
        }
      }
      el.replaceChildren(list);
    };
    host.listen('click', e => { const row = e.target.closest('[data-fixture-thread]'); if (row) host.openThread(row.dataset.fixtureThread); });
    host.subscribe(update);
    return { update, unmount() { signature = ''; } };
  },
};
