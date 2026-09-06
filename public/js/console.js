(() => {
  'use strict';
  if (!document.body.classList.contains('inicio-console')) return;
  const navToggle = document.querySelector('[data-toggle-nav]');
  const sidebar = document.querySelector('.console-sidebar');
  const mobile = window.matchMedia('(max-width: 900px)');
  function setNav(open) {
    document.body.classList.toggle('nav-open', open);
    navToggle?.setAttribute('aria-expanded', String(open));
    navToggle?.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    sidebar.inert = mobile.matches && !open;
    if (open) sidebar.querySelector('a')?.focus();
  }
  setNav(false);
  mobile.addEventListener('change', () => setNav(false));
  navToggle?.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
  document.querySelector('[data-close-nav]')?.addEventListener('click', () => { setNav(false); navToggle.focus(); });
  document.addEventListener('keydown', event => {
    if (!document.body.classList.contains('nav-open')) return;
    if (event.key === 'Escape') { setNav(false); navToggle.focus(); }
    if (event.key === 'Tab') {
      const links = [...sidebar.querySelectorAll('a, button')];
      if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); links.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === links.at(-1)) { event.preventDefault(); links[0].focus(); }
    }
  });
  document.querySelectorAll('[data-study-picker]').forEach(select => select.addEventListener('change', () => {
    window.location.href = select.dataset.action + encodeURIComponent(select.value);
  }));
  document.querySelectorAll('[data-open-dialog]').forEach(button => button.addEventListener('click', () => {
    document.getElementById(button.dataset.openDialog)?.showModal();
  }));
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  function openHashTarget() {
    const target = document.getElementById(location.hash.slice(1));
    if (target?.tagName === 'DIALOG' && !target.open) target.showModal();
    if (target?.tagName === 'DETAILS') target.open = true;
  }
  openHashTarget();
  window.addEventListener('hashchange', openHashTarget);

  document.querySelectorAll('[data-console-table]').forEach(table => {
    const container = document.createElement('div');
    container.dataset.tableTools = table.dataset.consoleTable;
    const scroll = document.createElement('div');
    scroll.className = 'overflow-x-auto';
    const toolbar = document.createElement('div');
    toolbar.className = 'console-toolbar';
    const label = document.createElement('label');
    label.className = 'console-search';
    const search = document.createElement('input');
    search.type = 'search'; search.dataset.tableSearch = '';
    search.placeholder = table.dataset.consoleSearchLabel || 'Search these results…';
    search.setAttribute('aria-label', search.placeholder);
    label.append(search); toolbar.append(label);
    table.parentNode.insertBefore(container, table);
    scroll.append(table); container.append(toolbar, scroll);
    table.querySelectorAll('tbody > tr').forEach(row => {
      if (row.querySelector('[colspan]')) row.hidden = true;
      else row.dataset.tableRow = '';
    });
    const empty = document.createElement('div');
    empty.className = 'console-empty'; empty.dataset.tableEmpty = '';
    empty.textContent = 'No results to show. Adjust your search or filters.';
    const footer = document.createElement('div');
    footer.className = 'console-table-footer';
    footer.innerHTML = '<span data-table-count></span><div class="console-actions"><button type="button" data-table-prev aria-label="Previous page">←</button><span data-table-page></span><button type="button" data-table-next aria-label="Next page">→</button></div>';
    container.append(empty, footer);
  });

  // Filter only the rows delivered by the server. Existing server filters are retained.
  document.querySelectorAll('[data-table-tools]').forEach(container => {
    const rows = [...container.querySelectorAll('[data-table-row]')];
    const search = container.querySelector('[data-table-search]');
    const buttons = [...container.querySelectorAll('[data-table-filter]')];
    const empty = container.querySelector('[data-table-empty]');
    const count = container.querySelector('[data-table-count]');
    const pageLabel = container.querySelector('[data-table-page]');
    const prev = container.querySelector('[data-table-prev]');
    const next = container.querySelector('[data-table-next]');
    const size = Number(container.dataset.pageSize) || 10;
    const key = 'inicio-console:' + location.pathname + location.search + ':' + container.dataset.tableTools;
    let state = { q: '', filter: 'all', page: 1 };
    try { state = { ...state, ...JSON.parse(sessionStorage.getItem(key) || '{}') }; } catch (_) {}
    if (search) search.value = state.q;
    if (buttons.length && !buttons.some(button => button.dataset.tableFilter === state.filter)) state.filter = 'all';
    function update() {
      const matches = rows.filter(row => (!state.q || row.textContent.toLowerCase().includes(state.q.toLowerCase())) && (state.filter === 'all' || row.dataset.status === state.filter));
      const pages = Math.max(1, Math.ceil(matches.length / size));
      state.page = Math.min(Math.max(1, state.page), pages);
      rows.forEach(row => { row.hidden = true; });
      matches.slice((state.page - 1) * size, state.page * size).forEach(row => { row.hidden = false; });
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tableFilter === state.filter)));
      if (empty) empty.hidden = matches.length > 0;
      if (count) { count.setAttribute('aria-live', 'polite'); count.textContent = matches.length ? `${(state.page - 1) * size + 1}–${Math.min(state.page * size, matches.length)} of ${matches.length}` : '0 results'; }
      if (pageLabel) pageLabel.textContent = `${state.page} / ${pages}`;
      if (prev) prev.disabled = state.page <= 1;
      if (next) next.disabled = state.page >= pages;
      try { sessionStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
    }
    search?.addEventListener('input', () => { state.q = search.value.trim(); state.page = 1; update(); });
    buttons.forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.tableFilter; state.page = 1; update(); }));
    prev?.addEventListener('click', () => { state.page--; update(); });
    next?.addEventListener('click', () => { state.page++; update(); });
    update();
  });

  const panelInvite = document.querySelector('form[action="/admin/panel/invite"]');
  if (panelInvite) {
    const submit = panelInvite.querySelector('button:not([type=button])');
    const updateSelection = () => {
      const selected = panelInvite.querySelectorAll('input[name=profile_id]:checked').length;
      if (submit) { submit.disabled = !selected; submit.textContent = `Invite selected (${selected})`; }
    };
    panelInvite.addEventListener('change', updateSelection);
    updateSelection();
  }

  // Make existing console forms accessible without changing names or payloads.
  document.querySelectorAll('.console-main input:not([type=hidden]), .console-main select, .console-main textarea').forEach((control, index) => {
    if (control.labels?.length || control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return;
    const label = control.parentElement.querySelector('label');
    if (label && !label.htmlFor && !label.querySelector('input, select, textarea')) {
      control.id ||= 'console-field-' + index;
      label.htmlFor = control.id;
    } else if (control.placeholder || control.name) {
      control.setAttribute('aria-label', control.placeholder || control.name.replace(/_/g, ' '));
    }
  });
  document.querySelectorAll('.console-evidence img, .console-media-preview img, .console-record-evidence img, .console-main video, .console-main audio').forEach(media => {
    if (media.closest('[data-media-gallery]')) return;
    const showUnavailable = () => {
      if (media.dataset.errorShown) return;
      media.dataset.errorShown = 'true';
      const note = document.createElement('p');
      note.className = 'console-media-error';
      note.textContent = 'This file could not be loaded. It may be missing or temporarily unavailable.';
      media.insertAdjacentElement('afterend', note);
      if (media.tagName === 'IMG') media.hidden = true;
    };
    media.addEventListener('error', showUnavailable);
    if (media.tagName === 'IMG' && media.complete && !media.naturalWidth) showUnavailable();
  });
  const settingsForm = document.querySelector('form[data-settings-form]');
  if (settingsForm) {
    let dirty = false;
    const status = document.createElement('p');
    status.className = 'console-form-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    settingsForm.prepend(status);
    settingsForm.addEventListener('input', () => { dirty = true; status.hidden = false; status.textContent = 'You have unsaved changes.'; });
    settingsForm.addEventListener('submit', () => { dirty = false; });
    window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  }
})();
