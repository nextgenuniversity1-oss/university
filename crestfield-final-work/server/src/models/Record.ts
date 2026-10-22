import mongoose, { Schema } from 'mongoose';
const recordSchema = new Schema({
  module: { type: String, required: true, index: true },
  title: { type: String, required: true, trim: true },
  status: { type: String, default: 'DRAFT', index: true },
  reference: { type: String, index: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  data: { type: Schema.Types.Mixed, default: {} },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
recordSchema.index({ module: 1, reference: 1 }, { unique: true, sparse: true });
export const RecordModel = mongoose.model('Record', recordSchema);
