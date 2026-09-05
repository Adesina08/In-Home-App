// Extracts the audio track from a video file so it can be sent to Azure AI
// Speech. Video mode records the respondent talking to the front camera, and
// until now that speech was thrown away: only sampled frames were analysed.
//
// Same approach as ffmpegFrames.js -- the self-contained `ffmpeg-static`
// binary, so no system ffmpeg is needed on Azure App Service.

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// 16 kHz mono PCM WAV: what the speech API wants, and small enough that a
// 45-second clip stays well under any request limit.
//
// Returns { file, cleanup } -- callers MUST call cleanup() in a finally block.
// Rejects when the video has no audio track at all, which ffmpeg reports as a
// stream-mapping failure; the caller treats that as "no speech signal" rather
// than an error, since a silent video is a legitimate submission.
function extractAudio(videoPath, { maxSeconds = 120 } = {}) {
  return new Promise((resolve, reject) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "inicio-audio-"));
    const outFile = path.join(outDir, "audio.wav");
    const cleanup = () => {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    };
    const args = [
      "-y",
      "-i", videoPath,
      "-vn",                    // drop the video stream
      "-ac", "1",               // mono
      "-ar", "16000",           // 16 kHz
      "-t", String(maxSeconds), // hard cap, so an oversized upload can't stall the request
      "-f", "wav",
      outFile,
    ];
    execFile(ffmpegPath, args, { timeout: 30000 }, (err) => {
      if (err) {
        cleanup();
        return reject(new Error(`ffmpeg audio extraction failed: ${err.message}`));
      }
      if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) {
        cleanup();
        return reject(new Error("No usable audio track in this video."));
      }
      resolve({ file: outFile, cleanup });
    });
  });
}

module.exports = { extractAudio };
