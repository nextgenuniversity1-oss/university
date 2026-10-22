import type { EmailResult } from './email.js';

type InvitationOptions<T> = {
  createPending: () => Promise<T>;
  send: () => Promise<EmailResult>;
  removePending: (record: T) => Promise<boolean>;
};

export function isDuplicateStaffAccountError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
}

export async function createAndDeliverStaffInvitation<T>(options: InvitationOptions<T>): Promise<
  | { record: T; delivered: true }
  | { record: T; delivered: false; code: string; reason: string; cleanupFailed: boolean }
> {
  const record = await options.createPending();
  let delivery: EmailResult;
  try {
    delivery = await options.send();
  } catch {
    console.error('Staff invitation email failed before provider acceptance could be confirmed');
    delivery = { delivered: false, code: 'EMAIL_DELIVERY_FAILED', reason: 'The email could not be sent. Check the server logs for the diagnostic details.' };
  }
  if (delivery.delivered) return { record, delivered: true };

  let removed = false;
  try {
    removed = await options.removePending(record);
  } catch {
    console.error('Unsent staff invitation cleanup failed');
  }
  return { record, delivered: false, code: delivery.code, reason: delivery.reason, cleanupFailed: !removed };
}