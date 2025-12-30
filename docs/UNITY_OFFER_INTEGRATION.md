# Unity Client Integration Guide - Offer Flow System

## Overview

The new offer flow system is **event-driven** and **backend-controlled**. The Unity client should:
- ✅ Listen to a single Firestore document for real-time updates
- ✅ Display offers based on document state
- ✅ Never poll or call `getDailyOffers` repeatedly
- ✅ Handle countdowns for active offers and cooldown periods

---

## Firestore Document Path

**Listen to:**
```
Players/{uid}/Offers/Active
```

**Do NOT call:** `getDailyOffers` Cloud Function (deprecated for active listening)

---

## Document Structure

```json
{
  "main": {
    "offerId": "offer_3jaky2p2",
    "offerType": 0,
    "expiresAt": 1735600000000,
    "tier": 0,
    "state": "active",
    "nextOfferAt": 1735643200000,
    "isStarter": true
  },
  "special": [
    {
      "offerId": "offer_3vv3me0e",
      "triggerType": "level_up",
      "expiresAt": 1735550000000,
      "metadata": { "level": 5 }
    }
  ],
  "updatedAt": 1735500000000
}
```

### Field Definitions

#### `main` Object (Main Rotating Offer Slot)

| Field | Type | Description |
|-------|------|-------------|
| `offerId` | string | Catalog ID of the offer to display |
| `offerType` | number | 0=starter, 1-4=daily, 5-8=ladder tiers |
| `expiresAt` | number | Timestamp (ms) when offer expires |
| `tier` | number | Current ladder tier (0-4) |
| `state` | string | `"active"`, `"cooldown"`, or `"purchase_delay"` |
| `nextOfferAt` | number? | When next offer available (only if state != "active") |
| `isStarter` | boolean? | True if this is the starter offer |

#### `state` Values

- **`"active"`** → Show the offer with countdown to `expiresAt`
- **`"cooldown"`** → Show "Next offer in X hours" (12h wait after expiry)
- **`"purchase_delay"`** → Show "Next offer in X minutes" (30min wait after purchase)

#### `special` Array (Stackable Offers)

| Field | Type | Description |
|-------|------|-------------|
| `offerId` | string | Catalog ID of the special offer |
| `triggerType` | string | `"level_up"`, `"flash_missing_key"`, `"flash_missing_crate"` |
| `expiresAt` | number | Timestamp (ms) when this offer expires |
| `metadata` | object? | Additional data (e.g., `{ level: 5 }`) |

---

## Unity Implementation Example

### 1. Set Up Listener

```csharp
using Firebase.Firestore;
using System;
using System.Collections.Generic;

public class OfferManager : MonoBehaviour
{
    private FirebaseFirestore db;
    private ListenerRegistration offerListener;
    private string playerId;

    void Start()
    {
        db = FirebaseFirestore.DefaultInstance;
        playerId = FirebaseAuth.DefaultInstance.CurrentUser.UserId;
        
        StartListeningToOffers();
    }

    void StartListeningToOffers()
    {
        var offersRef = db.Document($"Players/{playerId}/Offers/Active");
        
        offerListener = offersRef.Listen(snapshot =>
        {
            if (!snapshot.Exists)
            {
                Debug.Log("No active offers yet");
                return;
            }

            var data = snapshot.ToDictionary();
            ProcessOfferUpdate(data);
        });
    }

    void OnDestroy()
    {
        offerListener?.Stop();
    }
}
```

### 2. Process Main Offer

```csharp
void ProcessOfferUpdate(Dictionary<string, object> data)
{
    // Handle main offer slot
    if (data.ContainsKey("main") && data["main"] != null)
    {
        var main = data["main"] as Dictionary<string, object>;
        ProcessMainOffer(main);
    }
    else
    {
        HideMainOffer();
    }

    // Handle special offers
    if (data.ContainsKey("special"))
    {
        var special = data["special"] as List<object>;
        ProcessSpecialOffers(special);
    }
    else
    {
        ClearSpecialOffers();
    }
}

void ProcessMainOffer(Dictionary<string, object> main)
{
    string state = main["state"] as string;
    
    switch (state)
    {
        case "active":
            ShowActiveOffer(main);
            break;
        case "cooldown":
            ShowCooldownTimer(main);
            break;
        case "purchase_delay":
            ShowPurchaseDelayTimer(main);
            break;
    }
}
```

### 3. Show Active Offer

```csharp
void ShowActiveOffer(Dictionary<string, object> main)
{
    string offerId = main["offerId"] as string;
    long expiresAt = Convert.ToInt64(main["expiresAt"]);
    int tier = Convert.ToInt32(main["tier"]);
    bool isStarter = main.ContainsKey("isStarter") 
        ? Convert.ToBoolean(main["isStarter"]) 
        : false;

    // Get offer details from catalog
    var offerData = OfferCatalog.GetOffer(offerId);

    // Display offer UI
    offerPanel.SetActive(true);
    offerTitle.text = offerData.displayName;
    offerPrice.text = offerData.price;
    offerIcon.sprite = offerData.icon;
    
    // Start countdown timer
    StartCountdown(expiresAt, (timeRemaining) =>
    {
        timerText.text = FormatTimeRemaining(timeRemaining);
    }, () =>
    {
        // Countdown finished - offer expired
        // Backend will transition to cooldown automatically
        Debug.Log("Offer expired, waiting for backend update...");
    });
}
```

### 4. Show Cooldown/Delay State

```csharp
void ShowCooldownTimer(Dictionary<string, object> main)
{
    long nextOfferAt = Convert.ToInt64(main["nextOfferAt"]);
    
    // Hide offer, show countdown to next offer
    offerPanel.SetActive(false);
    cooldownPanel.SetActive(true);
    cooldownText.text = "Next offer in:";
    
    StartCountdown(nextOfferAt, (timeRemaining) =>
    {
        cooldownTimerText.text = FormatTimeRemaining(timeRemaining);
    }, () =>
    {
        // Cooldown finished
        // Backend will generate new offer automatically
        Debug.Log("Cooldown finished, waiting for new offer...");
    });
}

void ShowPurchaseDelayTimer(Dictionary<string, object> main)
{
    long nextOfferAt = Convert.ToInt64(main["nextOfferAt"]);
    
    // Similar to cooldown but different message
    offerPanel.SetActive(false);
    delayPanel.SetActive(true);
    delayText.text = "Thank you for your purchase! Next offer in:";
    
    StartCountdown(nextOfferAt, (timeRemaining) =>
    {
        delayTimerText.text = FormatTimeRemaining(timeRemaining);
    }, () =>
    {
        Debug.Log("Purchase delay finished, waiting for next offer...");
    });
}
```

### 5. Handle Special Offers

```csharp
void ProcessSpecialOffers(List<object> special)
{
    ClearSpecialOffers();
    
    foreach (var item in special)
    {
        var offer = item as Dictionary<string, object>;
        string offerId = offer["offerId"] as string;
        long expiresAt = Convert.ToInt64(offer["expiresAt"]);
        string triggerType = offer["triggerType"] as string;
        
        // Create special offer UI (these stack on screen)
        var specialUI = Instantiate(specialOfferPrefab, specialOfferContainer);
        specialUI.Setup(offerId, expiresAt, triggerType);
        
        activeSpecialOffers.Add(specialUI);
    }
}
```

### 6. Purchase Flow

```csharp
async void OnPurchaseButtonClicked(string offerId)
{
    // For IAP offers
    bool isIapOffer = OfferCatalog.GetOffer(offerId).isIAP;
    
    if (isIapOffer)
    {
        // 1. Process IAP with app store
        var purchase = await ProcessAppStorePurchase(offerId);
        
        if (purchase.success)
        {
            // 2. Verify with backend and grant items
            var result = await CloudFunctions.CallAsync("purchaseOffer", new
            {
                opId = Guid.NewGuid().ToString(),
                offerId = offerId,
                isIapPurchase = true  // IMPORTANT!
            });
            
            // 3. Backend will automatically update Offers/Active document
            // Listener will receive update and refresh UI
            Debug.Log($"Purchase successful, advanced to tier {result.newTier}");
        }
    }
    else
    {
        // For in-game currency offers (gems/coins)
        var result = await CloudFunctions.CallAsync("purchaseOffer", new
        {
            opId = Guid.NewGuid().ToString(),
            offerId = offerId,
            isIapPurchase = false
        });
        
        Debug.Log("Purchase successful");
    }
}
```

---

## Countdown Timer Utility

```csharp
void StartCountdown(long targetTimestamp, Action<long> onUpdate, Action onComplete)
{
    if (activeCountdown != null)
    {
        StopCoroutine(activeCountdown);
    }
    
    activeCountdown = StartCoroutine(CountdownRoutine(targetTimestamp, onUpdate, onComplete));
}

IEnumerator CountdownRoutine(long targetTimestamp, Action<long> onUpdate, Action onComplete)
{
    while (true)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long remaining = targetTimestamp - now;
        
        if (remaining <= 0)
        {
            onComplete?.Invoke();
            yield break;
        }
        
        onUpdate?.Invoke(remaining);
        yield return new WaitForSeconds(1f);
    }
}

string FormatTimeRemaining(long milliseconds)
{
    var timeSpan = TimeSpan.FromMilliseconds(milliseconds);
    
    if (timeSpan.TotalHours >= 1)
    {
        return $"{(int)timeSpan.TotalHours}h {timeSpan.Minutes}m";
    }
    else if (timeSpan.TotalMinutes >= 1)
    {
        return $"{timeSpan.Minutes}m {timeSpan.Seconds}s";
    }
    else
    {
        return $"{timeSpan.Seconds}s";
    }
}
```

---

## Important Notes

### ✅ DO

- Listen to `Players/{uid}/Offers/Active` with Firestore listener
- Use `expiresAt` timestamps for countdown timers
- Check `main.state` to determine UI state
- Set `isIapPurchase: true` when purchasing IAP offers
- Display multiple special offers simultaneously (they stack)

### ❌ DON'T

- ~~Call `getDailyOffers` repeatedly~~ (deprecated)
- ~~Poll the backend for updates~~ (use listener instead)
- ~~Generate offers client-side~~ (backend handles all generation)
- ~~Forget to set `isIapPurchase: true`~~ (won't advance ladder tiers)

---

## Offer Flow States

```
┌──────────────────────────────────────────────────────────────┐
│ Player completes 2nd race                                    │
│   ↓                                                          │
│ Backend generates STARTER OFFER (48h timer)                 │
│   ↓                                                          │
│ state: "active", expiresAt: now + 48h                       │
│                                                              │
│ Player either:                                               │
│   • Purchases → state: "purchase_delay" (30 min, tier +1)   │
│   • Expires → state: "cooldown" (12h, tier stays/drops)     │
│                                                              │
│ After delay/cooldown:                                        │
│   → Backend generates next offer automatically               │
│   → Client receives update via listener                     │
└──────────────────────────────────────────────────────────────┘
```

---

## Testing Checklist

- [ ] Listener receives updates when offers expire
- [ ] Listener receives updates when offers are purchased
- [ ] Countdown timers display correctly
- [ ] Cooldown state shows "Next offer in X hours"
- [ ] Purchase delay state shows "Next offer in X minutes"
- [ ] Special offers stack on screen independently
- [ ] IAP purchases advance ladder tier
- [ ] Non-IAP purchases don't affect ladder tier
- [ ] UI updates automatically without manual refreshes

---

## Troubleshooting

**Problem:** Offers not updating after expiry  
**Solution:** Check Firestore listener is active and document path is correct

**Problem:** Ladder not advancing after IAP purchase  
**Solution:** Ensure `isIapPurchase: true` is set in `purchaseOffer` call

**Problem:** Multiple offer UIs showing for same slot  
**Solution:** Clear existing UI before showing new offer state

**Problem:** Countdown timer not accurate  
**Solution:** Use server timestamps (`expiresAt`) not client-calculated times
