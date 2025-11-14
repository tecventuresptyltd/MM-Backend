# Mystic Motors Clan System – Complete Reference

## Overview

The Mystic Motors Clan system enables players to form, manage, and participate in clans. This document details the Firestore schema, all Cloud Functions, and their contracts, covering every aspect of clan creation, membership, roles, requests, chat, and settings.

---

## Firestore Schema for Clans

### Core Collections

```
/Clans/{clanId}
  /Chat/{messageId}
  /Members/{uid}
  /Requests/{uid}
```

- **/Clans/{clanId}**: Main clan document, keyed by a unique clan ID.
- **/Clans/{clanId}/Chat/{messageId}**: Stores clan chat messages.
- **/Clans/{clanId}/Members/{uid}**: Each member’s data, keyed by their UID.
- **/Clans/{clanId}/Requests/{uid}**: Join requests for invite-only clans.

### Clan Document Fields

- `clanId`: Unique identifier.
- `clanName`: Display name.
- `clanTag`: Short tag for leaderboard and UI.
- `createdAt`: Timestamp.
- `leaderId`: UID of the current leader.
- `settings`: Public clan settings (e.g., open/invite-only, description, requirements).
- `members`: Map of member UIDs to their roles and join dates.
- `requests`: Map of pending join requests.

### Security

- Only authenticated users can read/write their own clan membership.
- Sensitive clan mutations (e.g., leader succession, member roles) are performed by Cloud Functions.
- Clan chat is public to members; requests and membership changes are server-authoritative.

---

## Clan Functionality – Cloud Function Contracts

### 1. Create Clan

**Function:** `createClan`

- **Purpose:** Creates a new clan.
- **Input:**
  ```json
  { "clanName": "string", "clanTag": "string" }
  ```
- **Output:**
  ```json
  { "success": true, "clanId": "string" }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### 2. Join Clan

**Function:** `joinClan`

- **Purpose:** Joins an open clan.
- **Input:**
  ```json
  { "clanId": "string" }
  ```
- **Output:**
  ```json
  { "success": true, "clanId": "string" }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### 3. Leave Clan

**Function:** `leaveClan`

- **Purpose:** Leaves the current clan, handling leader succession if needed.
- **Input:** `{}` (no parameters)
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `FAILED_PRECONDITION`

---

### 4. Invite to Clan

**Function:** `inviteToClan`

- **Purpose:** Invites a player to a clan.
- **Input:**
  ```json
  { "inviteeId": "string" }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `PERMISSION_DENIED`

---

### 5. Request to Join Clan

**Function:** `requestToJoinClan`

- **Purpose:** Requests to join a closed/invite-only clan.
- **Input:**
  ```json
  { "clanId": "string" }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### 6. Accept Join Request

**Function:** `acceptJoinRequest`

- **Purpose:** Accepts a pending join request.
- **Input:**
  ```json
  { "clanId": "string", "requesteeId": "string" }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`

---

### 7. Decline Join Request

**Function:** `declineJoinRequest`

- **Purpose:** Declines a pending join request.
- **Input:**
  ```json
  { "clanId": "string", "requesteeId": "string" }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`

---

### 8. Promote Clan Member

**Function:** `promoteClanMember`

- **Purpose:** Promotes a member to a higher role (e.g., officer, co-leader).
- **Input:**
  ```json
  { "clanId": "string", "memberId": "string" }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`

---

### 9. Demote Clan Member

**Function:** `demoteClanMember`

- **Purpose:** Demotes a member to a lower role.
- **Input:**
  ```json
  { "clanId": "string", "memberId": "string" }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `FAILED_PRECONDITION`

---

### 10. Kick Clan Member

**Function:** `kickClanMember`

- **Purpose:** Removes a member from the clan.
- **Input:**
  ```json
  { "clanId": "string", "memberId": "string" }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`

---

### 11. Update Clan Settings

**Function:** `updateClanSettings`

- **Purpose:** Updates a clan's public information (e.g., description, requirements).
- **Input:**
  ```json
  { "clanId": "string", "newSettings": {} }
  ```
- **Output:**
  ```json
  { "success": true }
  ```
- **Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`

---

## Additional Clan Features

### Clan Chat

- **Path:** `/Clans/{clanId}/Chat/{messageId}`
- **Functionality:** Members can send and read messages. Messages are timestamped and may include sender UID, display name, and content.

### Clan Membership

- **Path:** `/Clans/{clanId}/Members/{uid}`
- **Fields:** Role (leader, officer, member), join date, activity stats.

### Clan Requests

- **Path:** `/Clans/{clanId}/Requests/{uid}`
- **Fields:** Request date, status (pending, accepted, declined).

### Leader Succession

- When a leader leaves, the next eligible member (e.g., officer, longest-tenured) is promoted automatically.

### Permissions

- Only leaders/officers can invite, accept/decline requests, promote/demote, or kick members.
- Members can leave clans and send join requests.

---

## Error Handling

All clan-related functions return clear error codes for authentication, permission, argument validation, and precondition failures. See each function contract for details.

---

## Security & Best Practices

- All sensitive mutations are server-authoritative.
- Membership and role changes are validated for permissions.
- Clan chat and requests are only accessible to members.
- All IDs use opaque, consistent formats for security and scalability.

---

## Summary Table

| Function             | Purpose                        | Input Fields                | Output Fields         | Errors                       |
|----------------------|-------------------------------|-----------------------------|-----------------------|------------------------------|
| createClan           | Create a new clan              | clanName, clanTag           | success, clanId       | UNAUTHENTICATED, INVALID_ARGUMENT, FAILED_PRECONDITION |
| joinClan             | Join an open clan              | clanId                      | success, clanId       | UNAUTHENTICATED, INVALID_ARGUMENT, FAILED_PRECONDITION, NOT_FOUND |
| leaveClan            | Leave current clan             | (none)                      | success               | UNAUTHENTICATED, FAILED_PRECONDITION |
| inviteToClan         | Invite player to clan          | inviteeId                   | success               | UNAUTHENTICATED, INVALID_ARGUMENT, FAILED_PRECONDITION, PERMISSION_DENIED |
| requestToJoinClan    | Request to join closed clan    | clanId                      | success               | UNAUTHENTICATED, INVALID_ARGUMENT, FAILED_PRECONDITION |
| acceptJoinRequest    | Accept join request            | clanId, requesteeId         | success               | UNAUTHENTICATED, INVALID_ARGUMENT, PERMISSION_DENIED, NOT_FOUND |
| declineJoinRequest   | Decline join request           | clanId, requesteeId         | success               | UNAUTHENTICATED, INVALID_ARGUMENT, PERMISSION_DENIED |
| promoteClanMember    | Promote member                 | clanId, memberId            | success               | UNAUTHENTICATED, INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED |
| demoteClanMember     | Demote member                  | clanId, memberId            | success               | UNAUTHENTICATED, INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED, FAILED_PRECONDITION |
| kickClanMember       | Remove member                  | clanId, memberId            | success               | UNAUTHENTICATED, INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED |
| updateClanSettings   | Update clan info               | clanId, newSettings         | success               | UNAUTHENTICATED, INVALID_ARGUMENT, PERMISSION_DENIED |

---

## References

- See Firestore schema for document structure and security rules.
- See function contracts for API details and error codes.

---

**This README covers every aspect of Mystic Motors Clan functionality, including schema, API, permissions, and error handling. Use this as the canonical reference for development, integration, and documentation.**
