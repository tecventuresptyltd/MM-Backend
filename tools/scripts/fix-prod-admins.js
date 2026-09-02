/**
 * Fix Production Admin Users - Run with Node.js
 * This script uses Firebase Admin SDK to update user passwords
 * Run: node scripts/fix-prod-admins.js
 */

const admin = require("firebase-admin");

// Initialize Firebase Admin using application default credentials
// You need to run: firebase login first
const app = admin.initializeApp({
    projectId: "mystic-motors-prod",
});

const auth = app.auth();
const db = app.firestore();

const users = [
    {
        email: "tecventurescorp@gmail.com",
        password: "$Millions2026$",
        name: "Tec Ventures Admin",
        canViewAnalytics: true
    },
    {
        email: "mysticmotors.io@gmail.com",
        password: "Developer@123@",
        name: "Developer",
        canViewAnalytics: false
    }
];

async function main() {
    console.log("Fixing production admin users...\n");

    for (const u of users) {
        try {
            // Try to get existing user
            let existingUser;
            try {
                existingUser = await auth.getUserByEmail(u.email);
                console.log(`✓ User ${u.email} exists with UID: ${existingUser.uid}`);
            } catch (err) {
                if (err.code === "auth/user-not-found") {
                    // Create new user
                    existingUser = await auth.createUser({
                        email: u.email,
                        password: u.password,
                        displayName: u.name,
                        emailVerified: true
                    });
                    console.log(`✓ Created user ${u.email} with UID: ${existingUser.uid}`);
                } else {
                    throw err;
                }
            }

            // Update password for existing user
            await auth.updateUser(existingUser.uid, { password: u.password });
            console.log(`✓ Updated password for ${u.email}`);

            // Update AdminUsers doc
            await db.collection("AdminUsers").doc(existingUser.uid).set({
                email: u.email,
                role: "admin",
                displayName: u.name,
                canViewAnalytics: u.canViewAnalytics,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log(`✓ Updated AdminUsers doc for ${u.email}\n`);

        } catch (err) {
            console.error(`✗ Error for ${u.email}:`, err.message);
        }
    }

    console.log("Done!");
    process.exit(0);
}

main();
