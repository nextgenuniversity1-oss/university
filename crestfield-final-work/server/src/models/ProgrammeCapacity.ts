import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  session: { type: String, required: true },
  programme: { type: String, required: true },
  capacity: { type: Number, required: true, min: 1 },
  reserved: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true });
schema.index({ session: 1, programme: 1 }, { unique: true });
export const ProgrammeCapacity = mongoose.model('ProgrammeCapacity', schema);
