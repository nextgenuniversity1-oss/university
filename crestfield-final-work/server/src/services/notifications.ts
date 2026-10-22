import { Notification } from '../models/Notification.js';
import { EmailOutbox } from '../models/EmailOutbox.js';
import { User } from '../models/User.js';
import { sendEmail } from './email.js';
import { AuditLog } from '../models/AuditLog.js';

export async function notify(userId: string, title: string, message: string) {
  // In-app notification is always stored so the user can see it in the portal.
  return Notification.create({ userId, title, message, channel: 'IN_APP', status: 'SENT' });
}

/** Deliver an important workflow update through in-app notifications and the email outbox. */
export async function publishWorkflowNotification(userId: string, eventKey: string, title: string, message: string) {
  const [inApp, email] = await Promise.all([
    notify(userId, title, message),
    queueEmailUserIfEnabled(userId, eventKey, title, message),
  ]);
  return { inApp, email };
}


/** Queue email with a stable event key so retried workflow requests do not create duplicate outbox rows. */
export async function queueEmailUserIfEnabled(userId: string, eventKey: string, subject: string, message: string) {
  const user = await User.findById(userId).select('email preferences');
  if (!user) return { queued: false, reason: 'USER_NOT_FOUND' };
  if (user.preferences?.notifications === 'in_app') {
    await EmailOutbox.updateOne({ eventKey }, { $setOnInsert: { eventKey, userId: user._id, recipient: user.email, subject, text: message, status: 'SUPPRESSED' } }, { upsert: true });
    return { queued: false, reason: 'USER_PREFERS_IN_APP_ONLY' };
  }
  try {
    await EmailOutbox.updateOne({ eventKey }, { $setOnInsert: { eventKey, userId: user._id, recipient: user.email, subject, text: message, status: 'PENDING', nextAttemptAt: new Date() } }, { upsert: true });
    return { queued: true };
  } catch (error: any) {
    if (error?.code === 11000) return { queued: true, idempotentReplay: true };
    throw error;
  }
}

/** At-least-once delivery: retry transient SMTP failures with bounded exponential backoff. */
export async function processEmailOutbox() {
  // Recover abandoned claims after a worker/process crash. SMTP is at-least-once, so a crash after provider acceptance may still result in a duplicate.
  await EmailOutbox.updateMany({ status: 'SENDING', updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }, { $set: { status: 'PENDING', nextAttemptAt: new Date() } });
  const jobs = await EmailOutbox.find({ status: 'PENDING', nextAttemptAt: { $lte: new Date() } }).sort({ nextAttemptAt: 1 }).limit(20);
  for (const job of jobs) {
    const claimed = await EmailOutbox.findOneAndUpdate({ _id: job._id, status: 'PENDING' }, { $set: { status: 'SENDING' } }, { new: true });
    if (!claimed) continue;
    const currentUser = await User.findById(claimed.userId).select('preferences');
    if (!currentUser || currentUser.preferences?.notifications === 'in_app') { claimed.status = 'SUPPRESSED'; await claimed.save(); continue; }
    const result = await sendEmail(claimed.recipient, claimed.subject, claimed.text);
    if (result.delivered) {
      claimed.status = 'SENT'; claimed.sentAt = new Date(); claimed.lastError = ''; await claimed.save();
    } else {
      claimed.attempts += 1;
      claimed.lastError = result.reason || 'Email delivery failed';
      if (claimed.attempts >= 8) {
        // Stop retrying indefinitely and preserve a durable operational record for staff follow-up.
        claimed.status = 'FAILED';
        await claimed.save();
        await AuditLog.create({
          action: 'EMAIL_DELIVERY_EXHAUSTED',
          resource: 'EmailOutbox',
          resourceId: String(claimed._id),
          metadata: { eventKey: claimed.eventKey, attempts: claimed.attempts, reason: claimed.lastError },
        }).catch(error => console.error('Email failure audit could not be stored', error instanceof Error ? error.message : 'Unknown error'));
      } else {
        claimed.status = 'PENDING';
        claimed.nextAttemptAt = new Date(Date.now() + Math.min(24 * 60 * 60 * 1000, 60_000 * (2 ** Math.min(claimed.attempts, 10))));
        await claimed.save();
      }
    }
  }
}
