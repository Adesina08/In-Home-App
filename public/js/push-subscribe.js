// Respondent diary-reminder push opt-in. Included on the respondent home
// screen (views/respondent/home.ejs) once they're past the device lock.
// Shows a small friendly card asking permission *before* triggering the real
// browser permission prompt (asking cold, on page load, tends to get
// reflexively denied) -- if permission is already granted from a previous
// visit, it silently (re)subscribes with no UI at all so the subscription
// stays fresh without nagging the respondent again.
(function () {
  var root = document.getElementById("pushOptIn");
  if (!root) return; // not on a page that wants this (e.g. VAPID not configured server-side)

  var token = root.getAttribute("data-token");
  var publicKey = root.getAttribute("data-vapid-key");
  var base = "/r/" + token + "/push";

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function postSubscription(sub) {
    return fetch(base + "/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
  }

  function subscribe() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return postSubscription(existing);
        return reg.pushManager
          .subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
          .then(postSubscription);
      });
    });
  }

  function showCard() {
    root.classList.remove("hidden");
    var enableBtn = document.getElementById("pushOptInEnable");
    var dismissBtn = document.getElementById("pushOptInDismiss");
    if (enableBtn) {
      enableBtn.addEventListener("click", function () {
        Notification.requestPermission().then(function (permission) {
          root.classList.add("hidden");
          if (permission === "granted") subscribe().catch(function () {});
        });
      });
    }
    if (dismissBtn) {
      dismissBtn.addEventListener("click", function () {
        root.classList.add("hidden");
        try {
          sessionStorage.setItem("inicio-push-dismissed", "1");
        } catch (e) {}
      });
    }
  }

  function init() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !publicKey) return;

    if (Notification.permission === "granted") {
      subscribe().catch(function () {});
      return;
    }
    if (Notification.permission === "denied") return; // respect it, don't nag

    var alreadyDismissedThisSession = false;
    try {
      alreadyDismissedThisSession = sessionStorage.getItem("inicio-push-dismissed") === "1";
    } catch (e) {}
    if (!alreadyDismissedThisSession) showCard();
  }

  init();
})();
