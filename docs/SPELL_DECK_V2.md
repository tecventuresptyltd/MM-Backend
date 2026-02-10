    # V2 Spell Deck Functions - 3-Spell System

This document describes the new V2 spell deck functions that support 3 spells instead of the legacy 5-spell system.

## Overview

The V2 spell deck system is completely separate from the legacy system:
- **Legacy System**: 5 spells per deck, stored in `/Players/{uid}/SpellDecks/Decks`
- **V2 System**: 3 spells per deck, stored in `/Players/{uid}/SpellDecks/DecksV2`

## Functions

### setSpellDeckV2

Configure a spell deck with exactly 3 spells.

**Parameters:**
```typescript
{
  opId: string;      // Operation ID for idempotency
  deckNo: number;    // Deck number (0-based index, e.g., 0, 1, 2)
  spells: string[];  // Array of exactly 3 spell IDs
}
```

**Returns:**
```typescript
{
  success: boolean;
}
```

**Example Usage (from Unity/Client):**
```typescript
const result = await functions.httpsCallable('setSpellDeckV2')({
  opId: 'unique-operation-id-123',
  deckNo: 0,
  spells: ['fireSpell', 'iceSpell', 'lightningSpell']
});
```

**Validation:**
- Requires exactly 3 spells (not 2, not 4, not 5)
- All spell IDs must be strings
- User must be authenticated
- Uses idempotency to prevent duplicate operations

**Firestore Structure:**
```
/Players/{uid}/SpellDecks/DecksV2
  decks:
    0:
      spells: ['fireSpell', 'iceSpell', 'lightningSpell']
    1:
      spells: ['earthSpell', 'waterSpell', 'windSpell']
  updatedAt: <timestamp>
```

---

### selectActiveSpellDeckV2

Select which deck is currently active for the player.

**Parameters:**
```typescript
{
  opId: string;    // Operation ID for idempotency
  deckNo: number;  // Deck number to activate
}
```

**Returns:**
```typescript
{
  success: boolean;
}
```

**Example Usage:**
```typescript
const result = await functions.httpsCallable('selectActiveSpellDeckV2')({
  opId: 'unique-operation-id-456',
  deckNo: 1
});
```

**Firestore Structure:**
```
/Players/{uid}/Loadouts/ActiveV2
  activeSpellDeck: 1
  updatedAt: <timestamp>
```

## Key Differences from Legacy System

| Feature | Legacy System | V2 System |
|---------|--------------|-----------|
| Spells per deck | 5 | 3 |
| Deck storage path | `/Players/{uid}/SpellDecks/Decks` | `/Players/{uid}/SpellDecks/DecksV2` |
| Active deck path | `/Players/{uid}/Loadouts/Active` | `/Players/{uid}/Loadouts/ActiveV2` |
| Function names | `setSpellDeck`, `selectActiveSpellDeck` | `setSpellDeckV2`, `selectActiveSpellDeckV2` |

## Error Handling

Both functions throw `HttpsError` with the following codes:

- **unauthenticated**: User is not authenticated
- **invalid-argument**: 
  - Missing required parameters
  - Spell array is not exactly 3 items
  - Spell IDs are not strings
  - Invalid parameter types

## Safety Features

1. **Separate Storage**: V2 decks are stored in different Firestore paths to prevent conflicts
2. **Idempotency**: Uses operation IDs to prevent duplicate operations
3. **Strict Validation**: Enforces exactly 3 spells, no more, no less
4. **Type Safety**: Validates all spell IDs are strings

## Deployment

These functions are already exported in:
- `src/spellsV2/index.ts`
- `src/index.ts`

They will be deployed as Cloud Functions:
- `setSpellDeckV2`
- `selectActiveSpellDeckV2`

## Testing

To test these functions, you can:

1. Call them from Unity using Firebase Functions SDK
2. Use the Firebase console to test Cloud Functions
3. Use curl or Postman with proper authentication

**Example test data:**
```json
{
  "opId": "test-op-123",
  "deckNo": 0,
  "spells": ["spell1", "spell2", "spell3"]
}
```
