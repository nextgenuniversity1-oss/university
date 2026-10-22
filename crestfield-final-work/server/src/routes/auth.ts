import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendEmail } from '../services/email.js';
import { createActivationConsumptionUpdate } from '../services/activationTokens.js';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Application } from '../models/Application.js';
import { SystemSetting } from '../models/SystemSetting.js';
import { AuditLog } from '../models/AuditLog.js';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
const router = Router();

// Public activation endpoint: only a SHA-256 token hash is stored, and activation is single-use.
router.post('/activate-account', async (req, res, next) => {
  try {
    const body = z.object({ token: z.string().min(32).max(256), newPassword: z.string().min(12).max(128) }).parse(req.body);
    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    const activation = createActivationConsumptionUpdate(body.token, passwordHash);
    const user = await User.findOneAndUpdate(
      activation.filter,
      activation.update,
      { new: true, runValidators: true },
    ).select('fullName email role');
    if (!user) return res.status(400).json({ message: 'This activation link is invalid, expired, or has already been used. Ask the Super Admin to send a new activation email.' });
    await AuditLog.create({ actorId: user.id, actorEmail: user.email, action: 'STAFF_ACCOUNT_ACTIVATED', resource: 'User', resourceId: user.id, ipAddress: req.ip, metadata: { role: user.role } });
    return res.json({ message: 'Your account is activated. You can now sign in with your email and new password.' });
  } catch (error) { next(error); }
});
router.post('/register', async (req, res, next) => {
  try {
    const body = z.object({ fullName: z.string().min(2), email: z.string().email(), password: z.string().min(10) }).parse(req.body);
    const settings = await SystemSetting.findOne({ key: 'general' }).lean();
    const general = (settings?.value || {}) as { allowApplicantRegistration?: boolean; maintenanceMode?: boolean };
    if (general.maintenanceMode) return res.status(503).json({ message: 'The portal is temporarily under maintenance. Please try again later.' });
    if (general.allowApplicantRegistration === false) return res.status(403).json({ message: 'Applicant registration is currently closed.' });
    const email = body.email.toLowerCase();
    if (await User.exists({ email })) return res.status(409).json({ message: 'An account with this email already exists.' });
    const user = await User.create({ fullName: body.fullName, email, passwordHash: await bcrypt.hash(body.password, 12), role: 'APPLICANT', mustChangePassword: false });
    return res.status(201).json({ message: 'Account created. You can now sign in.', user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role } });
  } catch (e) { next(e); }
});
router.post('/login', async (req, res, next) => {
  try {
    const body = z.object({ identifier: z.string().trim().min(1).max(254).optional(), email: z.string().trim().min(1).max(254).optional(), password: z.string().min(1).max(128) }).refine(v => Boolean(v.identifier || v.email), { message: 'Enter your login ID or email.' }).parse(req.body);
    const identifier = (body.identifier || body.email || '').trim();
    const normalized = identifier.toUpperCase();
    let user: any = null;

    // Generated identifiers take precedence and permanently replace the previous login identifier.
    // Staff: before Staff ID generation, email + application password; after generation, Staff ID + password only.
    const staffById = await User.findOne({ staffId: identifier }).select('+passwordHash');
    if (staffById) user = staffById;
    else {
      const staffByEmail = await User.findOne({ email: identifier.toLowerCase(), role: { $in: ['LECTURER','LECTURER_HOD'] }, staffId: { $in: [null, ''] } }).select('+passwordHash');
      if (staffByEmail) user = staffByEmail;
    }

    // Students use JAMB/UTME number until their matriculation number is generated.
    // Once matriculated, the JAMB identifier is rejected and only the matriculation number works.
    if (!user) {
      user = await User.findOne({ matricNumber: identifier }).select('+passwordHash');
    }
    if (!user) {
      const app = await Application.findOne({ utmeNumber: normalized }).sort({ createdAt: -1 }).select('applicantId');
      if (app) {
        const candidate = await User.findById(app.applicantId).select('+passwordHash');
        if (candidate && ['APPLICANT','ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT','STUDENT'].includes(candidate.role) && !candidate.matricNumber) user = candidate;
      }
    }
    // Other institutional roles and applicants without a submitted UTME application continue using email.
    if (!user && identifier.includes('@')) {
      const emailUser = await User.findOne({ email: identifier.toLowerCase(), role: { $nin: ['LECTURER','LECTURER_HOD'] }, staffId: { $in: [null, ''] } }).select('+passwordHash');
      // After a UTME application is submitted, the applicant/student must use JAMB number until matriculation.
      const hasApplication = emailUser ? await Application.exists({ applicantId: emailUser._id }) : false;
      if (emailUser && !hasApplication) user = emailUser;
    }

    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      await AuditLog.create({ actorEmail: identifier.includes('@') ? identifier.toLowerCase() : undefined, action: 'AUTH_LOGIN_FAILED', resource: 'User', ipAddress: req.ip, metadata: { reason: 'INVALID_CREDENTIALS_OR_REPLACED_IDENTIFIER' } }).catch(() => undefined);
      return res.status(401).json({ message: 'Login ID or password is incorrect. If your university ID has been generated, use that ID instead of your previous login identifier.' });
    }
    if (user.status !== 'ACTIVE') {
      await AuditLog.create({ actorId: user.id, actorEmail: user.email, action: 'AUTH_LOGIN_BLOCKED', resource: 'User', resourceId: user.id, ipAddress: req.ip, metadata: { reason: 'ACCOUNT_NOT_ACTIVE' } }).catch(() => undefined);
      return res.status(403).json({ message: 'Your account is not active. Contact the university administrator.' });
    }
    const token = jwt.sign({ tv: user.tokenVersion || 0 }, env.jwtSecret, { subject: user.id, expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
    await AuditLog.create({ actorId: user.id, actorEmail: user.email, action: 'AUTH_LOGIN', resource: 'User', resourceId: user.id, ipAddress: req.ip, metadata: { loginIdentifierType: user.staffId && identifier === user.staffId ? 'STAFF_ID' : user.matricNumber && identifier === user.matricNumber ? 'MATRIC_NUMBER' : identifier.includes('@') ? 'EMAIL' : 'UTME_NUMBER' } }).catch(() => undefined);
    return res.json({ token, user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword, staffId: user.staffId || undefined, matricNumber: user.matricNumber || undefined } });
  } catch (e) { next(e); }
});
router.get('/me', authenticate, async (req, res) => res.json({ user: req.user }));

router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(128) }).parse(req.body);
    const user = await User.findById(req.user!.id).select('+passwordHash fullName email role mustChangePassword');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) return res.status(400).json({ message: 'Current password is incorrect.' });
    if (await bcrypt.compare(body.newPassword, user.passwordHash)) return res.status(400).json({ message: 'Choose a password you have not used before.' });
    user.passwordHash = await bcrypt.hash(body.newPassword, 12);
    user.mustChangePassword = false;
    await user.save();
    await audit(req, 'PASSWORD_CHANGED', 'User', user.id);
    res.json({ message: 'Password changed successfully. You can continue to your portal.' });
  } catch (error) { next(error); }
});

export default router;
