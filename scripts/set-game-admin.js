const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '../firebase-adminsdk-key.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function findAndSetGameAdmin() {
    console.log('Searching for user "tope"...\n');

    try {
        // Get all players
        const playersSnapshot = await db.collection('Players').limit(100).get();
        console.log(`Checking ${playersSnapshot.size} players...`);

        for (const playerDoc of playersSnapshot.docs) {
            // Check root document
            const rootData = playerDoc.data();

            // Get profile  
            const profileRef = playerDoc.ref.collection('Profile').doc('info');
            const profileDoc = await profileRef.get();

            if (profileDoc.exists) {
                const profileData = profileDoc.data();
                const username = (profileData.username || '').toLowerCase();

                if (username.includes('tope')) {
                    console.log('\n✅ Found user!');
                    console.log('━'.repeat(50));
                    console.log('UID:', playerDoc.id);
                    console.log('Username:', profileData.username);
                    console.log('Email:', profileData.email || 'N/A');
                    console.log('Current isGameAdmin:', rootData.isGameAdmin || false);
                    console.log('━'.repeat(50));

                    // Set as game admin
                    console.log('\n🔧 Setting user as Game Admin...');
                    await playerDoc.ref.update({
                        isGameAdmin: true,
                        gameAdminUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        gameAdminUpdatedBy: 'manual_script'
                    });

                    console.log('✅ SUCCESS! User is now a Game Admin');
                    console.log('\nFirestore path: /Players/' + playerDoc.id);
                    console.log('Field: isGameAdmin = true');

                    process.exit(0);
                }
            }
        }

        console.log('\n❌ No user found with username containing "tope"');
        process.exit(1);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

findAndSetGameAdmin();
