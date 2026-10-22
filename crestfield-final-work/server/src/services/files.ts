import fs from 'node:fs/promises';
import path from 'node:path';
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './private-uploads');
export async function ensurePrivateUploadDirectory() {
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.chmod(uploadDir, 0o700).catch(() => undefined);
}
export function getPrivateUploadRoot() { return uploadDir; }
// Keep uploaded files outside the public web root; add malware scanning, size/type validation and access checks before accepting production uploads.
