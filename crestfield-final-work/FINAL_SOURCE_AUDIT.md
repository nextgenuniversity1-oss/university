# Crestfield University Management System — Final Source Audit

## Source changes completed in this pass

1. **Staff activation:** Super Admin staff creation creates a `PENDING` account and sends a single-use activation link. The token is random, only its SHA-256 hash is stored, and expiry is 24 hours. Invitees set their own password (minimum 12 characters). If initial invitation delivery fails, the new account is removed rather than left active or usable.
2. **Password reset:** The Super Admin reset action sends a password-reset activation link instead of revealing a temporary password. Existing sessions are revoked. If email delivery fails, the previous account status and activation state are restored.
3. **Activation UI and throttling:** `/activate-account?token=...` has a password-setting page. The public activation endpoint has a rate limit.
4. **Initial lecturer recruitment:** Registrar-authorized vacancies can explicitly opt into initial recruitment. If and only if no active HOD is appointed for the department, the Registrar may record a bootstrap review exception. The Registrar's final hiring decision remains a separate action. The vacancy flag is copied into candidate application data for the interface.
5. **Staff ID issuance:** Offer acceptance now generates the Staff ID inside the existing MongoDB transaction, together with the lecturer role transition. The old manual generation endpoint returns `410 Gone`; the UI no longer offers a generate button. An audit event and administrative notifications are emitted after acceptance.
6. **Profiles:** Added editable phone, residential address and emergency-contact fields. The server validates and persists only these permitted fields. Role, institutional ID and account status are not editable through the profile form. Profile picture persistence remains in place.
7. **Permissions:** Pending accounts cannot be activated by manually changing status to `ACTIVE`. Lecturer accounts cannot be created or reclassified through generic staff-role management.
8. **Configuration guidance:** SMTP requirements and the client-origin activation-link requirement are documented in the server environment example.

## Static checks performed

- Parsed the root, client and server `package.json` files as JSON.
- Checked that required activation, invitation, profile, recruitment-bootstrap and automatic Staff ID source markers are present.
- Checked that the generic staff creation route does not accept a creator-supplied password or return a temporary password.
- Checked that the frontend no longer offers manual Staff ID generation or displays a temporary-password panel.
- Checked the ZIP archive after packaging.

## Not performed

As instructed, dependencies were not installed and the application was not run. No TypeScript build, unit tests, browser tests, MongoDB transaction tests, SMTP delivery test, Cloudinary test or Paystack integration test was run. Therefore, this is a **source-level implementation pass, not an end-to-end or production-readiness certification**.

## Required before production

- Run frontend and backend type-check/build and repair any errors.
- Add automated integration tests for invitation expiry/single use, failed email delivery, initial recruitment exception enforcement, HOD routing, concurrent Staff ID issuance and profile field authorization.
- Verify that MongoDB is deployed as a replica set/sharded cluster supporting transactions.
- Configure and test SMTP, Cloudinary, Paystack and production `CLIENT_ORIGIN`.
- Review legacy accounts and any already-issued offers before migration, because older candidate applications may not contain the `vacancyInitialRecruitmentMode` field.
- Complete a security review of every role-specific endpoint and workflow before production deployment.
