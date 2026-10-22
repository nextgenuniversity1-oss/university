import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryCleanup } from '../models/CloudinaryCleanup.js';
import { env } from '../config/env.js';

export async function queueCloudinaryCleanup(asset: { publicId: string; resourceType?: string; deliveryType?: string }) {
  if (!asset.publicId) return;
  try {
    await CloudinaryCleanup.updateOne(
      { publicId: asset.publicId },
      { $setOnInsert: { publicId: asset.publicId, resourceType: asset.resourceType || 'image', deliveryType: asset.deliveryType || 'authenticated', nextAttemptAt: new Date() } },
      { upsert: true },
    );
  } catch (error: any) {
    // Duplicate-key races are harmless because publicId is the idempotency key.
    if (error?.code !== 11000) throw error;
  }
}

export async function destroyCloudinaryAsset(asset: { publicId: string; resourceType?: string; deliveryType?: string }) {
  try {
    cloudinary.config({ cloud_name: env.cloudinaryCloudName, api_key: env.cloudinaryApiKey, api_secret: env.cloudinaryApiSecret, secure: true });
    const result = await cloudinary.uploader.destroy(asset.publicId, {
      resource_type: asset.resourceType || 'image', type: asset.deliveryType || 'authenticated', invalidate: true,
    });
    if (result.result === 'ok' || result.result === 'not found') return true;
    throw new Error(`Cloudinary delete returned ${result.result}`);
  } catch (error) {
    await queueCloudinaryCleanup(asset).catch(queueError => console.error('Could not queue Cloudinary cleanup:', queueError));
    return false;
  }
}

export async function retryCloudinaryCleanup() {
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) return;
  cloudinary.config({ cloud_name: env.cloudinaryCloudName, api_key: env.cloudinaryApiKey, api_secret: env.cloudinaryApiSecret, secure: true });
  const jobs = await CloudinaryCleanup.find({ nextAttemptAt: { $lte: new Date() } }).sort({ nextAttemptAt: 1 }).limit(50);
  for (const job of jobs) {
    try {
      const result = await cloudinary.uploader.destroy(job.publicId, {
        resource_type: job.resourceType || 'image', type: job.deliveryType || 'authenticated', invalidate: true,
      });
      if (result.result === 'ok' || result.result === 'not found') await job.deleteOne();
      else throw new Error(`Cloudinary delete returned ${result.result}`);
    } catch (e) {
      job.attempts += 1;
      job.lastError = e instanceof Error ? e.message.slice(0, 500) : 'Unknown Cloudinary cleanup error';
      job.nextAttemptAt = new Date(Date.now() + Math.min(24 * 60 * 60 * 1000, 60_000 * (2 ** Math.min(job.attempts, 10))));
      await job.save();
    }
  }
}
