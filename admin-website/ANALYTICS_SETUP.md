# Analytics Dashboard - Setup Instructions

## Environment Variables Required

To use the Analytics Dashboard, you need to add the following environment variable to your `.env.local` file:

```bash
# Google Analytics 4 Property ID
GA4_PROPERTY_ID=properties/YOUR_PROPERTY_ID
```

## How to Get Your GA4 Property ID

1. Go to **Firebase Console** → [https://console.firebase.google.com](https://console.firebase.google.com)
2. Select your project (`mystic-motors-sandbox` or `mystic-motors-prod`)
3. Click on **Analytics** in the left sidebar
4. Click on the ⚙️ (Settings) icon
5. Under "Property settings", you'll see your **Property ID**
   - It will look like: `properties/123456789`
6. Copy the full string including `properties/`

## Add to Environment File

Add this line to `/admin-website/.env.local`:

```bash
GA4_PROPERTY_ID=properties/YOUR_ACTUAL_PROPERTY_ID
```

The other Firebase credentials (CLIENT_EMAIL, PRIVATE_KEY, PROJECT_ID) should already be in your `.env.local` from the existing admin dashboard setup.

## Permissions

The Analytics Dashboard uses your existing Firebase Admin SDK service account. Make sure it has **Viewer** access to Google Analytics in the Firebase Console.

## Testing

Once you've added the environment variable:

1. Restart your development server: `npm run dev`
2. Navigate to `/analytics`
3. You should see real data from your Firebase Analytics/Google Analytics 4

## Troubleshooting

If you see errors or zero values:

1. **Check the Property ID**: Make sure it includes `properties/` prefix
2. **Verify Permissions**: Ensure the service account has Analytics Viewer access
3. **Check Console**: Look at the browser console and server logs for specific errors
4. **API Enabled**: Make sure "Google Analytics Data API" is enabled in Google Cloud Console

## What Data is Displayed

The dashboard shows:
- **Daily/Weekly/Monthly Active Users** - from Firebase Analytics
- **Session Metrics** - average duration and engagement rate
- **User Growth** - new users over the last 30 days
- **Platform Distribution** - iOS vs Android split
- **Event Count** - total events tracked today

All data comes from Firebase Analytics automatic event tracking - no Unity changes needed!
