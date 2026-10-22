import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Schema.Types.Mixed, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
export const SystemSetting = mongoose.model('SystemSetting', schema);
