"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { initializeApp, getApps, FirebaseApp, deleteApp } from "firebase/app";
import { getAuth, Auth, onAuthStateChanged, User, signOut } from "firebase/auth";
import { getFunctions, Functions, httpsCallable } from "firebase/functions";
import { getFirestore, Firestore } from "firebase/firestore";
import { environments, Environment, DEFAULT_ENVIRONMENT, EnvironmentConfig } from "./environments";

interface FirebaseContextType {
    // Current environment
    currentEnvironment: Environment;
    environmentConfig: EnvironmentConfig;

    // Switch environment (will require re-login)
    setEnvironment: (env: Environment) => void;

    // Firebase instances - ALL use current environment
    auth: Auth | null;
    db: Firestore | null;
    functions: Functions | null;

    // Current user
    user: User | null;

    // Helper to call functions
    callFunction: <RequestData = any, ResponseData = any>(
        functionName: string,
        data?: RequestData
    ) => Promise<{ data: ResponseData }>;

    // Loading state
    isLoading: boolean;

    // Is production environment
    isProd: boolean;

    // Production confirmation modal
    showProductionConfirm: (action: string) => Promise<boolean>;

    // Logout current environment
    logout: () => Promise<void>;

    // Has auth state been checked at least once?
    hasAuthChecked: boolean;
}

const FirebaseContext = createContext<FirebaseContextType | null>(null);

const STORAGE_KEY = "mystic-motors-admin-environment";

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
    // Start with null environment - will be set after hydration
    const [currentEnvironment, setCurrentEnvironment] = useState<Environment | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [app, setApp] = useState<FirebaseApp | null>(null);
    const [auth, setAuth] = useState<Auth | null>(null);
    const [db, setDb] = useState<Firestore | null>(null);
    const [functions, setFunctions] = useState<Functions | null>(null);
    const [user, setUser] = useState<User | null>(null);
    const [authUnsubscribe, setAuthUnsubscribe] = useState<(() => void) | null>(null);
    const [hasAuthChecked, setHasAuthChecked] = useState(false);

    // Production confirmation modal state
    const [confirmModalVisible, setConfirmModalVisible] = useState(false);
    const [confirmAction, setConfirmAction] = useState("");
    const [confirmResolve, setConfirmResolve] = useState<((value: boolean) => void) | null>(null);

    // Step 1: Read environment from localStorage AFTER hydration (client-side only)
    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === "sandbox" || saved === "prod") {
            console.log("[Firebase] Initializing with saved environment:", saved);
            setCurrentEnvironment(saved);
        } else {
            console.log("[Firebase] No saved environment, using default:", DEFAULT_ENVIRONMENT);
            setCurrentEnvironment(DEFAULT_ENVIRONMENT);
        }
    }, []);

    // Step 2: Initialize Firebase ONLY after environment is set
    useEffect(() => {
        // Don't initialize until environment is set (after hydration)
        if (currentEnvironment === null) {
            console.log("[Firebase] Waiting for environment to be set...");
            return;
        }

        console.log("[Firebase] Initializing Firebase for environment:", currentEnvironment);

        const initializeFirebase = async () => {
            setIsLoading(true);
            setHasAuthChecked(false); // Reset auth check flag when reinitializing

            // Clean up previous auth listener
            if (authUnsubscribe) {
                authUnsubscribe();
            }

            // Clean up all existing apps for OTHER environments
            const existingApps = getApps();
            for (const existingApp of existingApps) {
                if (existingApp.name === `app-${currentEnvironment}`) {
                    // Keep current env app
                    continue;
                }
                try {
                    await deleteApp(existingApp);
                } catch (e) {
                    // App might already be deleted
                }
            }

            // Create or get app for current environment
            const existingApp = getApps().find(a => a.name === `app-${currentEnvironment}`);
            let firebaseApp: FirebaseApp;

            if (existingApp) {
                firebaseApp = existingApp;
            } else {
                const config = environments[currentEnvironment].firebase;
                firebaseApp = initializeApp(config, `app-${currentEnvironment}`);
            }

            const authInstance = getAuth(firebaseApp);
            const dbInstance = getFirestore(firebaseApp);
            const functionsInstance = getFunctions(firebaseApp, "us-central1");

            setApp(firebaseApp);
            setAuth(authInstance);
            setDb(dbInstance);
            setFunctions(functionsInstance);

            // Listen for auth state changes
            const unsubscribe = onAuthStateChanged(authInstance, (firebaseUser) => {
                console.log("[Firebase] Auth state changed:", firebaseUser?.uid || "null");
                setUser(firebaseUser);
                setHasAuthChecked(true);
                setIsLoading(false);
            });

            setAuthUnsubscribe(() => unsubscribe);
        };

        initializeFirebase();

        // Cleanup on unmount
        return () => {
            if (authUnsubscribe) {
                authUnsubscribe();
            }
        };
    }, [currentEnvironment]);


    // Save environment to localStorage when it changes
    const setEnvironment = useCallback(async (env: Environment) => {
        if (env === currentEnvironment) return;

        // Sign out of current environment before switching
        if (auth) {
            try {
                await signOut(auth);
            } catch (e) {
                console.error("Error signing out:", e);
            }
        }

        setUser(null);
        setCurrentEnvironment(env);
        localStorage.setItem(STORAGE_KEY, env);
    }, [auth, currentEnvironment]);

    // Logout function
    const logout = useCallback(async () => {
        if (auth) {
            await signOut(auth);
            setUser(null);
        }
    }, [auth]);

    // Call function helper
    const callFunction = useCallback(async <RequestData = any, ResponseData = any>(
        functionName: string,
        data?: RequestData
    ): Promise<{ data: ResponseData }> => {
        if (!functions) {
            throw new Error("Firebase functions not initialized");
        }
        const callable = httpsCallable<RequestData, ResponseData>(functions, functionName);
        return callable(data);
    }, [functions]);

    // Production confirmation modal function
    const showProductionConfirm = useCallback((action: string): Promise<boolean> => {
        if (currentEnvironment !== "prod") {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            setConfirmAction(action);
            setConfirmResolve(() => resolve);
            setConfirmModalVisible(true);
        });
    }, [currentEnvironment]);

    const handleConfirm = useCallback(() => {
        if (confirmResolve) {
            confirmResolve(true);
        }
        setConfirmModalVisible(false);
        setConfirmResolve(null);
    }, [confirmResolve]);

    const handleCancel = useCallback(() => {
        if (confirmResolve) {
            confirmResolve(false);
        }
        setConfirmModalVisible(false);
        setConfirmResolve(null);
    }, [confirmResolve]);

    // Don't render until environment is set (prevents SSR hydration issues)
    if (currentEnvironment === null) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-black">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
                    <p className="mt-4 text-gray-400">Initializing...</p>
                </div>
            </div>
        );
    }

    const value: FirebaseContextType = {
        currentEnvironment,
        environmentConfig: environments[currentEnvironment],
        setEnvironment,
        auth,
        db,
        functions,
        user,
        callFunction,
        isLoading,
        isProd: currentEnvironment === "prod",
        showProductionConfirm,
        logout,
        hasAuthChecked,
    };

    return (
        <FirebaseContext.Provider value={value}>
            {children}

            {/* Production Confirmation Modal */}
            {confirmModalVisible && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[200] backdrop-blur-sm">
                    <div className="bg-gray-900 border-2 border-red-700/70 rounded-2xl p-8 max-w-md mx-4 shadow-2xl shadow-red-500/20">
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-5xl">⚠️</span>
                            <h2 className="text-2xl font-bold text-red-400">Production Warning</h2>
                        </div>

                        <p className="text-gray-300 mb-4">
                            You are about to <strong className="text-red-400">{confirmAction}</strong> on the <strong className="text-red-400">LIVE production environment</strong>.
                        </p>

                        <div className="bg-red-900/40 border border-red-700/60 rounded-lg p-4 mb-6">
                            <p className="text-red-300 text-sm font-semibold">
                                ⚠️ This will affect real players!
                            </p>
                            <p className="text-red-300/80 text-sm mt-2">
                                Make sure you understand the impact of this action before proceeding.
                            </p>
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={handleCancel}
                                className="flex-1 px-4 py-3 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition font-medium"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirm}
                                className="flex-1 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition font-semibold"
                            >
                                Yes, Continue
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </FirebaseContext.Provider>
    );
}

export function useFirebase() {
    const context = useContext(FirebaseContext);
    if (!context) {
        throw new Error("useFirebase must be used within a FirebaseProvider");
    }
    return context;
}

// Hook for environment-aware confirmation
export function useProductionConfirm() {
    const { showProductionConfirm } = useFirebase();
    return showProductionConfirm;
}


