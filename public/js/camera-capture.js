/*
 * Live camera capture for diary photo/video questions.
 *
 * Respondents must capture a real-time photo or video with the device
 * camera -- there is no path to pick an existing file from the gallery,
 * on any browser or device. A button with class "camera-capture-trigger"
 * opens a full-screen live camera view; the captured photo/video is
 * written into the associated hidden <input type="file"> as a real File
 * object (via DataTransfer), so the surrounding <form> and server-side
 * upload handling need no changes at all.
 *
 * Usage (see diary_form.ejs / diary_video_capture.ejs):
 *   <button type="button" class="camera-capture-trigger"
 *           data-kind="photo|video" data-target="<input id>" data-label="<span id>">
 *   <input type="file" id="..." name="..." accept="image/*|video/*" class="hidden" />
 */
(function () {
  "use strict";

  var MAX_VIDEO_SECONDS = 45;

  var stream = null;
  var mediaRecorder = null;
  var recordedChunks = [];
  var recordedBlob = null;
  var capturedPhotoBlob = null;
  var recording = false;
  var timerInterval = null;
  var recordSeconds = 0;
  var current = null; // { kind, targetInput, labelEl }

  var modal, videoPreview, photoPreview, videoPlayback, permissionMsg, timerEl,
    shutterBtn, retakeBtn, useBtn, closeBtn, retryPermBtn, titleEl, canvas;

  function buildModalOnce() {
    if (modal) return;
    modal = document.createElement("div");
    modal.id = "camCaptureModal";
    modal.className = "fixed inset-0 z-50 bg-black flex flex-col hidden";
    modal.innerHTML =
      '<div class="flex items-center justify-between px-4 py-3">' +
      '  <span id="camCaptureTitle" class="text-white text-sm font-semibold">Take a photo</span>' +
      '  <button type="button" id="camCloseBtn" class="text-white/80 hover:text-white text-sm px-2 py-1">Cancel</button>' +
      "</div>" +
      '<div class="relative flex-1 bg-black overflow-hidden flex items-center justify-center">' +
      '  <video id="camVideoPreview" autoplay playsinline muted class="w-full h-full object-contain"></video>' +
      '  <img id="camPhotoPreview" alt="Captured photo preview" class="w-full h-full object-contain hidden" />' +
      '  <video id="camVideoPlayback" playsinline controls class="w-full h-full object-contain hidden"></video>' +
      '  <div id="camPermissionMsg" class="hidden absolute inset-0 flex flex-col items-center justify-center text-center text-white/90 text-sm p-8 gap-4">' +
      "    <span>Camera access is needed to capture this. Please allow camera access for this site, then try again.</span>" +
      '    <button type="button" id="camRetryPermBtn" class="border border-white/40 rounded-lg px-4 py-2 text-sm text-white">Try again</button>' +
      "  </div>" +
      '  <div id="camTimer" class="hidden absolute top-3 left-1/2 -translate-x-1/2 bg-red-600 text-white text-xs font-semibold rounded-full px-3 py-1">0:00</div>' +
      "</div>" +
      '<div class="px-6 py-6 flex items-center justify-center gap-5 bg-black">' +
      '  <button type="button" id="camShutterBtn" class="w-16 h-16 rounded-full bg-white ring-4 ring-white/30 active:scale-95 transition"></button>' +
      '  <button type="button" id="camRetakeBtn" class="hidden border border-white/40 text-white rounded-lg px-4 py-2.5 text-sm font-medium">Retake</button>' +
      '  <button type="button" id="camUseBtn" class="hidden bg-brand-600 text-white rounded-lg px-5 py-2.5 text-sm font-semibold">Use this</button>' +
      "</div>";
    document.body.appendChild(modal);

    videoPreview = modal.querySelector("#camVideoPreview");
    photoPreview = modal.querySelector("#camPhotoPreview");
    videoPlayback = modal.querySelector("#camVideoPlayback");
    permissionMsg = modal.querySelector("#camPermissionMsg");
    timerEl = modal.querySelector("#camTimer");
    shutterBtn = modal.querySelector("#camShutterBtn");
    retakeBtn = modal.querySelector("#camRetakeBtn");
    useBtn = modal.querySelector("#camUseBtn");
    closeBtn = modal.querySelector("#camCloseBtn");
    retryPermBtn = modal.querySelector("#camRetryPermBtn");
    titleEl = modal.querySelector("#camCaptureTitle");
    canvas = document.createElement("canvas");

    closeBtn.addEventListener("click", closeModal);
    retryPermBtn.addEventListener("click", startStream);
    shutterBtn.addEventListener("click", onShutter);
    retakeBtn.addEventListener("click", onRetake);
    useBtn.addEventListener("click", onUse);
  }

  function resetVisualState() {
    videoPreview.classList.remove("hidden");
    photoPreview.classList.add("hidden");
    videoPlayback.classList.add("hidden");
    videoPlayback.pause();
    videoPlayback.removeAttribute("src");
    permissionMsg.classList.add("hidden");
    timerEl.classList.add("hidden");
    timerEl.textContent = "0:00";
    shutterBtn.classList.remove("hidden");
    shutterBtn.style.background = "#fff";
    retakeBtn.classList.add("hidden");
    useBtn.classList.add("hidden");
    recordedChunks = [];
    recordedBlob = null;
    capturedPhotoBlob = null;
    recording = false;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    recordSeconds = 0;
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  function startStream() {
    permissionMsg.classList.add("hidden");
    var constraints = {
      video: { facingMode: { ideal: "environment" } },
      audio: current.kind === "video",
    };
    stopStream();
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(function (s) {
        stream = s;
        videoPreview.srcObject = stream;
      })
      .catch(function () {
        permissionMsg.classList.remove("hidden");
      });
  }

  function openModal(kind, targetInput, labelEl) {
    buildModalOnce();
    current = { kind: kind, targetInput: targetInput, labelEl: labelEl };
    titleEl.textContent = kind === "video" ? "Record a video" : "Take a photo";
    resetVisualState();
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    startStream();
  }

  function closeModal() {
    if (recording && mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    stopStream();
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    modal.classList.add("hidden");
    document.body.style.overflow = "";
    current = null;
  }

  function formatTime(totalSeconds) {
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function pickVideoMimeType() {
    var candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function onShutter() {
    if (current.kind === "photo") {
      capturePhoto();
    } else if (!recording) {
      startRecording();
    } else {
      stopRecording();
    }
  }

  function capturePhoto() {
    canvas.width = videoPreview.videoWidth || 1280;
    canvas.height = videoPreview.videoHeight || 720;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(videoPreview, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      function (blob) {
        capturedPhotoBlob = blob;
        photoPreview.src = URL.createObjectURL(blob);
        videoPreview.classList.add("hidden");
        photoPreview.classList.remove("hidden");
        shutterBtn.classList.add("hidden");
        retakeBtn.classList.remove("hidden");
        useBtn.classList.remove("hidden");
      },
      "image/jpeg",
      0.87
    );
  }

  function startRecording() {
    var mimeType = pickVideoMimeType();
    try {
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      permissionMsg.querySelector("span").textContent =
        "Video recording isn't supported in this browser. Please try a different browser or device.";
      permissionMsg.classList.remove("hidden");
      return;
    }
    recordedChunks = [];
    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = function () {
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "video/webm" });
      videoPlayback.src = URL.createObjectURL(recordedBlob);
      videoPreview.classList.add("hidden");
      videoPlayback.classList.remove("hidden");
      retakeBtn.classList.remove("hidden");
      useBtn.classList.remove("hidden");
    };
    recording = true;
    recordSeconds = 0;
    mediaRecorder.start();
    shutterBtn.style.background = "#dc2626";
    timerEl.classList.remove("hidden");
    timerEl.textContent = formatTime(0);
    timerInterval = setInterval(function () {
      recordSeconds++;
      timerEl.textContent = formatTime(recordSeconds);
      if (recordSeconds >= MAX_VIDEO_SECONDS) stopRecording();
    }, 1000);
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    timerEl.classList.add("hidden");
    shutterBtn.classList.add("hidden");
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }

  function onRetake() {
    resetVisualState();
    videoPreview.srcObject = stream; // stream is still live; just show it again
  }

  function onUse() {
    var input = current.targetInput;
    var labelEl = current.labelEl;
    var file, statusText;
    if (current.kind === "photo" && capturedPhotoBlob) {
      file = new File([capturedPhotoBlob], "photo-" + Date.now() + ".jpg", { type: "image/jpeg" });
      statusText = "✓ Photo captured — tap to retake";
    } else if (current.kind === "video" && recordedBlob) {
      var ext = (mediaRecorder && mediaRecorder.mimeType || "").indexOf("mp4") !== -1 ? "mp4" : "webm";
      file = new File([recordedBlob], "video-" + Date.now() + "." + ext, { type: recordedBlob.type });
      statusText = "✓ Video captured (" + formatTime(recordSeconds) + ") — tap to retake";
    } else {
      return;
    }
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      // DataTransfer construction failed (very old browser) -- nothing more we can do here.
    }
    if (labelEl) labelEl.textContent = statusText;
    closeModal();
  }

  window.openCameraCapture = function (kind, targetInputId, labelElId) {
    var input = document.getElementById(targetInputId);
    var labelEl = labelElId ? document.getElementById(labelElId) : null;
    if (!input) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Your browser doesn't support live camera capture. Please try a different browser.");
      return;
    }
    openModal(kind, input, labelEl);
  };

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".camera-capture-trigger");
    if (!btn) return;
    e.preventDefault();
    window.openCameraCapture(btn.dataset.kind, btn.dataset.target, btn.dataset.label);
  });
})();
