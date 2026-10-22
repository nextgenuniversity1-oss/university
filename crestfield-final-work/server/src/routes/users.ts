import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { User } from '../models/User.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { sendEmail } from '../services/email.js';
import { env } from '../config/env.js';
import { createAndDeliverStaffInvitation, isDuplicateStaffAccountError } from '../services/staffInvitation.js';
import { createActivationToken } from '../services/activationTokens.js';

const router = Router();
router.use(authenticate, allowRoles('SUPER_ADMIN'));
const staffRoles = ['REGISTRAR','BURSARY','HOSTEL_ADMIN','ADMISSION_OFFICER','LECTURER'] as const;

// Accounts are suspended/deactivated rather than deleted so academic and financial history keeps attribution.
router.get('/', async (req, res, next) => {
  try {
    const query = z.object({
      q: z.string().trim().max(120).optional(),
      role: z.string().trim().optional(),
      status: z.enum(['ACTIVE','SUSPENDED','PENDING']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(10).max(100).default(25),
    }).parse(req.query);
    const filter: Record<string, any> = {};
    if (query.q) filter.$or = [
      { fullName: { $regex: query.q, $options: 'i' } },
      { email: { $regex: query.q, $options: 'i' } },
      { role: { $regex: query.q, $options: 'i' } },
      { department: { $regex: query.q, $options: 'i' } },
      { faculty: { $regex: query.q, $options: 'i' } },
    ];
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    const [users, total, roles] = await Promise.all([
      User.find(filter).select('fullName email role status department appointmentDepartment faculty matricNumber staffId staffIdGeneratedAt mustChangePassword createdAt updatedAt').sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      User.countDocuments(filter),
      User.distinct('role'),
    ]);
    res.json({ users, total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit), roles: roles.sort() });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      fullName: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(254),
      role: z.enum(['REGISTRAR','BURSARY','HOSTEL_ADMIN','ADMISSION_OFFICER']),
      department: z.string().trim().max(120).optional(),
      faculty: z.string().trim().max(120).optional(),
    }).parse(req.body);
    const email = body.email.toLowerCase();
    if (await User.exists({ email })) return res.status(409).json({ message: 'An account with this email already exists.' });
    const { rawToken, tokenHash, expiresAt } = createActivationToken();
    const activationUrl = `${env.clientOrigin.replace(/\/+$/, '')}/activate-account?token=${encodeURIComponent(rawToken)}`;
    const invitation = await createAndDeliverStaffInvitation({
      createPending: async () => User.create({
        ...body, email, passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
        status: 'PENDING', mustChangePassword: true,
        activationTokenHash: tokenHash, activationExpiresAt: expiresAt,
      }),
      send: () => sendEmail(email, 'Activate your Crestfield University staff account',
        `Hello ${body.fullName},\n\nA Crestfield University Super Admin created your ${body.role.replaceAll('_',' ')} account. Use the secure link below to set your own password. This link expires in 24 hours and can only be used once.\n\n${activationUrl}\n\nIf you did not expect this invitation, contact the university. Do not forward this link.`),
      removePending: async user => (await User.deleteOne({ _id: user._id, activationTokenHash: tokenHash })).deletedCount === 1,
    });
    if (!invitation.delivered) {
      if (invitation.cleanupFailed) {
        console.error('Unsent staff invitation cleanup did not remove the pending account');
        return res.status(503).json({ code: 'INVITATION_CLEANUP_FAILED', message: 'Email delivery failed and automatic account cleanup needs administrator attention. Check server logs before retrying.' });
      }
      return res.status(503).json({ code: invitation.code, message: invitation.reason });
    }
    const user = invitation.record;
    await audit(req, 'STAFF_ACTIVATION_INVITED', 'User', user.id, { role: user.role, email: user.email });
    res.status(201).json({ message: 'Staff account created as pending. An activation link has been emailed; the staff member must set their own password within 24 hours.', user: {
      id: user.id, fullName: user.fullName, email: user.email, role: user.role,
      status: user.status, department: user.department, faculty: user.faculty, mustChangePassword: true,
    } });
  } catch (error) {
    if (isDuplicateStaffAccountError(error)) return res.status(409).json({ code: 'ACCOUNT_ALREADY_EXISTS', message: 'An account with this email already exists. Refresh the account list before retrying.' });
    next(error);
  }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    if (req.params.id === req.user!.id) return res.status(400).json({ message: 'You cannot suspend your own account.' });
    const body = z.object({ status: z.enum(['ACTIVE','SUSPENDED']) }).parse(req.body);
    const target = await User.findById(req.params.id).select('role status');
    if (!target) return res.status(404).json({ message: 'Account not found.' });
    if (target.role === 'SUPER_ADMIN') return res.status(403).json({ message: 'Super Admin accounts require the dedicated recovery procedure and cannot be suspended here.' });
    if (target.status === 'PENDING' && body.status === 'ACTIVE') return res.status(409).json({ message: 'Pending accounts must be activated through their single-use email link; they cannot be activated manually.' });
    const user = await User.findByIdAndUpdate(req.params.id, { $set: { status: body.status } }, { new: true, runValidators: true })
      .select('fullName email role status department faculty');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    await audit(req, body.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_REACTIVATED', 'User', user.id, { role: user.role });
    res.json({ message: `Account ${body.status === 'SUSPENDED' ? 'suspended' : 'reactivated'}.`, user });
  } catch (error) { next(error); }
});


router.patch('/:id/role', async (req, res, next) => {
  try {
    if (req.params.id === req.user!.id) return res.status(400).json({ message: 'You cannot change your own role.' });
    const body = z.object({ role: z.enum(staffRoles) }).parse(req.body);
    const user = await User.findById(req.params.id).select('fullName email role status department faculty');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    if (!staffRoles.includes(user.role as typeof staffRoles[number])) return res.status(400).json({ message: 'This account is not a staff account managed by this screen.' });
    if (user.role === 'SUPER_ADMIN') return res.status(403).json({ message: 'Super Admin privileges cannot be changed through staff role management.' });
    if (body.role === 'LECTURER' && user.role !== 'LECTURER') return res.status(403).json({ message: 'Lecturer accounts must be created through the approved recruitment and offer-acceptance workflow.' });
    if (user.role === 'LECTURER' && body.role !== 'LECTURER') return res.status(403).json({ message: 'Lecturer role changes must follow the formal recruitment and staff-separation workflow.' });
    const previousRole = user.role;
    user.role = body.role;
    await user.save();
    await audit(req, 'STAFF_ROLE_CHANGED', 'User', user.id, { previousRole, newRole: body.role });
    res.json({ message: `Role updated from ${previousRole} to ${body.role}.`, user });
  } catch (error) { next(error); }
});


router.post('/:id/revoke-sessions', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('fullName email role tokenVersion');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await audit(req, 'USER_SESSIONS_REVOKED', 'User', user.id, { role: user.role });
    res.json({ message: `All existing sessions for ${user.email} have been revoked. They must sign in again.` });
  } catch (error) { next(error); }
});

router.post('/:id/reset-password', async (req, res, next) => {
  try {
    if (req.params.id === req.user!.id) return res.status(400).json({ message: 'Use the account security flow to change your own password.' });
    const user = await User.findById(req.params.id).select('fullName email role status tokenVersion mustChangePassword +activationTokenHash +activationExpiresAt');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    if (user.role === 'SUPER_ADMIN') return res.status(403).json({ message: 'Super Admin password recovery must use the dedicated recovery procedure.' });
    const priorState = { status: user.status, tokenVersion: user.tokenVersion || 0, mustChangePassword: user.mustChangePassword, activationTokenHash: (user as any).activationTokenHash, activationExpiresAt: (user as any).activationExpiresAt };
    const { rawToken, tokenHash, expiresAt } = createActivationToken();
    const issuedTokenVersion = priorState.tokenVersion + 1;
    const activationUrl = `${env.clientOrigin.replace(/\/+$/, '')}/activate-account?token=${encodeURIComponent(rawToken)}`;
    const activationTokenFilter = priorState.activationTokenHash ? priorState.activationTokenHash : { $exists: false };
    const updatedUser = await User.findOneAndUpdate(
      { _id: user._id, status: priorState.status, tokenVersion: priorState.tokenVersion, activationTokenHash: activationTokenFilter },
      { $set: { status: 'PENDING', activationTokenHash: tokenHash, activationExpiresAt: expiresAt, mustChangePassword: true, tokenVersion: issuedTokenVersion } },
      { new: true },
    );
    if (!updatedUser) return res.status(409).json({ code: 'ACCOUNT_CHANGED', message: 'This account changed while the reset was being prepared. Refresh and retry.' });
    const sent = await sendEmail(user.email, 'Reset your Crestfield University account password', `Hello ${user.fullName},\n\nA password reset was requested by the university Super Admin. Set a new password using this single-use link within 24 hours:\n\n${activationUrl}\n\nIf you did not expect this, contact the university.`);
    if (!sent.delivered) {
      const restore = { status: priorState.status, mustChangePassword: priorState.mustChangePassword, tokenVersion: priorState.tokenVersion } as Record<string, unknown>;
      const unset: Record<string, 1> = {};
      if (priorState.activationTokenHash) restore.activationTokenHash = priorState.activationTokenHash; else unset.activationTokenHash = 1;
      if (priorState.activationExpiresAt) restore.activationExpiresAt = priorState.activationExpiresAt; else unset.activationExpiresAt = 1;
      const restored = await User.updateOne({ _id: user._id, status: 'PENDING', tokenVersion: issuedTokenVersion, activationTokenHash: tokenHash }, { $set: restore, $unset: unset });
      if (restored.matchedCount !== 1) {
        console.error('Failed password-reset email cleanup did not match the issued token');
        return res.status(503).json({ code: 'RESET_CLEANUP_FAILED', message: 'Email delivery failed and account recovery state needs administrator attention. Check server logs before retrying.' });
      }
      return res.status(503).json({ code: sent.code, message: sent.reason });
    }
    await audit(req, 'ACCOUNT_PASSWORD_RESET_INVITED', 'User', user.id, { role: user.role });
    res.json({ message: 'The account is pending reactivation until the user sets a new password from the email link.' });
  } catch (error) { next(error); }
});

export default router;
