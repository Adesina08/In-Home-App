// One-tap "Install App" wiring, shared by every entry point a QR code or link
// can land on (the general Get the App page, and each respondent's diary
// home). Chrome/Edge/most Android browsers fire `beforeinstallprompt` once a
// page qualifies as installable (manifest + registered service worker +
// HTTPS) and hasn't already been added to the home screen; capturing that
// event ourselves and firing prompt() from a button tap turns "dig through
// the browser's menu to find Install/Add to Home Screen" into one tap.
//
// iOS Safari has no equivalent API at all -- that's an Apple platform
// restriction, not something any web app can work around -- so on iOS this
// script never shows a button; the page's own static "Add to Home Screen"
// instructions (Share icon -> Add to Home Screen) are the only path there,
// and stay visible regardless of what this script does.
(function () {
  var DISMISS_KEY = "inicio-install-dismissed";
  var deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }

  function wasDismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  // Every card carries data-install-card (used generically by dismiss/remove
  // below) plus data-install-variant so the two reveal paths -- the one-tap
  // prompt on Chrome/Android, the manual nudge on iOS -- only ever show the
  // card meant for that platform, never both.
  function cardsOfVariant(variant) {
    return document.querySelectorAll('[data-install-card][data-install-variant="' + variant + '"]');
  }

  if (isStandalone()) return; // already running as the installed app -- nothing to offer

  // iOS Safari never fires beforeinstallprompt (no such API exists there), so
  // it never gets a one-tap button -- but it can still get a visible nudge
  // toward the manual Share -> Add to Home Screen steps, instead of the
  // one-tap card simply never appearing with no explanation.
  if (isIos() && !wasDismissed()) {
    cardsOfVariant("ios").forEach(function (card) {
      card.classList.remove("hidden");
    });
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (wasDismissed()) return; // respected a previous "Not now" -- don't reappear uninvited
    cardsOfVariant("prompt").forEach(function (card) {
      card.classList.remove("hidden");
    });
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    document.querySelectorAll("[data-install-card]").forEach(function (card) {
      card.remove();
    });
  });

  document.addEventListener("click", function (e) {
    var trigger = e.target.closest("[data-install-trigger]");
    if (trigger) {
      if (!deferredPrompt) return;
      trigger.disabled = true;
      var card = trigger.closest("[data-install-card]");
      deferredPrompt.prompt();
      deferredPrompt.userChoice
        .then(function (choice) {
          if (choice.outcome === "accepted") {
            if (card) card.remove();
          } else {
            trigger.disabled = false;
          }
          deferredPrompt = null;
        })
        .catch(function () {
          trigger.disabled = false;
        });
      return;
    }
    var dismiss = e.target.closest("[data-install-dismiss]");
    if (dismiss) {
      var dismissCard = dismiss.closest("[data-install-card]");
      if (dismissCard) dismissCard.classList.add("hidden");
      try {
        localStorage.setItem(DISMISS_KEY, "1");
      } catch (err) {}
    }
  });
})();
