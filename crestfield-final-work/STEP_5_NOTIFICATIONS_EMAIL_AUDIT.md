# Step 5 — Notifications, Email Delivery and Audit Records

## Implemented in source

- Added a shared helper to publish an in-app notification and queue its corresponding email as one application-level operation.
- Email delivery remains asynchronous and is processed by the existing outbox worker.
- Transient email failures retry with bounded exponential backoff.
- After eight failed attempts, the email record is marked `FAILED`, and a durable `EMAIL_DELIVERY_EXHAUSTED` audit event is recorded for follow-up.
- Audit metadata is recursively redacted for credential and secret-like keys, with bounded recursion and collection sizes.
- Existing workflows already emit audit events and notifications for important admissions, hostel, lecturer recruitment, student workflow, finance, user administration, and academic actions.

## Not claimed as verified

- No SMTP server was contacted.
- No live database/outbox worker run was performed.
- No role-by-role notification recipient matrix was exercised.
- No dependencies were installed and no build/tests/app were run.
- The shared helper is available for remaining notification call sites to migrate; not every event has been converted to use it yet.

## Operational note

Staff should monitor `EmailOutbox` records with status `FAILED` and retry or resolve them through a controlled operational process. The application currently records the failure but does not expose a dedicated administrative retry UI.
