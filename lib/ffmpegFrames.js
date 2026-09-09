// Samples still frames from a video file so it can be run through Azure AI
// Vision's image-analysis endpoint (which only accepts still images, not
// video). Used by brand detection on video evidence and by the video-mode
// field pre-fill provider.
//
// Uses the `ffmpeg-static` npm package, which ships a self-contained ffmpeg
// binary inside node_modules -- no system-level `apt-get install ffmpeg` is
// needed, which matters on Azure App Service Linux where the app doesn't get
// root/apt access outside of a custom container image.

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// Extracts up to `maxFrames` JPEG stills, one every `everySeconds` seconds,
// into a fresh temp directory. Returns the frame file paths plus a cleanup()
// to remove them -- callers MUST call cleanup() when done (in a finally
// block) so temp frames don't pile up on disk.
function probeDuration(videoPath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ["-hide_banner", "-i", videoPath], { timeout: 5000 }, (_error, _stdout, stderr) => {
      const match = String(stderr || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return resolve(null);
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    });
  });
}

function samplingInterval(duration, everySeconds, maxFrames) {
  if (!duration || duration <= everySeconds * maxFrames || maxFrames < 2) return everySeconds;
  return Math.max(everySeconds, (duration - 0.25) / (maxFrames - 1));
}

async function extractFrames(videoPath, { everySeconds = 2, maxFrames = 5 } = {}) {
  const duration = await probeDuration(videoPath);
  const interval = samplingInterval(duration, everySeconds, maxFrames);
  return new Promise((resolve, reject) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "inicio-frames-"));
    const pattern = path.join(outDir, "frame-%03d.jpg");
    // Select across the whole recording. The old fps=1/2 + maxFrames=5 path
    // inspected only roughly the first ten seconds of a 90-second diary.
    const select = `select=eq(n\\,0)+gte(t-prev_selected_t\\,${interval.toFixed(3)})`;
    const args = ["-y", "-i", videoPath, "-vf", select, "-fps_mode", "vfr", "-frames:v", String(maxFrames), pattern];
    execFile(ffmpegPath, args, { timeout: 20000 }, (err) => {
      if (err) {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        return reject(new Error(`ffmpeg frame extraction failed: ${err.message}`));
      }
      const files = fs
        .readdirSync(outDir)
        .filter((f) => f.endsWith(".jpg"))
        .sort()
        .map((f) => path.join(outDir, f));
      resolve({
        files,
        cleanup: () => {
          try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        },
      });
    });
  });
}

module.exports = { extractFrames, samplingInterval };
