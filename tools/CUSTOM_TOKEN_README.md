# 🔐 Custom Token Generator - Emergency Login Tool

## ⚠️ IMPORTANT: This is SAFE and READ-ONLY

This tool **ONLY generates a custom token** for emergency login. It does **NOT**:
- ❌ Modify the user account
- ❌ Change passwords
- ❌ Delete any data
- ❌ Update any fields

It **ONLY reads** user information and generates a temporary login token.

---

## 🚀 Quick Start

### For PRODUCTION (your case):

**Step 1:** Make sure you have the production service account file
- File name: `backend-production-mystic-motors-prod.json`
- Location: Root directory of the project

**Step 2:** Run the script with `--production` flag
```bash
npx tsx tools/generateCustomToken.ts --production
```

**Step 3:** Copy the custom token from the output

---

### For SANDBOX (testing):

```bash
npx tsx tools/generateCustomToken.ts
```

---

### Custom User ID:

To generate a token for a different user, pass the user ID as an argument:
```bash
npx tsx tools/generateCustomToken.ts --production YOUR_USER_ID_HERE
```

### Step 4: Use in Unity

```csharp
string customToken = "PASTE_YOUR_TOKEN_HERE";

FirebaseAuth.DefaultInstance.SignInWithCustomTokenAsync(customToken)
    .ContinueWithOnMainThread(task => {
        if (task.IsCompleted && !task.IsFaulted) {
            Debug.Log("✅ Successfully logged in!");
            FirebaseUser user = task.Result;
            Debug.Log($"User ID: {user.UserId}");
        } else {
            Debug.LogError($"❌ Login failed: {task.Exception}");
        }
    });
```

---

## 🔒 Security Notes

- **Token expires in 1 hour** - Use it quickly
- **Delete after use** - Clear from clipboard
- **Don't share** - This grants full account access
- **Account remains safe** - Nothing is modified

---

## 📋 What the Script Shows

The script will display:
1. ✅ User exists in Firebase Auth
2. 📧 Email and provider information
3. 📅 Account creation and last sign-in dates
4. 💎 Firestore data (gems, gold, level, etc.)
5. 🎟️ **The custom token to copy**

---

## ❓ Troubleshooting

### "User not found"
- Check the `TARGET_USER_ID` in the script
- Verify you're using the correct project (sandbox vs production)

### "Service account not found"
- Make sure the service account JSON file exists
- Check the `SERVICE_ACCOUNT_PATH` is correct

### "Permission denied"
- Ensure the service account has the correct permissions
- Verify you're using the right service account for the project

---

## 🎯 Current Configuration

- **User ID:** `bnpu2Xj5njV99JUzJQG8fGJNqo22`
- **Default Project:** Sandbox (change to production in the script)
