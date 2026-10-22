import mongoose, { Schema } from 'mongoose';
export const ROLES = ['SUPER_ADMIN','REGISTRAR','BURSARY','HOSTEL_ADMIN','ADMISSION_OFFICER','LECTURER','LECTURER_HOD','APPLICANT','ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT','STUDENT'] as const;
export type Role = typeof ROLES[number];
const userSchema = new Schema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true, default: 'APPLICANT' },
  status: { type: String, enum: ['ACTIVE','SUSPENDED','PENDING'], default: 'ACTIVE' },
  matricNumber: { type: String, unique: true, sparse: true }, staffId: { type: String, unique: true, sparse: true, trim: true }, staffIdGeneratedAt: Date, appointmentDepartment: { type: String, trim: true }, admissionSession: { type: String, trim: true }, department: String, faculty: String,
  hodScope: { type: Boolean, default: false }, // HOD is an appointment on a lecturer account, not a separate identity
  mustChangePassword: { type: Boolean, default: true },
  tokenVersion: { type: Number, default: 0 }, // increment to revoke every outstanding JWT session
  profileImageUrl: { type: String, default: '' },
  profileImagePublicId: { type: String, default: '' },
  phoneNumber: { type: String, trim: true, maxlength: 30, default: '' },
  residentialAddress: { type: String, trim: true, maxlength: 300, default: '' },
  emergencyContactName: { type: String, trim: true, maxlength: 120, default: '' },
  emergencyContactPhone: { type: String, trim: true, maxlength: 30, default: '' },
  emergencyContactRelationship: { type: String, trim: true, maxlength: 60, default: '' },
  activationTokenHash: { type: String, select: false },
  activationExpiresAt: { type: Date, select: false },
  preferences: {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    notifications: { type: String, enum: ['email', 'in_app'], default: 'email' },
  },
}, { timestamps: true });
export const User = mongoose.model('User', userSchema);
