import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User, type Role } from '../models/User.js';
declare global { namespace Express { interface Request { user?: { id: string; email: string; role: Role; fullName: string; profileImageUrl?: string; preferences?: { theme: 'light'|'dark'|'system'; notifications: 'email'|'in_app' }; mustChangePassword?: boolean } } } } 
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ message: 'Sign in to continue.' });
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as { sub: string; tv?: number };
    const user = await User.findById(payload.sub).select('fullName email role status profileImageUrl preferences tokenVersion mustChangePassword');
    if (!user || user.status !== 'ACTIVE' || (payload.tv ?? 0) !== (user.tokenVersion ?? 0)) return res.status(401).json({ message: 'Account is unavailable.' });
    req.user = { id: user.id, email: user.email, role: user.role as Role, fullName: user.fullName, profileImageUrl: user.profileImageUrl || '', preferences: user.preferences as any, mustChangePassword: Boolean(user.mustChangePassword) };
    // A generated Staff ID or matriculation number triggers a mandatory password change. Enforce it on the server, not only in the UI.
    // The authenticated user may inspect their own auth state and submit the password change; all other protected routes are blocked.
    const isAuthRouter = req.baseUrl.endsWith('/auth');
    const allowedDuringForcedChange = isAuthRouter && ['/me', '/change-password'].includes(req.path);
    if (user.mustChangePassword && !allowedDuringForcedChange) {
      return res.status(403).json({ message: 'You must change your password before accessing the university portal.', code: 'PASSWORD_CHANGE_REQUIRED', mustChangePassword: true });
    }
    next();
  } catch { res.status(401).json({ message: 'Your session is invalid or expired. Please sign in again.' }); }
}
export const allowRoles = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) =>
  req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'You do not have permission to perform this action.' });
