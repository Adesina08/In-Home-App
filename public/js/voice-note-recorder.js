/*
 * WhatsApp-style voice note recorder for the diary's optional audio note.
 *
 * Hold the mic button to record, slide left to cancel, slide up to lock into
 * hands-free recording, release to attach -- same interaction model as a
 * WhatsApp voice message. There is no file-picker fallback, so a respondent
 * can't attach an old audio file; every note is recorded live.
 *
 * The recorded clip is written into the paired hidden <input type="file">
 * as a real File object (via DataTransfer), so the surrounding <form> and
 * server-side upload handling (fieldname "audio_note") need no changes.
 *
 * Markup (see diary_form.ejs):
 *   <div class="voice-note-recorder" data-target="audioNoteInput"></div>
 *   <input type="file" id="audioNoteInput" name="audio_note" accept="audio/*" class="hidden" />
 */
(function () {
  "use strict";

  var CANCEL_THRESHOLD = 80; // px dragged left to cancel
  var LOCK_THRESHOLD = 60; // px dragged up to lock hands-free
  var MIN_HOLD_MS = 300; // shorter than this on release = treat as an accidental tap
  var MAX_SECONDS = 180;

  var ICON_MIC =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" class="w-5 h-5 pointer-events-none"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3zM19.5 11.25a7.5 7.5 0 01-15 0M12 18.75v2.25" /></svg>';
  var ICON_STOP =
    '<svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 pointer-events-none"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>';
  var ICON_PLAY =
    '<svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4"><path d="M6.3 2.84A1.5 1.5 0 004 4.11v15.78a1.5 1.5 0 002.3 1.27l12.67-7.89a1.5 1.5 0 000-2.54L6.3 2.84z" /></svg>';
  var ICON_PAUSE =
    '<svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4"><path d="M6.75 4.5A.75.75 0 017.5 3.75H9a.75.75 0 01.75.75v15A.75.75 0 019 20.25H7.5a.75.75 0 01-.75-.75V4.5zm9 0a.75.75 0 01.75-.75H18a.75.75 0 01.75.75v15a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75V4.5z" /></svg>';
  var ICON_LOCK =
    '<svg viewBox="0 0 24 24" fill="currentColor" class="w-3.5 h-3.5"><path d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3C17.25 3.85 14.9 1.5 12 1.5zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z" /></svg>';
  var ICON_TRASH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.166L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562l.657-.038m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>';

  function formatTime(totalSeconds) {
    var m = Math.floor(totalSeconds / 60);
    var s = Math.floor(totalSeconds % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function pickAudioMimeType() {
    var candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function initRecorder(container) {
    var input = document.getElementById(container.dataset.target);
    if (!input) return;

    var state = "idle"; // idle | recording | locked | attached | error
    var stream = null;
    var mediaRecorder = null;
    var chunks = [];
    var attachedBlob = null;
    var attachedUrl = null;
    var audioEl = null;
    var timerInterval = null;
    var seconds = 0;
    var startX = 0, startY = 0;
    var dragCancelled = false;
    var dragLocked = false;
    var holdStartedAt = 0;

    function render() {
      if (state === "idle") {
        container.innerHTML =
          '<div class="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">' +
          '  <span class="text-sm text-slate-400 flex-1" id="vnHint">Hold to record a voice note</span>' +
          '  <button type="button" id="vnMicBtn" class="w-12 h-12 rounded-full bg-sky-600 text-white flex items-center justify-center shadow-card active:scale-95 transition touch-none select-none" style="user-select:none;">' +
          ICON_MIC +
          "  </button>" +
          "</div>";
        wireIdle();
      } else if (state === "recording" || state === "locked") {
        var lockedUi = state === "locked";
        container.innerHTML =
          '<div class="relative flex items-center gap-3 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">' +
          '  <span class="text-xs font-semibold text-red-600 tabular-nums w-9" id="vnTimer">0:00</span>' +
          (lockedUi
            ? '  <span class="text-sm text-red-500 flex-1">Recording — tap stop when you\'re done</span>'
            : '  <span class="text-sm text-slate-400 flex-1 flex items-center justify-end gap-1" id="vnSlideHint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>Slide to cancel</span>') +
          (!lockedUi
            ? '  <div class="absolute -top-8 right-1 flex flex-col items-center gap-0.5 text-slate-400" id="vnLockHint">' + ICON_LOCK + '<span class="text-[9px] uppercase tracking-wide">Lock</span></div>'
            : "") +
          '  <button type="button" id="vnMicBtn" class="w-12 h-12 rounded-full ' +
          (lockedUi ? "bg-red-600" : "bg-red-500 animate-pulse") +
          ' text-white flex items-center justify-center shadow-card touch-none select-none" style="user-select:none;">' +
          (lockedUi ? ICON_STOP : ICON_MIC) +
          "  </button>" +
          "</div>";
        wireRecording();
      } else if (state === "attached") {
        container.innerHTML =
          '<div class="flex items-center gap-3 bg-sky-50 border border-sky-200 rounded-2xl px-4 py-3">' +
          '  <button type="button" id="vnPlayBtn" class="w-9 h-9 rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0">' +
          ICON_PLAY +
          "  </button>" +
          '  <div class="flex-1 h-1.5 bg-sky-200 rounded-full overflow-hidden"><div id="vnProgressBar" class="h-full bg-sky-600" style="width:0%"></div></div>' +
          '  <span class="text-xs text-slate-500 tabular-nums shrink-0" id="vnDuration">' +
          formatTime(seconds) +
          "</span>" +
          '  <button type="button" id="vnDeleteBtn" class="text-slate-400 hover:text-red-500 transition shrink-0">' +
          ICON_TRASH +
          "  </button>" +
          "</div>";
        wireAttached();
      } else if (state === "error") {
        container.innerHTML =
          '<div class="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">' +
          '  <span class="text-sm text-amber-700 flex-1">Microphone access is needed to record a voice note. Please allow microphone access, then try again.</span>' +
          '  <button type="button" id="vnRetryBtn" class="text-xs font-semibold text-amber-800 border border-amber-300 rounded-lg px-3 py-1.5 shrink-0">Try again</button>' +
          "</div>";
        container.querySelector("#vnRetryBtn").addEventListener("click", function () {
          state = "idle";
          render();
        });
      }
    }

    function wireIdle() {
      var btn = container.querySelector("#vnMicBtn");
      btn.addEventListener("pointerdown", onPointerDown);
    }

    function onPointerDown(e) {
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      dragCancelled = false;
      dragLocked = false;
      holdStartedAt = Date.now();
      attachDragListeners();
      startRecording();
    }

    function startRecording() {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (s) {
          stream = s;
          var mimeType = pickAudioMimeType();
          try {
            mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
          } catch (err) {
            stopStreamTracks();
            state = "error";
            render();
            return;
          }
          chunks = [];
          mediaRecorder.ondataavailable = function (e) {
            if (e.data && e.data.size > 0) chunks.push(e.data);
          };
          mediaRecorder.onstop = onRecorderStop;
          mediaRecorder.start();
          state = "recording";
          seconds = 0;
          render();
          var timerEl = container.querySelector("#vnTimer");
          timerInterval = setInterval(function () {
            seconds++;
            if (timerEl) timerEl.textContent = formatTime(seconds);
            if (seconds >= MAX_SECONDS) finishRecording(false);
          }, 1000);

        })
        .catch(function () {
          detachDragListeners();
          state = "error";
          render();
        });
    }

    function wireRecording() {
      if (state !== "locked") return;
      var btn = container.querySelector("#vnMicBtn");
      btn.addEventListener("click", function () { finishRecording(false); });
    }

    // The drag gesture (slide-to-cancel / slide-to-lock) is tracked on `document`,
    // not on the mic button itself: the button gets torn down and rebuilt by
    // render() as soon as recording starts (idle -> recording), and the sliding
    // "Slide to cancel" hint text visually overlaps the button as it translates,
    // which would otherwise steal the native hit-test target mid-drag and stall
    // pointermove delivery. Binding to `document` sidesteps hit-testing entirely.
    function attachDragListeners() {
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerUp);
    }

    function detachDragListeners() {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    }

    function onPointerMove(e) {
      if (state !== "recording") return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;

      var slideHint = container.querySelector("#vnSlideHint");
      if (slideHint && dx < 0) {
        var progress = Math.min(1, Math.abs(dx) / CANCEL_THRESHOLD);
        slideHint.style.opacity = String(1 - progress * 0.6);
        slideHint.style.transform = "translateX(" + Math.max(dx, -CANCEL_THRESHOLD) + "px)";
      }
      var lockHint = container.querySelector("#vnLockHint");
      if (lockHint && dy < 0) {
        var lockProgress = Math.min(1, Math.abs(dy) / LOCK_THRESHOLD);
        lockHint.style.transform = "translateY(" + Math.max(dy, -LOCK_THRESHOLD) + "px)";
        lockHint.style.color = lockProgress >= 1 ? "#0284c7" : "";
      }

      if (dx < -CANCEL_THRESHOLD && !dragCancelled) {
        dragCancelled = true;
        detachDragListeners();
        finishRecording(true);
      } else if (dy < -LOCK_THRESHOLD && !dragLocked && !dragCancelled) {
        dragLocked = true;
        detachDragListeners(); // recording continues hands-free; a later pointerup must not stop it
        state = "locked";
        render();
      }
    }

    function onPointerUp() {
      if (state !== "recording") return; // already locked or cancelled -- handled elsewhere
      detachDragListeners();
      var held = Date.now() - holdStartedAt;
      if (held < MIN_HOLD_MS) {
        finishRecording(true); // treat an accidental tap as a cancel, not a 0-second note
        return;
      }
      finishRecording(false);
    }

    function finishRecording(cancel) {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      var wasCancelled = cancel;
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder._cancelled = wasCancelled;
        mediaRecorder.stop();
      } else {
        stopStreamTracks();
        state = "idle";
        render();
      }
    }

    function onRecorderStop() {
      var cancelled = !!mediaRecorder._cancelled;
      stopStreamTracks();
      if (cancelled || chunks.length === 0) {
        state = "idle";
        chunks = [];
        render();
        return;
      }
      attachedBlob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      attachedUrl = URL.createObjectURL(attachedBlob);
      assignFileToInput();
      state = "attached";
      render();
    }

    function stopStreamTracks() {
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
    }

    function assignFileToInput() {
      var ext = (attachedBlob.type || "").indexOf("mp4") !== -1 ? "m4a" : "webm";
      var file = new File([attachedBlob], "voice-note-" + Date.now() + "." + ext, { type: attachedBlob.type });
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {
        // very old browser without DataTransfer construction support -- nothing more we can do
      }
    }

    function wireAttached() {
      audioEl = new Audio(attachedUrl);
      var playBtn = container.querySelector("#vnPlayBtn");
      var progressBar = container.querySelector("#vnProgressBar");
      var durationEl = container.querySelector("#vnDuration");
      var deleteBtn = container.querySelector("#vnDeleteBtn");

      playBtn.addEventListener("click", function () {
        if (audioEl.paused) {
          audioEl.play();
          playBtn.innerHTML = ICON_PAUSE;
        } else {
          audioEl.pause();
          playBtn.innerHTML = ICON_PLAY;
        }
      });
      audioEl.addEventListener("timeupdate", function () {
        if (audioEl.duration) {
          progressBar.style.width = (audioEl.currentTime / audioEl.duration) * 100 + "%";
          durationEl.textContent = formatTime(audioEl.currentTime);
        }
      });
      audioEl.addEventListener("ended", function () {
        playBtn.innerHTML = ICON_PLAY;
        progressBar.style.width = "0%";
        durationEl.textContent = formatTime(seconds);
      });
      deleteBtn.addEventListener("click", function () {
        audioEl.pause();
        if (attachedUrl) URL.revokeObjectURL(attachedUrl);
        attachedUrl = null;
        attachedBlob = null;
        try {
          var dt = new DataTransfer();
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {}
        state = "idle";
        render();
      });
    }

    render();
  }

  function initAll() {
    document.querySelectorAll(".voice-note-recorder").forEach(initRecorder);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();
