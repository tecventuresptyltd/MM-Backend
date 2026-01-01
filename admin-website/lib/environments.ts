// Environment configurations for Sandbox and Production Firebase projects
// Auth will use Sandbox for both environments to avoid re-authentication

export type Environment = "sandbox" | "prod";

export interface FirebaseConfig {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
    databaseURL?: string;
    measurementId?: string;
}

export interface EnvironmentConfig {
    name: string;
    displayName: string;
    firebase: FirebaseConfig;
    functionsUrl: string;
    color: string;
    bgColor: string;
    borderColor: string;
}

export const environments: Record<Environment, EnvironmentConfig> = {
    sandbox: {
        name: "sandbox",
        displayName: "Sandbox (Dev)",
        firebase: {
            apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
            authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "",
            projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "mystic-motors-sandbox",
            storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "",
            messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
            appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
        },
        functionsUrl: "https://us-central1-mystic-motors-sandbox.cloudfunctions.net",
        color: "text-green-400",
        bgColor: "bg-green-900/30",
        borderColor: "border-green-500/50",
    },
    prod: {
        name: "prod",
        displayName: "Production ⚠️",
        firebase: {
            apiKey: "AIzaSyB3hNvJrcWtcgv8fozAZL_PJ_EVkA1ihMo",
            authDomain: "mystic-motors-prod.firebaseapp.com",
            projectId: "mystic-motors-prod",
            storageBucket: "mystic-motors-prod.firebasestorage.app",
            messagingSenderId: "727048974991",
            appId: "1:727048974991:web:2f2ef93ec51f23a2a636fa",
            databaseURL: "https://mystic-motors-prod-default-rtdb.firebaseio.com",
            measurementId: "G-1KJ9VZRQGZ",
        },
        functionsUrl: "https://us-central1-mystic-motors-prod.cloudfunctions.net",
        color: "text-red-400",
        bgColor: "bg-red-900/30",
        borderColor: "border-red-500/50",
    },
};

export const DEFAULT_ENVIRONMENT: Environment = "sandbox";
