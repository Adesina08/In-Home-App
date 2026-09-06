(() => {
  document.querySelectorAll('[data-media-gallery]').forEach(gallery => {
    const figures = [...gallery.querySelectorAll('figure[data-kind]')];
    gallery.querySelectorAll('[data-media-filter]').forEach(button => button.addEventListener('click', () => {
      gallery.querySelectorAll('[data-media-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      let shown = 0;
      figures.forEach(f => { f.hidden = button.dataset.mediaFilter !== 'all' && f.dataset.kind !== button.dataset.mediaFilter; if (!f.hidden) shown++; else f.querySelectorAll('video,audio').forEach(m => m.pause()); });
      gallery.querySelector('[data-media-empty]').hidden = shown > 0;
    }));
    gallery.querySelectorAll('img,video,audio').forEach(media => {
      const fail = () => { media.hidden = true; media.parentElement.querySelector('[data-media-error]').hidden = false; };
      media.addEventListener('error', fail);
      if (media.tagName === 'IMG' && media.complete && !media.naturalWidth) fail();
      if (media.error) fail();
      media.addEventListener('play', () => document.querySelectorAll('video,audio').forEach(other => { if (other !== media) other.pause(); }));
    });
  });
  document.querySelectorAll('[data-generate-summary]').forEach(form => form.addEventListener('submit', () => {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true; button.textContent = 'Preparing summary…';
  }));
})();
