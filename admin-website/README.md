# Mystic Motors Admin Dashboard

A secure web-based admin panel for managing Mystic Motors game configuration.

## Features

### ✅ Core Functionality (Implemented)
- **Maintenance Mode Control**
  - Toggle maintenance on/off
  - Set custom maintenance messages
  - Configure compensation rewards (gems)
  - Real-time status display

- **Version Control**
  - Set minimum supported app version
  - Force players to update when needed
  - Version format validation

- **Security**
  - Firebase Authentication with email/password
  - Role-based access control (admin-only)
  - Protected routes with AuthGuard

### 🚧 Coming Soon (Phase 2)
- Firebase Analytics integration
- Player support tools (award gems, coins, items)
- User activity metrics

## Setup Instructions

### Prerequisites
- Node.js 18+ installed
- Firebase project with Firestore enabled
- Admin user account created in Firebase Auth

### 1. Configure Firebase

1. Create a `.env.local` file in the `admin-website` directory:
   ```bash
   cp env.example .env.local
   ```

2. Update `.env.local` with your Firebase project credentials:
   ```env
   NEXT_PUBLIC_FIREBASE_API_KEY=your-api-key
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
   NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
   NEXT_PUBLIC_FIREBASE_APP_ID=your-app-id
   ```

### 2. Create Admin User

1. Create a user in Firebase Console (Authentication > Add user)
2. Note the user's UID
3. In Firestore, create document: `/AdminUsers/{uid}`
   ```json
   {
     "email": "admin@example.com",
     "role": "admin",
     "createdAt": <current timestamp>
   }
   ```

### 3. Deploy Backend Functions

From the `MM-Backend` root directory:

```bash
# Build TypeScript
npm run build

# Deploy admin functions
firebase deploy --only functions:setMaintenanceMode,functions:setMinimumVersion,functions:getMinimumVersion
```

### 4. Run the Admin Dashboard

```bash
cd admin-website
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

### Login
1. Navigate to `/login`
2. Enter admin email and password
3. You'll be redirected to the dashboard on success

### Maintenance Mode
1. Click "Maintenance Mode" card on dashboard
2. Toggle maintenance on/off
3. Set a custom message for players
4. Configure reward availability and gem amount
5. Click "Save Changes"

### Version Control
1. Click "Version Control" card on dashboard
2. Enter new minimum version (format: X.Y.Z)
3. Click "Update Minimum Version"
4. Players below this version will be forced to update

## API Endpoints

### Backend Functions

#### `setMaintenanceMode`
Sets maintenance mode configuration.

**Input:**
```typescript
{
  enabled: boolean;
  message?: string;
  rewardAvailable?: boolean;
  rewardGems?: number;
}
```

**Access:** Admin only

#### `setMinimumVersion`
Updates the minimum supported app version.

**Input:**
```typescript
{
  version: string; // Format: "X.Y.Z"
}
```

**Access:** Admin only

#### `getMinimumVersion`
Retrieves the current minimum version.

**Access:** Admin only

## Security

- All admin functions check for authentication
- User must exist in `/AdminUsers` collection with `role: "admin"`
- Frontend uses AuthGuard component to protect routes
- Unauthorized users are redirected to login

## Troubleshooting

### "User does not have admin privileges"
- Ensure the user UID exists in `/AdminUsers/{uid}`
- Verify `role` field is set to `"admin"`

### Functions not found
- Deploy backend functions first: `firebase deploy --only functions`
- Check Firebase Console > Functions for deployment status

### Environment variables not loaded
- Restart the Next.js dev server after creating `.env.local`
- Verify all `NEXT_PUBLIC_*` variables are set

## Tech Stack

- **Frontend:** Next.js 14, React, TypeScript, Tailwind CSS
- **Backend:** Firebase Cloud Functions, Firestore
- **Authentication:** Firebase Auth
- **Hosting:** Firebase Hosting (optional)

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Deployment

To deploy to Firebase Hosting:

```bash
# Build the app
npm run build

# Deploy
firebase deploy --only hosting:admin
```

## Support

For issues or questions, contact the development team.
