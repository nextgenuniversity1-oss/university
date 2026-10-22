import { createHash, randomBytes } from 'node:crypto';

export const ACTIVATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function createActivationToken(now = new Date()) {
  const rawToken = randomBytes(32).toString('base64url');
  return {
    rawToken,
    tokenHash: createHash('sha256').update(rawToken).digest('hex'),
    expiresAt: new Date(now.getTime() + ACTIVATION_TOKEN_TTL_MS),
  };
}

export function createActivationConsumptionUpdate(rawToken: string, passwordHash: string, now = new Date()) {
  return {
    filter: {
      activationTokenHash: createHash('sha256').update(rawToken).digest('hex'),
      activationExpiresAt: { $gt: now },
      status: 'PENDING',
    },
    update: {
      $set: { passwordHash, status: 'ACTIVE', mustChangePassword: false },
      $unset: { activationTokenHash: 1, activationExpiresAt: 1 },
    },
  };
}