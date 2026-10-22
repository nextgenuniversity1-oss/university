# Finance Fee Schedules and Exceptions — Implementation Pass

## Implemented in source

- Added Bursary-only fee schedule proposals with code, session, amount and NGN currency.
- Added read access for Bursary, Registrar and Super Admin.
- Added Registrar-only approve/reject decisions requiring a reason and writing audit events. Only approved schedules can be used by the generic payment initializer.
- Changed `POST /api/payments/initialize` to accept `feeCode` and `session`, not a client-supplied amount or purpose. The amount is resolved from the approved server-side schedule.
- Added finance exception records for provider verification and signed-webhook amount/currency mismatches.
- Added a Bursary exception resolution endpoint with a required reason. Resolution records a review outcome but deliberately does not mark a payment as paid or issue a refund.
- Corrected root `install:all` to install root development dependencies, including `concurrently`, and aligned Express type definitions with Express 4.

## Routes added/changed

- `POST /api/payments/fee-schedules` — Bursary proposes a schedule.
- `GET /api/payments/fee-schedules` — Bursary, Registrar, Super Admin list schedules.
- `POST /api/payments/fee-schedules/:id/approve` — Registrar approves/rejects with a reason.
- `POST /api/payments/initialize` — now requires `{ feeCode, session }`; no arbitrary amount accepted.
- `GET /api/payments/exceptions` — Bursary, Registrar, Super Admin list exception records.
- `POST /api/payments/exceptions/:id/resolve` — Bursary records a reasoned review outcome.

## Important boundaries

- Application fees remain handled by the admissions policy workflow; hostel reservations remain handled by the hostel-specific workflow. This fee-schedule endpoint does not override either specialized workflow.
- This is a source-level implementation pass only. Dependencies were not installed and the application was not run or built, per instruction. Runtime, TypeScript compilation, provider integration, and end-to-end role testing remain outstanding.
- Finance exceptions require a human review. A `REFUND_REQUIRED` outcome is a recorded follow-up state, not an automatic refund.

## Follow-up implementation: Bursary/Registrar finance UI integration

The `/finance` route now renders `client/src/roles/bursary/FinanceWorkspace.tsx` for Bursary, Registrar, and Super Admin. The UI uses the existing `/api/payments/fee-schedules` and `/api/payments/exceptions` endpoints rather than generic free-form finance records.

- Bursary can submit fee proposals with code, amount, currency (NGN), session, and description.
- Registrar can approve or reject proposed schedules only after entering a decision reason.
- Bursary can record an investigation outcome and explanation for open finance exceptions.
- Super Admin has read-only visibility in this workspace; the UI does not expose fee approval or exception resolution controls to this role.
- UI text explicitly warns that recording an exception outcome does not itself mark a payment as paid or issue a refund.

Validation remained static only. No dependencies were installed and the application was not run or built.
