# Security Specification (Phase 0: Payload-First Security TDD)

## 1. Data Invariants
1. Every emulated device document (`/devices/{deviceUid}`) has an immutable `ownerUid` matching `request.auth.uid`.
2. All subcollections under `/devices/{deviceUid}` (`status`, `calllog`, `messages`, `contacts`, `apps`) derive ownership via the Master Gate (`get(/databases/$(database)/documents/devices/$(deviceUid)).data.ownerUid == request.auth.uid`) AND enforce `ownerUid == request.auth.uid` on every document.
3. No user may read, list, create, update, or delete another user's device, battery status, call logs, SMS messages, contacts, or installed apps (PII isolation).
4. All document IDs (`deviceUid`, `statusId`, `callId`, `msgId`, `contactId`, `appId`) must satisfy `isValidId(id)` (`^[a-zA-Z0-9_\-]+$`, max 128 chars).
5. All writes require verified email (`request.auth.token.email_verified == true`), strict field key allowlisting (`hasAll` + `hasOnly` on create, `affectedKeys().hasOnly(...)` on update), type/range checks, and server-validated timestamps (`request.time`).

## 2. Dirty Dozen Attack Payloads (All Must Fail with PERMISSION_DENIED)
1. **Unauthenticated Read on `/devices/uid1/status/current`**: `request.auth == null` -> Denied.
2. **Cross-Tenant Device Read**: User B attempts `get` on `/devices/userA_device/contacts/c1` -> Denied by Master Gate & ownerUid check.
3. **Cross-Tenant List Scraping**: User B attempts `list` on `/devices/userA_device/calllog` without `ownerUid == request.auth.uid` -> Denied by `allow list` resource check.
4. **Identity Spoofing on Create**: User A tries creating `/devices/dev1` with `ownerUid: "userB"` -> Denied (`incoming().ownerUid == request.auth.uid`).
5. **Shadow / Ghost Field Injection**: User A creates `/devices/dev1/status/current` with extra field `isAdmin: true` -> Denied (`hasOnly(...)`).
6. **Owner Hijack on Update**: User A updates `/devices/dev1` changing `ownerUid` to `"userB"` -> Denied (`affectedKeys().hasOnly(...)` + immutability).
7. **Timestamp Forgery**: User A creates a call log with client-supplied `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` -> Denied.
8. **ID Poisoning**: User A writes to `/devices/bad$id..with..slashes` -> Denied (`isValidId`).
9. **Resource Exhaustion (1MB String)**: User A sends a 10,000-char `body` in `/devices/dev1/messages/m1` -> Denied (`body.size() <= 1000`).
10. **Out-of-Bounds Battery / Enum Poisoning**: User A sets `batteryLevel: 999` or `networkType: "HACKED"` -> Denied.
11. **Unverified Email Write**: Authenticated user with `email_verified: false` tries creating a contact -> Denied.
12. **Orphan Subcollection Write**: User A tries creating `/devices/nonexistent_device/calllog/c1` before parent `/devices/nonexistent_device` exists -> Denied (`get(...)` Master Gate).
