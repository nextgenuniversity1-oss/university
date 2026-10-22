# Head of Department (additional lecturer scope)

This folder owns the **Head of Department (additional lecturer scope)** portal configuration and role-specific UI. The role is governed by server-side authorization; hiding a link is not an access-control boundary.

## Scope

Departmental review and recommendations layered onto the lecturer account; not a separate base identity.

## Shared services

- API client: `../../api.ts`
- Shared components and identity: `../../shared/`
- Server permission enforcement: `../../../server/src/middleware/auth.ts`

Role-specific workflows should call authenticated API endpoints and must never perform approvals only in the browser.
