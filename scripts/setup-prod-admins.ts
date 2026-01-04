/**
 * Setup Production Admin Users
 * Creates admin and developer users in production Firebase Auth
 * and adds their AdminUsers documents to Firestore
 */

const admin = require("firebase-admin");

// Initialize Firebase Admin for production
const productionApp = admin.initializeApp({
    projectId: "mystic-motors-prod",
}, "production");

const auth = productionApp.auth();
const db = productionApp.firestore();

async function createUser(email: string, password: string, displayName: string) {
    try {
        // Check if user already exists
        try {
            const existingUser = await auth.getUserByEmail(email);
            console.log(`User ${email} already exists with UID: ${existingUser.uid}`);
            return existingUser.uid;
        } catch (error: any) {
            if (error.code !== "auth/user-not-found") {
                throw error;
            }
        }

        // Create new user
        const userRecord = await auth.createUser({
            email,
            password,
            displayName,
            emailVerified: true,
        });
        console.log(`Created user ${email} with UID: ${userRecord.uid}`);
        return userRecord.uid;
    } catch (error) {
        console.error(`Error creating user ${email}:`, error);
        throw error;
    }
}

async function addAdminDocument(uid: string, email: string, role: string, displayName: string, canViewAnalytics: boolean = false) {
    try {
        const adminRef = db.collection("AdminUsers").doc(uid);
        const existingDoc = await adminRef.get();

        if (existingDoc.exists) {
            console.log(`AdminUsers document already exists for ${email}, updating...`);
        }

        await adminRef.set({
            email,
            role,
            displayName,
            canViewAnalytics,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log(`Added/updated AdminUsers document for ${email} with role: ${role}, canViewAnalytics: ${canViewAnalytics}`);
    } catch (error) {
        console.error(`Error adding AdminUsers document for ${email}:`, error);
        throw error;
    }
}

async function main() {
    console.log("Setting up production admin users...\n");

    // Admin user
    console.log("=== Creating Admin User ===");
    const adminUid = await createUser(
        "tecventurescorp@gmail.com",
        "$Millions2026$",
        "Tec Ventures Admin"
    );
    await addAdminDocument(adminUid, "tecventurescorp@gmail.com", "admin", "Tec Ventures Admin", true);

    console.log("\n=== Creating Developer User ===");
    const developerUid = await createUser(
        "mysticmotors.io@gmail.com",
        "Developer@123@",
        "Developer"
    );
    await addAdminDocument(developerUid, "mysticmotors.io@gmail.com", "admin", "Developer", false);

    console.log("\n✅ Production admin users setup complete!");
    console.log("\nAdmin User:");
    console.log(`  Email: tecventurescorp@gmail.com`);
    console.log(`  UID: ${adminUid}`);
    console.log(`  Role: admin`);
    console.log("\nDeveloper User:");
    console.log(`  Email: mysticmotors.io@gmail.com`);
    console.log(`  UID: ${developerUid}`);
    console.log(`  Role: admin`);

    process.exit(0);
}

main().catch((error) => {
    console.error("Setup failed:", error);
    process.exit(1);
});
