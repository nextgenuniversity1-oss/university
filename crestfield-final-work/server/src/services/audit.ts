import { AuditLog } from '../models/AuditLog.js';
import type { Request } from 'express';

const SENSITIVE_KEY = /(password|passwordHash|token|secret|authorization|cookie|apiKey|apiSecret|documentBuffer|rawBody)/i;
function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactMetadata(item, depth + 1));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactMetadata(child, depth + 1);
  }
  return output;
}

/** Record security/workflow events without copying credentials or secrets into audit metadata. */
export async function audit(req: Request, action: string, resource?: string, resourceId?: string, metadata?: unknown) {
  try {
    await AuditLog.create({
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      action,
      resource,
      resourceId,
      ipAddress: req.ip,
      metadata: redactMetadata(metadata),
    });
  } catch (error) {
    // Audit failure is surfaced operationally; callers retain their existing workflow behavior.
    console.error('Audit event could not be stored', error instanceof Error ? error.message : 'Unknown error');
  }
}
