(() => {
  document.querySelectorAll('[data-cell-mode]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-cell-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    document.querySelectorAll('[data-cell-value]').forEach(cell => { cell.hidden = cell.dataset.cellValue !== button.dataset.cellMode; });
  }));
  const study = document.querySelector('.analysis-filters [name=study]');
  study?.addEventListener('change', () => { document.querySelector('.analysis-filters [name=question]').value = ''; });
  const node = document.getElementById('analysis-data');
  if (!node || !window.Chart) return;
  const data = JSON.parse(node.textContent);
  const palette = ['#35549c', '#53a8cd', '#547fa5', '#739ebc', '#9bc7d6', '#687394'];
  const common = { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#586981' } }, y: { beginAtZero: true, ticks: { precision: 0, color: '#586981' }, grid: { color: '#edf1f6' } } } };
  const draw = (id, config) => { const canvas = document.getElementById(id); if (canvas) new Chart(canvas, config); };
  draw('response-chart', { type: 'bar', data: { labels: data.distribution.map(d => d.label), datasets: [{ label: 'Eligible occasions', data: data.distribution.map(d => d.n), backgroundColor: palette[0], borderRadius: 4 }] }, options: { ...common, indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false }, ticks: { callback(value) { const label = this.getLabelForValue(value); return label.length > 32 ? label.slice(0, 29) + '…' : label; } } } } } });
  draw('trend-chart', { type: 'line', data: { labels: data.trend.map(d => d.label), datasets: [{ label: 'Eligible occasions', data: data.trend.map(d => d.n), borderColor: palette[0], backgroundColor: '#35549c12', fill: true, tension: 0, pointRadius: data.trend.length > 60 ? 0 : 3 }] }, options: common });
  draw('mode-chart', { type: 'doughnut', data: { labels: data.modes.map(d => d.label), datasets: [{ data: data.modes.map(d => d.n), backgroundColor: palette, borderWidth: 3, borderColor: '#fff' }] }, options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: '72%', plugins: { legend: { display: false } } } });
})();
