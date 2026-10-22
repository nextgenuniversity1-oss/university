# Crestfield University Management System — Run Guide

This archive contains the available integrated source project: React/TypeScript frontend, Express/TypeScript backend, MongoDB/Mongoose models, role-protected API routes, workflow evaluators, and supporting email, payment, notification, file, audit, and PDF services.

## Requirements
- Node.js 20 or newer
- npm 10 or newer
- MongoDB running locally or a MongoDB Atlas connection

## First-time setup
1. Extract the ZIP and open the extracted `crestfield-final-work` folder in VS Code.
2. Copy `server/.env.example` to `server/.env`.
3. Set `MONGODB_URI` to your MongoDB connection string.
4. Set `JWT_SECRET` to a unique random value of at least 32 characters.
5. Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. Use a unique password of at least 14 characters. This first Super Admin is created on server startup if none exists. The app requires a database connection.
6. From the project root, run:

   ```bash
   npm install
   npm run install:all
   npm run build
   npm run dev
   ```

7. Open `http://localhost:5173`. The backend health endpoint is `http://localhost:4000/api/health`.

## Optional integrations
- Email invitations/activation require SMTP values in `server/.env`. For Gmail:
   1. Enable Google 2-Step Verification on the sending account.
   2. Create an App Password at `https://myaccount.google.com/apppasswords`; use it only for SMTP, not the normal Google password.
   3. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER` to the Gmail/Workspace account, `SMTP_PASSWORD` to the App Password, `SMTP_SECURE=false`, and `SMTP_FROM` to the same address or a verified Gmail “Send mail as” alias.
   4. Port 587 begins without implicit TLS and upgrades through STARTTLS. Port 465 instead requires `SMTP_SECURE=true` for implicit TLS.
   5. Restart the backend after changing `server/.env`; environment variables are loaded at process startup.
   6. From the project root, run `npm run email:verify --prefix server` for a safe terminal-only connection/authentication check, or sign in as Super Admin, open System Health, review the SMTP configuration warnings, and choose **Test SMTP connection**. Neither check sends a test email or proves recipient delivery. For a delivery test, create one staff invitation to an address you control and confirm the message arrives.
   7. Interpret sanitized diagnostic results: configuration errors name missing/invalid keys; authentication failures indicate the App Password/account; network/timeouts indicate DNS/firewall/reachability; TLS errors indicate the host/port/security pairing; sender/recipient/provider rejection indicates address restrictions or provider policy/rate limits. Check backend logs for safe SMTP codes; secrets and activation links are not logged.
- Paystack payments require a server-side `PAYSTACK_SECRET_KEY`.
- Cloudinary-backed uploads require Cloudinary credentials. Never put provider secrets in the frontend `.env`.

## Roles in the project
The backend role model includes Super Admin, Registrar, Admission Officer, Bursary, Hostel Administrator, Lecturer/HOD scope, Applicant, and student lifecycle roles. Access is enforced by backend middleware and route-level permission checks. HOD is intended to be an appointment/scope on a Lecturer account, not a separate identity.

## Important limitation
This is the integrated source foundation currently available, not a certified production university ERP. The presence of routes and UI modules does not mean every business workflow is fully completed or verified. No successful end-to-end test, external email delivery, Paystack transaction, or production deployment is claimed by this archive. Build and test locally; resolve errors before importing real institutional data or deploying publicly. Do not use the example credentials in production.
