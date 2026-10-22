import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  title: { type: String, required: true }, message: { type: String, required: true },
  channel: { type: String, enum: ['IN_APP','EMAIL','SMS'], default: 'IN_APP' },
  readAt: Date, status: { type: String, default: 'QUEUED' },
}, { timestamps: true });
export const Notification = mongoose.model('Notification', schema);
