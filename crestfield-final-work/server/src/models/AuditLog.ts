import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorEmail: String, action: { type: String, required: true },
  resource: String, resourceId: String, ipAddress: String,
  metadata: Schema.Types.Mixed,
}, { timestamps: true });
export const AuditLog = mongoose.model('AuditLog', schema);
