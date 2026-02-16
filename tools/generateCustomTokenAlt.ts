/**
 * ALTERNATIVE: Generate Custom Token Using Admin SDK
 * 
 * This version uses the service account's private key directly to sign tokens,
 * which doesn't require additional IAM permissions.
 * 
 * Usage: npx tsx tools/generateCustomTokenAlt.ts --production
 */

import * as admin from 'firebase-admin';

// Get environment from command line argument
const args = process.argv.slice(2);
const useProduction = args.includes('--production') || args.includes('--prod');

// Configuration based on environment
const CONFIG = useProduction ? {
    SERVICE_ACCOUNT_PATH: '../mystic-motors-prod-42437be98d22.json',
    PROJECT_ID: 'mystic-motors-prod',
    ENV_NAME: 'PRODUCTION'
} : {
    SERVICE_ACCOUNT_PATH: '../mystic-motors-sandbox-9b64d57718a2.json',
    PROJECT_ID: 'mystic-motors-sandbox',
    ENV_NAME: 'SANDBOX'
};

// The user ID you want to generate a token for:
const TARGET_USER_ID = args.find(arg => !arg.startsWith('--')) || 'bnpu2Xj5njV99JUzJQG8fGJNqo22';

// Initialize Firebase Admin
let serviceAccount;
try {
    serviceAccount = require(CONFIG.SERVICE_ACCOUNT_PATH);
} catch (error: any) {
    console.error(`❌ ERROR: Could not find service account file: ${CONFIG.SERVICE_ACCOUNT_PATH}`);
    console.error(`\nFor PRODUCTION access, you need:`);
    console.error(`  1. The production service account file`);
    console.error(`  2. Place it in the root directory of the project`);
    console.error(`\nIf you don't have this file, contact the project owner.`);
    process.exit(1);
}

// Initialize with explicit service account (this allows token creation without IAM permissions)
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: CONFIG.PROJECT_ID,
    serviceAccountId: serviceAccount.client_email
});

const auth = admin.auth();
const db = admin.firestore();

async function generateCustomToken(): Promise<void> {
    console.log('🔐 Custom Token Generator - SAFE READ-ONLY MODE (Alternative Method)');
    console.log('=================================================================\n');
    console.log(`Environment: ${CONFIG.ENV_NAME}`);
    console.log(`Project: ${CONFIG.PROJECT_ID}`);
    console.log(`User ID: ${TARGET_USER_ID}\n`);

    try {
        // Step 1: Verify user exists (READ-ONLY)
        console.log('Step 1: Verifying user exists in Firebase Auth...');
        let userRecord;
        try {
            userRecord = await auth.getUser(TARGET_USER_ID);
            console.log('✅ User found in Firebase Auth');
            console.log(`   Email: ${userRecord.email || 'N/A'}`);
            console.log(`   Provider: ${userRecord.providerData.map(p => p.providerId).join(', ') || 'N/A'}`);
            console.log(`   Created: ${userRecord.metadata.creationTime}`);
            console.log(`   Last Sign In: ${userRecord.metadata.lastSignInTime || 'Never'}\n`);
        } catch (error: any) {
            console.log('⚠️  Could not fetch user from Firebase Auth (might be a permissions issue)');
            console.log('   Proceeding with token generation anyway...\n');
        }

        // Step 2: Check Firestore data (READ-ONLY)
        console.log('Step 2: Checking Firestore user data...');
        try {
            const userDoc = await db.doc(`Users/${TARGET_USER_ID}`).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                console.log('✅ User document found in Firestore');
                console.log(`   Display Name: ${userData?.displayName || 'N/A'}`);
                console.log(`   Level: ${userData?.level || 'N/A'}`);
                console.log(`   Gems: ${userData?.gems || 'N/A'}`);
                console.log(`   Gold: ${userData?.gold || 'N/A'}\n`);
            } else {
                console.log('⚠️  User document not found in Firestore\n');
            }
        } catch (error: any) {
            console.log('⚠️  Could not fetch Firestore data (might be a permissions issue)');
            console.log('   Proceeding with token generation anyway...\n');
        }

        // Step 3: Generate custom token (SAFE - doesn't modify anything)
        console.log('Step 3: Generating custom token...');
        const customToken = await auth.createCustomToken(TARGET_USER_ID);
        console.log('✅ Custom token generated successfully!\n');

        // Display the token
        console.log('=================================================================');
        console.log('🎟️  CUSTOM TOKEN (copy this):');
        console.log('=================================================================');
        console.log(customToken);
        console.log('=================================================================\n');

        // Instructions
        console.log('📋 HOW TO USE IN UNITY:');
        console.log('-----------------------------------------------------------------');
        console.log('1. Copy the custom token above');
        console.log('2. In Unity, use this code:');
        console.log('');
        console.log('   string customToken = "PASTE_TOKEN_HERE";');
        console.log('   FirebaseAuth.DefaultInstance.SignInWithCustomTokenAsync(customToken)');
        console.log('       .ContinueWithOnMainThread(task => {');
        console.log('           if (task.IsCompleted && !task.IsFaulted) {');
        console.log('               Debug.Log("Successfully logged in!");');
        console.log('               Debug.Log($"User ID: {task.Result.UserId}");');
        console.log('           }');
        console.log('       });');
        console.log('');
        console.log('⚠️  SECURITY NOTE:');
        console.log('   - This token is valid for 1 hour');
        console.log('   - Do NOT share this token with anyone');
        console.log('   - Delete this token from your clipboard after use');
        console.log('   - The account remains completely unchanged\n');

    } catch (error: any) {
        console.error('❌ Error:', error.message);

        if (error.code === 'auth/user-not-found') {
            console.error('   The user ID does not exist in Firebase Auth.');
        } else if (error.code === 'auth/insufficient-permission') {
            console.error('   The service account lacks permissions.');
            console.error('   Required permission: "Service Account Token Creator" role');
            console.error('   Contact the project owner to grant this permission.');
        } else {
            console.error('   Full error:', error);
        }
        throw error;
    }
}

// Run the script
generateCustomToken()
    .then(() => {
        console.log('✅ Token generation complete. Account is safe and unchanged.');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Token generation failed:', error.message);
        process.exit(1);
    });
