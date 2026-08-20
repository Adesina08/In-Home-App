// Pluggable storage for uploaded diary media (photos/videos/voice notes).
// Local disk (default -- what this prototype has always used) or Azure Blob
// Storage (STORAGE_PROVIDER=azure_blob) for real hosting, where the app's
// local filesystem on Azure App Service isn't guaranteed to survive a
// restart/redeploy or to be shared across scaled-out instances. See the
// Azure Deployment Runbook and PRODUCTION_READINESS.md section B4.
//
// Respondent media can be identifiable (a photo of someone's kitchen, their
// face in a video, their voice), so the Blob path always uses a PRIVATE
// container and only ever hands out a short-lived signed (SAS) read URL,
// generated on demand -- never a permanent public link. Local mode is
// unauthenticated static file serving, same as before; that's acceptable for
// a sandboxed prototype but NOT for real respondent data, which is exactly
// why azure_blob is the recommended production setting.

const fs = require("fs");
const path = require("path");
const os = require("os");

const PROVIDER = process.env.STORAGE_PROVIDER || "local";
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const BLOB_PREFIX = "azureblob://";

let containerClient = null;
function getContainerClient() {
  if (containerClient) return containerClient;
  const { BlobServiceClient } = require("@azure/storage-blob");
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER || "media";
  if (!connStr) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING missing. Set it in App Settings (see the Azure Deployment Runbook) or leave STORAGE_PROVIDER=local."
    );
  }
  const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  containerClient = blobServiceClient.getContainerClient(containerName);
  return containerClient;
}

function generateReadSasUrl(blobName, expiryMinutes = 60) {
  const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require("@azure/storage-blob");
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
  const containerName = process.env.AZURE_STORAGE_CONTAINER || "media";
  if (!accountName || !accountKey) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_NAME / AZURE_STORAGE_ACCOUNT_KEY missing (needed to sign SAS URLs) -- see the Azure Deployment Runbook."
    );
  }
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const expiresOn = new Date(Date.now() + expiryMinutes * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    { containerName, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn },
    credential
  ).toString();
  return `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURIComponent(blobName)}?${sas}`;
}

// Call right after multer saves an uploaded file to its local temp path.
// Returns the value to store in `media.file_path`. In local mode this is a
// no-op passthrough (same behavior as before this file existed); in Blob
// mode the file is pushed to the private container and the local temp copy
// is removed.
async function persistUpload(multerFile) {
  if (PROVIDER !== "azure_blob") {
    return `/uploads/${multerFile.filename}`;
  }
  const client = getContainerClient();
  await client.createIfNotExists(); // no `access` option => private container
  const blockBlobClient = client.getBlockBlobClient(multerFile.filename);
  await blockBlobClient.uploadFile(multerFile.path, { blobHTTPHeaders: { blobContentType: multerFile.mimetype } });
  try { fs.unlinkSync(multerFile.path); } catch (e) { /* best-effort cleanup of the local temp copy */ }
  return `${BLOB_PREFIX}${multerFile.filename}`;
}

// Given a stored `file_path` ("/uploads/xxx" or "azureblob://xxx"), returns a
// Buffer of the file's bytes. Used by the AI providers, which need the raw
// bytes regardless of where the file actually lives.
async function readMediaBuffer(filePath) {
  if (filePath && filePath.startsWith(BLOB_PREFIX)) {
    const blobName = filePath.slice(BLOB_PREFIX.length);
    const client = getContainerClient();
    return await client.getBlockBlobClient(blobName).downloadToBuffer();
  }
  const localPath = path.join(UPLOAD_DIR, path.basename(filePath || ""));
  return fs.readFileSync(localPath);
}

// Given a stored `file_path`, guarantees a real path on THIS machine's local
// filesystem -- needed by ffmpeg, which operates on files, not buffers. For
// local storage this is a direct (zero-copy) passthrough; for Blob storage
// the bytes are downloaded to a temp file. Callers MUST call the returned
// cleanup() when done (temp files are only cleaned up for the Blob case, but
// calling cleanup() is always safe).
async function materializeLocalFile(filePath) {
  if (filePath && filePath.startsWith(BLOB_PREFIX)) {
    const buffer = await readMediaBuffer(filePath);
    const tmpPath = path.join(os.tmpdir(), `inicio-media-${Date.now()}-${path.basename(filePath)}`);
    fs.writeFileSync(tmpPath, buffer);
    return { path: tmpPath, cleanup: () => { try { fs.unlinkSync(tmpPath); } catch (e) { /* best effort */ } } };
  }
  return { path: path.join(UPLOAD_DIR, path.basename(filePath || "")), cleanup: () => {} };
}

// Given a stored `file_path`, returns a URL safe to put in an <a href> /
// <img src> right now: the plain "/uploads/..." path in local mode, or a
// freshly generated short-lived signed URL in Blob mode (never a permanent
// public link -- see the module comment above on why).
function getMediaUrl(filePath) {
  if (filePath && filePath.startsWith(BLOB_PREFIX)) {
    return generateReadSasUrl(filePath.slice(BLOB_PREFIX.length));
  }
  return filePath;
}

module.exports = { persistUpload, readMediaBuffer, materializeLocalFile, getMediaUrl, PROVIDER };
