import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { audit } from '../services/audit.js';
import { CloudinaryCleanup } from '../models/CloudinaryCleanup.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(new Error('Use a JPG, PNG, or WebP image.'));
    cb(null, true);
  },
});
function configureCloudinary() {
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) {
    throw new Error('Profile picture storage is not configured. Add the Cloudinary environment variables on the server.');
  }
  cloudinary.config({ cloud_name: env.cloudinaryCloudName, api_key: env.cloudinaryApiKey, api_secret: env.cloudinaryApiSecret, secure: true });
}
function uploadImage(buffer: Buffer, userId: string): Promise<{secure_url:string; public_id:string}> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: 'crestfield-university/profile-images',
      public_id: `${userId}-${Date.now()}`,
      resource_type: 'image',
      overwrite: false,
      transformation: [{ width: 800, height: 800, crop: 'limit' }],
    }, (error, result) => {
      if (error || !result) return reject(error || new Error('Image upload failed.'));
      resolve({ secure_url: result.secure_url, public_id: result.public_id });
    });
    stream.end(buffer);
  });
}
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id).select('fullName email role profileImageUrl preferences department faculty matricNumber staffId mustChangePassword phoneNumber residentialAddress emergencyContactName emergencyContactPhone emergencyContactRelationship createdAt');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    res.json({ user });
  } catch (e) { next(e); }
});

router.patch('/details', authenticate, async (req, res, next) => {
  try {
    const body = z.object({
      phoneNumber: z.string().trim().max(30).optional().default(''),
      residentialAddress: z.string().trim().max(300).optional().default(''),
      emergencyContactName: z.string().trim().max(120).optional().default(''),
      emergencyContactPhone: z.string().trim().max(30).optional().default(''),
      emergencyContactRelationship: z.string().trim().max(60).optional().default(''),
    }).parse(req.body);
    const user = await User.findById(req.user!.id);
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    user.phoneNumber = body.phoneNumber;
    user.residentialAddress = body.residentialAddress;
    user.emergencyContactName = body.emergencyContactName;
    user.emergencyContactPhone = body.emergencyContactPhone;
    user.emergencyContactRelationship = body.emergencyContactRelationship;
    await user.save();
    await audit(req, 'PROFILE_DETAILS_UPDATED', 'User', user.id);
    res.json({ message: 'Your contact details have been saved.', user: {
      id: user.id, fullName: user.fullName, email: user.email, role: user.role,
      phoneNumber: user.phoneNumber, residentialAddress: user.residentialAddress,
      emergencyContactName: user.emergencyContactName, emergencyContactPhone: user.emergencyContactPhone,
      emergencyContactRelationship: user.emergencyContactRelationship,
      profileImageUrl: user.profileImageUrl, preferences: user.preferences,
    }});
  } catch (e) { next(e); }
});

router.patch('/preferences', authenticate, async (req, res, next) => {
  try {
    const preferences = z.object({
      theme: z.enum(['light', 'dark', 'system']),
      notifications: z.enum(['email', 'in_app']),
    }).parse(req.body);
    const user = await User.findByIdAndUpdate(req.user!.id, { $set: { preferences } }, { new: true })
      .select('fullName email role profileImageUrl preferences');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    await audit(req, 'PROFILE_PREFERENCES_UPDATED', 'User', user.id);
    res.json({ message: 'Preferences saved.', user });
  } catch (e) { next(e); }
});
router.post('/picture', authenticate, upload.single('picture'), async (req, res, next) => {
  let uploadedPublicId = '';
  let persisted = false;
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose a JPG, PNG, or WebP image under 5 MB.' });
    configureCloudinary();
    const user = await User.findById(req.user!.id).select('profileImageUrl profileImagePublicId fullName email role preferences');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    // Upload first. Keep the previous image if the new upload fails.
    const uploaded = await uploadImage(req.file.buffer, user.id);
    uploadedPublicId = uploaded.public_id;
    const oldPublicId = user.profileImagePublicId;
    user.profileImageUrl = uploaded.secure_url;
    user.profileImagePublicId = uploaded.public_id;
    await user.save();
    persisted = true;
    // Delete the previous Cloudinary asset only after MongoDB successfully points to the new one.
    if (oldPublicId && oldPublicId !== uploaded.public_id) {
      try { await cloudinary.uploader.destroy(oldPublicId, { resource_type: 'image', invalidate: true }); }
      catch (error) {
        // The replacement is already active; persist a retry job so the old asset is deleted automatically after transient provider failures.
        await CloudinaryCleanup.updateOne(
          { publicId: oldPublicId },
          { $setOnInsert: { publicId: oldPublicId }, $set: { nextAttemptAt: new Date(Date.now() + 60_000), lastError: error instanceof Error ? error.message.slice(0, 500) : 'Cloudinary delete failed' }, $inc: { attempts: 1 } },
          { upsert: true },
        );
      }
    }
    await audit(req, 'PROFILE_PICTURE_CHANGED', 'User', user.id);
    res.json({ message: 'Profile picture updated. Your previous picture has been replaced.', user: {
      id: user.id, fullName: user.fullName, email: user.email, role: user.role,
      profileImageUrl: user.profileImageUrl, preferences: user.preferences,
    }});
  } catch (e) {
    if (uploadedPublicId && !persisted) { try { configureCloudinary(); await cloudinary.uploader.destroy(uploadedPublicId); } catch {} }
    next(e);
  }
});
export default router;
