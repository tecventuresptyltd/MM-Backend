/**
 * Script to update AdminUsers with canViewAnalytics permission
 * Run with: npx ts-node scripts/update-admin-analytics-permission.ts
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin for production (uses application default credentials)
const productionApp = admin.initializeApp({
    projectId: 'mystic-motors-prod',
}, 'production-analytics-update');

const db = productionApp.firestore();

async function updateAdminPermissions() {
    console.log('Updating AdminUsers with canViewAnalytics permission...\n');

    try {
        // Get all AdminUsers
        const adminUsersSnapshot = await db.collection('AdminUsers').get();

        console.log(`Found ${adminUsersSnapshot.size} admin users\n`);

        for (const doc of adminUsersSnapshot.docs) {
            const data = doc.data();
            const email = data.email || 'unknown';
            const displayName = data.displayName || 'Unknown';

            // Determine if this user should have analytics access
            // Only tecventurescorp@gmail.com gets analytics access
            const shouldHaveAnalyticsAccess = email === 'tecventurescorp@gmail.com';

            console.log(`Processing: ${displayName} (${email})`);
            console.log(`  Current canViewAnalytics: ${data.canViewAnalytics ?? 'not set'}`);
            console.log(`  Setting canViewAnalytics to: ${shouldHaveAnalyticsAccess}`);

            // Update the document
            await db.collection('AdminUsers').doc(doc.id).update({
                canViewAnalytics: shouldHaveAnalyticsAccess
            });

            console.log(`  ✅ Updated successfully\n`);
        }

        console.log('All admin users updated!');
    } catch (error) {
        console.error('Error updating admin users:', error);
        process.exit(1);
    }

    process.exit(0);
}

updateAdminPermissions();
