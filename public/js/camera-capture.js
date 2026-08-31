/*
 * Live camera capture for diary photo/video questions.
 *
 * Respondents capture evidence live with the device camera. Photos continue to
 * prefer the rear/environment camera because they normally show a product.
 * Video questions and the capture-first Video format intentionally prefer the
 * front/user camera so the respondent can speak to camera while logging the
 * consumption occasion.
 */
(function () {
  "use strict";

  // Video mode walks the respondent through a teleprompter, so it needs room
  // for several prompts at a speakable pace. Photos are unaffected.
  var MAX_VIDEO_SECONDS = 90;

  // Teleprompter state. Populated from window.INICIO_VIDEO_PROMPTS, which the
  // video capture screen sets from the study's own questionnaire. Absent on
  // ordinary photo questions, in which case none of this renders.
  var prompts = [];

  var stream = null;
  var mediaRecorder = null;
  var recordedChunks = [];
  var recordedBlob = null;
  var capturedPhotoBlob = null;
  var recording = false;
  var timerInterval = null;
  var recordSeconds = 0;
  var current = null;

  var modal, videoPreview, photoPreview, videoPlayback, permissionMsg, timerEl,
    shutterBtn, retakeBtn, useBtn, closeBtn, retryPermBtn, titleEl, canvas,
    prompterEl, prompterListEl;

  // The whole list stays on screen for the length of the recording. Stepping
  // through prompts one at a time meant the respondent had to keep tapping
  // mid-sentence; they would rather see everything and talk through it.
  function renderPrompts() {
    if (!prompts.length) return;
    prompterListEl.innerHTML = "";
    prompts.forEach(function (p, i) {
      var li = document.createElement("li");
      li.className = "flex gap-2";
      li.innerHTML = '<span class="text-white/50 tabular-nums">' + (i + 1) + '.</span><span></span>';
      li.lastChild.textContent = p.text;
      prompterListEl.appendChild(li);
    });
  }

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
      "    <span>Camera access is needed to capture this. Please allow camera access for Inicio Diary, then try again.</span>" +
      '    <button type="button" id="camRetryPermBtn" class="border border-white/40 rounded-lg px-4 py-2 text-sm text-white">Try again</button>' +
      "  </div>" +
      '  <div id="camTimer" class="hidden absolute top-3 left-1/2 -translate-x-1/2 bg-red-600 text-white text-xs font-semibold rounded-full px-3 py-1">0:00</div>' +
      // Sits over the preview rather than beside it: on a phone there is no
      // room beside, and the respondent is looking at the camera anyway.
      '  <div id="camPrompter" class="hidden absolute left-0 right-0 bottom-0 p-4 bg-gradient-to-t from-black/85 to-transparent">' +
      '    <div class="text-white/60 text-[11px] font-semibold uppercase tracking-wide mb-1.5">Talk through these</div>' +
      '    <ol id="camPrompterList" class="space-y-1 text-white text-sm font-medium leading-snug max-h-52 overflow-y-auto"></ol>' +
      "  </div>" +
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
    prompterEl = modal.querySelector("#camPrompter");
    prompterListEl = modal.querySelector("#camPrompterList");
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
    var preferredFacingMode = current && current.kind === "video" ? "user" : "environment";
    var constraints = {
      video: { facingMode: { ideal: preferredFacingMode } },
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
    // Only video mode has a script; a photo question never shows the prompter.
    prompts = kind === "video" && Array.isArray(window.INICIO_VIDEO_PROMPTS)
      ? window.INICIO_VIDEO_PROMPTS
      : [];
    titleEl.textContent = kind === "video" ? "Record with front camera" : "Take a photo";
    resetVisualState();
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    startStream();
  }

  function closeModal() {
    if (recording && mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
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
    var candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function onShutter() {
    if (current.kind === "photo") capturePhoto();
    else if (!recording) startRecording();
    else stopRecording();
  }

  function capturePhoto() {
    canvas.width = videoPreview.videoWidth || 1280;
    canvas.height = videoPreview.videoHeight || 720;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(videoPreview, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(function (blob) {
      capturedPhotoBlob = blob;
      photoPreview.src = URL.createObjectURL(blob);
      videoPreview.classList.add("hidden");
      photoPreview.classList.remove("hidden");
      shutterBtn.classList.add("hidden");
      retakeBtn.classList.remove("hidden");
      useBtn.classList.remove("hidden");
    }, "image/jpeg", 0.87);
  }

  function startRecording() {
    var mimeType = pickVideoMimeType();
    try {
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      permissionMsg.querySelector("span").textContent = "Video recording isn't supported on this device.";
      permissionMsg.classList.remove("hidden");
      return;
    }
    // The prompter appears only once recording is actually running, so the
    // respondent reads the first question and speaks -- rather than reading it
    // before the camera is live and repeating themselves.
    if (prompts.length) {
      renderPrompts();
      prompterEl.classList.remove("hidden");
    }
    recordedChunks = [];
    mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
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
    if (prompterEl) prompterEl.classList.add("hidden");
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }

  function onRetake() {
    resetVisualState();
    videoPreview.srcObject = stream;
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
    } else return;

    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {}
    if (labelEl) labelEl.textContent = statusText;
    closeModal();

    // Send it now, in the background, while the respondent carries on
    // answering. By the time they press Submit the bytes are already on the
    // server and the submit carries only the answers. Failure here is not
    // fatal: the file stays on the form input and goes the old, slow way.
    stageInBackground(file, input, labelEl, statusText);
  }

  /**
   * Upload one captured file straight away.
   *
   * XHR rather than fetch because fetch still has no upload-progress event,
   * and a progress number is the entire point -- a respondent staring at a
   * silent screen is the reason entries got logged three times.
   */
  function stageInBackground(file, input, labelEl, doneText) {
    var form = input && input.form;
    var token = window.INICIO_RESPONDENT_TOKEN;
    if (!form || !token) return;

    var qid = (input.name || "").replace(/^\w+_q_/, "");
    var fd = new FormData();
    fd.append("file", file);
    if (qid) fd.append("question_id", qid);

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/r/" + token + "/media/stage");
    xhr.upload.onprogress = function (e) {
      if (!labelEl || !e.lengthComputable) return;
      labelEl.textContent = "Uploading… " + Math.round((e.loaded / e.total) * 100) + "%";
    };
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return;
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
      if (!data.staged_id) return;

      // The staged id replaces the file on submit. The input is cleared so the
      // same bytes are not uploaded a second time.
      var hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = "_staged_media";
      hidden.value = data.staged_id;
      hidden.setAttribute("data-staged-for", input.name || "");
      var prior = form.querySelector('input[name="_staged_media"][data-staged-for="' + (input.name || "") + '"]');
      if (prior) prior.remove();
      form.appendChild(hidden);
      try { input.value = ""; } catch (e) {}
      if (labelEl) labelEl.textContent = doneText;
    };
    xhr.onerror = function () {
      // Leave the file on the input; the submit will carry it the slow way.
      if (labelEl) labelEl.textContent = doneText;
    };
    xhr.send(fd);
  }

  window.openCameraCapture = function (kind, targetInputId, labelElId) {
    var input = document.getElementById(targetInputId);
    var labelEl = labelElId ? document.getElementById(labelElId) : null;
    if (!input) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("This device doesn't support live camera capture in Inicio Diary.");
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
