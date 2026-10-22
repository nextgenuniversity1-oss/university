import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  batchKey: { type: String, required: true, unique: true },
  session: { type: String, required: true, index: true },
  status: { type: String, enum: ['CREATED','PROCESSING','COMPLETED','FAILED'], default: 'CREATED' },
  applicationIds: [{ type: Schema.Types.ObjectId, ref: 'Application' }],
  count: { type: Number, default: 0 },
  rulesVersion: { type: String, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  completedAt: Date,
}, { timestamps: true });
export const ScreeningBatch = mongoose.model('ScreeningBatch', schema);
