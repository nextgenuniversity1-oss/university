import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  eventKey: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: String, required: true, lowercase: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  status: { type: String, enum: ['PENDING','SENDING','SENT','SUPPRESSED','FAILED'], default: 'PENDING', index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastError: { type: String, default: '' },
  sentAt: Date,
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1 });
export const EmailOutbox = mongoose.model('EmailOutbox', schema);
