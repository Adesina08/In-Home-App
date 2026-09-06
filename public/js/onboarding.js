(() => {
  document.querySelectorAll('.onboarding-content input,.onboarding-content select,.onboarding-content textarea').forEach((input, index) => {
    if (!input.id) input.id = `onboarding-field-${index}`;
    if (input.closest('label') || input.type === 'hidden') return;
    const label = input.parentElement.querySelector('label');
    if (label && !label.htmlFor) label.htmlFor = input.id;
    if (!label && input.name === 'code') input.setAttribute('aria-label', 'Six-digit verification code');
  });
  // Keep browser signup pages clear of the retired diary service worker.
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(reg => reg.unregister()))).catch(() => {});
})();
