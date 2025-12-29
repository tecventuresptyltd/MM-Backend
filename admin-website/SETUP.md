# Quick Start: Running Admin Dashboard Locally

The dev server is now running at: **http://localhost:3000**

## ⚠️ Important: Add Firebase Configuration

The app needs your Firebase project credentials to work. Follow these steps:

### 1. Get Firebase Credentials

Go to [Firebase Console](https://console.firebase.google.com/):
1. Select your project: **mystic-motors-sandbox** (or your production project)
2. Click the gear icon ⚙️ > **Project settings**
3. Scroll down to "Your apps" section
4. If you haven't added a web app yet:
   - Click "Add app" > Web icon
   - Register the app (name: "Admin Dashboard")
5. Copy the Firebase configuration object

### 2. Create `.env.local` File

In the `admin-website` directory, create a file named `.env.local` with:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your-actual-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=mystic-motors-sandbox.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=mystic-motors-sandbox
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=mystic-motors-sandbox.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
NEXT_PUBLIC_FIREBASE_APP_ID=your-app-id
```

Replace the placeholder values with your actual Firebase config values.

### 3. Restart the Dev Server

After creating `.env.local`:
1. Stop the dev server (Ctrl+C in terminal)
2. Restart: `npm run dev`
3. Refresh the browser at http://localhost:3000

### 4. Create Admin User

Before you can log in, create an admin user in Firebase:

1. **Firebase Console > Authentication > Add User**
   - Email: your-email@example.com
   - Password: your-secure-password
   - Copy the UID after creation

2. **Firebase Console > Firestore Database**
   - Create collection: `AdminUsers`
   - Document ID: paste the UID from step 1
   - Fields:
     ```
     email: "your-email@example.com"
     role: "admin"
     createdAt: (Firestore timestamp - current time)
     ```

### 5. Test the Dashboard

1. Open http://localhost:3000
2. You'll be redirected to `/login`
3. Enter the admin email and password
4. You should see the main dashboard with cards for:
   - Maintenance Mode
   - Version Control
   - Analytics (coming soon)
   - Player Support (coming soon)

## Troubleshooting

### "Firebase config undefined" error
- Make sure `.env.local` exists in `admin-website` directory
- Restart the dev server after creating the file
- Check that all variables start with `NEXT_PUBLIC_`

### "User does not have admin privileges"
- Verify the AdminUsers document exists in Firestore
- Check that the `role` field is exactly `"admin"`
- Make sure the document ID matches the user's UID

### "Permission denied" on functions
- Deploy the backend functions first: `cd .. && npm run build && firebase deploy --only functions`
- Make sure you're using the correct Firebase project

## Current Server Status

✅ Dev server running on: http://localhost:3000
⏳ Waiting for Firebase credentials in `.env.local`
