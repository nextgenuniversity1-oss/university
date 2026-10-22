import mongoose, { Schema } from 'mongoose';

const documentSchema = new Schema({
  documentType: { type: String, required: true },
  publicId: { type: String, required: true },
  resourceType: { type: String, enum: ['image', 'raw'], required: true },
  format: { type: String, required: true },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  bytes: { type: Number, required: true },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

const offerSchema = new Schema({
  kind: { type: String, enum: ['PRIMARY', 'ALTERNATIVE'], required: true },
  programme: { type: String, required: true },
  status: { type: String, enum: ['ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED'], default: 'ISSUED' },
  issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  issuedAt: { type: Date, default: Date.now },
  acceptanceDeadline: { type: Date, required: true },
  eligibilityConfirmed: { type: Boolean, default: false },
  eligibilityReason: { type: String, default: '' },
  consentAt: Date,
}, { _id: true });

const decisionSchema = new Schema({
  outcome: { type: String, required: true },
  reason: { type: String, required: true },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  decidedByEmail: { type: String, required: true },
  decidedAt: { type: Date, default: Date.now },
  policyVersion: { type: String, required: true },
}, { _id: false });

const applicationSchema = new Schema({
  applicationNumber: { type: String, required: true, unique: true, index: true },
  applicantId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true },
  utmeNumber: { type: String, required: true, trim: true, uppercase: true },
  utmeScore: { type: Number, required: true, min: 0, max: 400 },
  firstChoiceCourse: { type: String, required: true, trim: true },
  faculty: { type: String, required: true, trim: true },
  session: { type: String, required: true, trim: true },
  applicationType: { type: String, enum: ['UTME'], default: 'UTME', immutable: true },
  status: { type: String, enum: ['SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION','READY_FOR_REVIEW','SCREENING_QUEUED','SCREENING_IN_PROGRESS','DECISION_PENDING','OFFERED','ALTERNATIVE_OFFERED','ACCEPTED','DECLINED','REJECTED','INELIGIBLE','UNSUCCESSFUL'], default: 'SUBMITTED', index: true },
  paymentStatus: { type: String, enum: ['UNPAID','VERIFIED'], default: 'UNPAID', index: true },
  paymentReference: { type: String, required: true, unique: true, sparse: true },
  applicationFeeNaira: { type: Number, required: true, min: 0 },
  documents: { type: [documentSchema], default: [] },
  documentChecklist: { type: Schema.Types.Mixed, default: {} },
  assignedOfficerId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  assignedOfficerEmail: String,
  reviewNote: String,
  clarificationRequest: String,
  eligibility: { type: String, enum: ['UNASSESSED','ELIGIBLE','INELIGIBLE','NEEDS_REVIEW'], default: 'UNASSESSED', index: true },
  eligibilityReason: String,
  screeningBatchId: { type: Schema.Types.ObjectId, ref: 'ScreeningBatch', index: true },
  screeningProcessedAt: Date,
  screeningRulesVersion: String,
  offers: { type: [offerSchema], default: [] },
  decisionHistory: { type: [decisionSchema], default: [] },
  submittedAt: { type: Date, default: Date.now },
  lastEditedAt: Date,
}, { timestamps: true, optimisticConcurrency: true });
applicationSchema.index({ applicantId: 1, session: 1 }, { unique: true });
// A JAMB/UTME registration number must not be reused across multiple accounts for the same session.
applicationSchema.index({ utmeNumber: 1, session: 1 }, { unique: true });
applicationSchema.index({ session: 1, status: 1, paymentStatus: 1, eligibility: 1, screeningBatchId: 1 });
export const Application = mongoose.model('Application', applicationSchema);
