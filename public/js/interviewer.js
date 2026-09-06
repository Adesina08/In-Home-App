(() => {
  const roster = document.querySelector('[data-field-roster]');
  if (roster) {
    const search = roster.querySelector('[data-roster-search]');
    const study = roster.querySelector('[data-roster-study]');
    const status = roster.querySelector('[data-roster-status]');
    const rows = [...roster.querySelectorAll('[data-roster-row]')];
    const filter = () => {
      let shown = 0;
      const term = search.value.trim().toLowerCase();
      rows.forEach(row => {
        row.hidden = !(row.dataset.search.includes(term) && (!study.value || study.value === row.dataset.study) && (!status.value || status.value === row.dataset.status));
        if (!row.hidden) shown++;
      });
      roster.querySelector('[data-roster-empty]').hidden = shown > 0;
      roster.querySelector('[data-roster-count]').textContent = `${shown} of ${rows.length} respondents shown`;
    };
    search.addEventListener('input', filter);
    study.addEventListener('change', filter);
    status.addEventListener('change', filter);
  }
  document.querySelectorAll('[data-copy-link]').forEach(button => button.addEventListener('click', async () => {
    const link = document.getElementById(button.dataset.copyLink);
    const status = document.querySelector('[data-copy-status]');
    try { await navigator.clipboard.writeText(link.textContent.trim()); status.textContent = 'Personal link copied.'; }
    catch (_) {
      const range = document.createRange(); range.selectNodeContents(link);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      status.textContent = 'Link selected. Use your device’s copy command to copy it.';
    }
  }));
  document.querySelectorAll('.field-main input,.field-main select').forEach((input,index) => {
    if (input.type === 'hidden' || input.labels?.length) return;
    const label = input.previousElementSibling?.tagName === 'LABEL' ? input.previousElementSibling : null;
    if (label) { input.id ||= `field-input-${index}`; label.htmlFor = input.id; }
  });
})();
