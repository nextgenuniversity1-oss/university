import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from './config/env.js';
import { User } from './models/User.js';
async function seed() {
 await mongoose.connect(env.mongoUri);
 const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@university.local').toLowerCase();
 const password = process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe123!';
 const existing = await User.findOne({email});
 if (existing) console.log(`Super Admin already exists: ${email}`);
 else {
   await User.create({ fullName:'System Administrator', email, passwordHash:await bcrypt.hash(password,12), role:'SUPER_ADMIN', mustChangePassword:true });
   console.log(`Created Super Admin: ${email}`);
   console.log(`Temporary password: ${password}`);
   console.log('Change this password immediately and never use the default in production.');
 }
 await mongoose.disconnect();
}
seed().catch(e => { console.error(e); process.exit(1); });
