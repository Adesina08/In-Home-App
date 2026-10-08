// Send a compact review payload, avoiding URL-encoded field-count limits for
// studies with many supporting moments. Native form submission remains usable.
document.querySelectorAll('[data-research-review]').forEach(form => {
  form.addEventListener('submit', () => {
    const value = (root, name) => {
      const input = root.querySelector(`[data-field="${name}"]`);
      return input?.type === 'checkbox' ? (input.checked ? '1' : '0') : input?.value || '';
    };
    const points = Array.from(form.querySelectorAll('[data-finding]')).map(root => ({
      index: value(root, 'index'), include: value(root, 'include'), point: value(root, 'point'), order: value(root, 'order'),
      clips: Array.from(root.querySelectorAll('[data-clip]')).filter(c => value(c, 'include') === '1').map(c => ({ include: '1', moment_id: value(c, 'moment_id'), start: value(c, 'start'), end: value(c, 'end') })),
    }));
    const field = document.createElement('input');
    field.type = 'hidden'; field.name = 'points_json'; field.value = JSON.stringify(points); form.appendChild(field);
    form.querySelectorAll('[data-field]').forEach(input => input.removeAttribute('name'));
  });
});
