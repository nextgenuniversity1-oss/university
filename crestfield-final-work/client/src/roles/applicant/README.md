# Applicant

This folder owns the **Applicant** portal configuration and role-specific UI. The role is governed by server-side authorization; hiding a link is not an access-control boundary.

## Scope

UTME application, required documents, application status, clarification requests and official offer notices.

## Shared services

- API client: `../../api.ts`
- Shared components and identity: `../../shared/`
- Server permission enforcement: `../../../server/src/middleware/auth.ts`

Role-specific workflows should call authenticated API endpoints and must never perform approvals only in the browser.
