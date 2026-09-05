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
function extractFrames(videoPath, { everySeconds = 2, maxFrames = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "inicio-frames-"));
    const pattern = path.join(outDir, "frame-%03d.jpg");
    const args = ["-y", "-i", videoPath, "-vf", `fps=1/${everySeconds}`, "-frames:v", String(maxFrames), pattern];
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

module.exports = { extractFrames };
