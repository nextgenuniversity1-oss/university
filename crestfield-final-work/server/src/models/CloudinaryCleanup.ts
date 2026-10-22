import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  publicId: { type: String, required: true, unique: true },
  resourceType: { type: String, enum: ['image','raw','video'], default: 'image' },
  deliveryType: { type: String, enum: ['authenticated','private','upload'], default: 'authenticated' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastError: { type: String, default: '' },
}, { timestamps: true });
export const CloudinaryCleanup = mongoose.model('CloudinaryCleanup', schema);
