import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from './models/User.js';
import { SystemSetting } from './models/SystemSetting.js';
import { env } from './config/env.js';
import authRoutes from './routes/auth.js';
import applicationRoutes, { expireOffers } from './routes/applications.js';
import recordRoutes from './routes/records.js';
import dashboardRoutes from './routes/dashboard.js';
import notificationRoutes from './routes/notifications.js';
import paymentRoutes from './routes/payments.js';
import auditRoutes from './routes/audit.js';
import profileRoutes from './routes/profile.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import registrarRoutes from './routes/registrar.js';
import workflowRoutes from './routes/workflows.js';
import hostelRoutes from './routes/hostels.js';
import lecturerRoutes from './routes/lecturers.js';
import { retryCloudinaryCleanup } from './services/cloudinaryCleanup.js';
import { processEmailOutbox } from './services/notifications.js';
import { ensurePrivateUploadDirectory } from './services/files.js';
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.clientOrigin, credentials: true }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/activate-account', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.get('/api/health', (_req,res) => res.json({ status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', service:'Crestfield University Management System API', timestamp:new Date().toISOString() }));
app.use('/api/auth', authRoutes);
// Global maintenance gate for every API module mounted after authentication.
// Health and auth endpoints remain available; Super Admin can still sign in and administer recovery.
app.use('/api', async (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  try {
    const row = await SystemSetting.findOne({ key: 'general' }).lean();
    const settings = (row?.value || {}) as { maintenanceMode?: boolean };
    if (!settings.maintenanceMode) return next();
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(header.slice(7), env.jwtSecret) as { sub: string };
        const actor = await User.findById(payload.sub).select('role status');
        if (actor?.status === 'ACTIVE' && actor.role === 'SUPER_ADMIN') return next();
      } catch { /* Authentication middleware will return the proper session error below. */ }
    }
    return res.status(503).json({ message: 'Crestfield University is temporarily in maintenance mode. Please try again later.' });
  } catch (error) { next(error); }
});
app.use('/api/profile', profileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/registrar', registrarRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/hostels', hostelRoutes);
app.use('/api/lecturers', lecturerRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/records', recordRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/audit', auditRoutes);
app.use((req,res) => res.status(404).json({ message:`Route not found: ${req.method} ${req.path}` }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const error = err as { name?: string; message?: string; issues?: unknown; status?: number };
  if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return res.status(error.status).json({ message: error.message || 'The request could not be completed.' });
  if (error.name === 'MulterError') return res.status(400).json({ message: 'The image could not be uploaded. Make sure it is under 5 MB.' });
  if (error.name === 'ZodError') return res.status(400).json({ message:'Please check the information you entered.', details:error.issues });
  if (error.name === 'ValidationError') return res.status(400).json({ message:error.message });
  if (error.name === 'VersionError') return res.status(409).json({ message:'This record changed while you were working. Refresh it and retry the action; no conflicting update was applied.' });
  if (error.name === 'CastError') return res.status(400).json({ message:'Invalid record identifier.' });
  console.error(err);
  res.status(500).json({ message: env.nodeEnv === 'production' ? 'Something went wrong. Please try again.' : error.message || 'Internal server error.' });
});
async function start() {
  await mongoose.connect(env.mongoUri);
  await bootstrapSuperAdmin();
  await ensurePrivateUploadDirectory();
  // Retry failed deletion of superseded profile images automatically.
  setInterval(() => { void retryCloudinaryCleanup().catch(error => console.error('Cloudinary cleanup retry failed:', error)); }, 5 * 60 * 1000).unref();
  setInterval(() => { void processEmailOutbox().catch(error => console.error('Email outbox processing failed:', error)); }, 30 * 1000).unref();
  // Expire issued offers on a schedule, not only when a staff member opens the admissions dashboard.
  setInterval(() => { void expireOffers().catch(error => console.error('Admission offer expiry failed:', error)); }, 60 * 1000).unref();
  void expireOffers().catch(error => console.error('Initial admission offer expiry failed:', error));
  void processEmailOutbox().catch(error => console.error('Initial email outbox processing failed:', error));
  app.listen(env.port, () => console.log(`UMS API running at http://localhost:${env.port}`));
}
start().catch(error => { console.error('Could not start UMS API:', error); process.exit(1); });

async function bootstrapSuperAdmin() {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('No bootstrap Super Admin configured. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD before first production launch.');
    return;
  }
  if (password.length < 13) throw new Error('SUPER_ADMIN_PASSWORD must be at least 14 characters.');
  const existing = await User.findOne({ role: 'SUPER_ADMIN' }).select('_id');
  if (existing) return;
  if (await User.exists({ email })) throw new Error('SUPER_ADMIN_EMAIL is already used by a non-Super-Admin account.');
  await User.create({ fullName: 'System Super Administrator', email, passwordHash: await bcrypt.hash(password, 12), role: 'SUPER_ADMIN', status: 'ACTIVE', mustChangePassword: true });
  console.log('Bootstrap Super Admin created. Remove SUPER_ADMIN_PASSWORD from the environment after securely storing it.');
}
