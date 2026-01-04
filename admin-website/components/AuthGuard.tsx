"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { useFirebase } from "@/lib/FirebaseContext";
import { useAdminPermissions } from "@/lib/AdminPermissionsContext";

interface AuthGuardProps {
    children: React.ReactNode;
}

interface VerifyAdminResponse {
    isAdmin: boolean;
    canViewAnalytics: boolean;
    displayName?: string;
    email?: string;
    photoURL?: string;
    role?: string;
}

export default function AuthGuard({ children }: AuthGuardProps) {
    const router = useRouter();
    const { auth, functions, user, isLoading, logout, currentEnvironment, hasAuthChecked } = useFirebase();
    const { setPermissions, setPermissionsLoaded } = useAdminPermissions();
    const [isAuthorized, setIsAuthorized] = useState(false);
    const [isCheckingAdmin, setIsCheckingAdmin] = useState(false);

    useEffect(() => {
        // Reset authorization when environment or user changes
        setIsAuthorized(false);
        setPermissionsLoaded(false);
    }, [currentEnvironment, user, setPermissionsLoaded]);

    useEffect(() => {
        // Don't do anything until Firebase is fully initialized
        if (isLoading || !hasAuthChecked || !auth || !functions) {
            console.log("[AuthGuard] Waiting for Firebase initialization...", {
                isLoading,
                hasAuthChecked,
                hasAuth: !!auth,
                hasFunctions: !!functions
            });
            return;
        }

        // If no user after auth check, redirect to login
        if (!user) {
            console.log("[AuthGuard] No user after auth check, redirecting to login");
            setPermissionsLoaded(true);
            router.replace("/login");
            return;
        }

        // User exists, check if they're an admin via Cloud Function
        const checkAdminStatus = async () => {
            console.log(`[AuthGuard] Checking admin status for ${user.uid} in ${currentEnvironment}`);
            setIsCheckingAdmin(true);

            // Debug: Log auth state
            console.log("[AuthGuard] DEBUG - Auth state:", {
                authInstance: !!auth,
                currentUser: auth?.currentUser?.uid,
                currentUserEmail: auth?.currentUser?.email,
                userUid: user.uid,
                userEmail: user.email,
            });

            // Retry logic
            const maxRetries = 3;
            const retryDelay = 1000;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 1) {
                        console.log(`[AuthGuard] Retry attempt ${attempt}/${maxRetries} after delay`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                    }

                    console.log(`[AuthGuard] Attempt ${attempt}: Calling verifyAdminStatus function`);

                    // Call the Cloud Function instead of reading Firestore directly
                    // This bypasses App Check since the function has enforceAppCheck: false
                    const verifyAdmin = httpsCallable<void, VerifyAdminResponse>(functions, "verifyAdminStatus");
                    const result = await verifyAdmin();
                    const adminData = result.data;

                    console.log("[AuthGuard] verifyAdminStatus response:", adminData);

                    if (!adminData.isAdmin) {
                        console.log(`[AuthGuard] User ${user.uid} is NOT an admin in ${currentEnvironment}`);
                        setPermissionsLoaded(true);
                        await logout();
                        router.replace("/login?error=unauthorized");
                        return;
                    }

                    // Set permissions from the Cloud Function response
                    console.log("[AuthGuard] Setting permissions - canViewAnalytics:", adminData.canViewAnalytics);
                    setPermissions({
                        canViewAnalytics: adminData.canViewAnalytics,
                        displayName: adminData.displayName || user.email || "Admin",
                        email: adminData.email || user.email || undefined,
                        photoURL: adminData.photoURL || undefined,
                        role: adminData.role,
                    });
                    setPermissionsLoaded(true);

                    console.log("[AuthGuard] User IS admin, authorizing");
                    setIsAuthorized(true);
                    setIsCheckingAdmin(false);
                    return; // Success
                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const errorCode = (error as any)?.code || "unknown";

                    console.error(`[AuthGuard] Attempt ${attempt}/${maxRetries} - Error checking admin status:`, {
                        message: errorMessage,
                        code: errorCode,
                        fullError: error,
                        userId: user.uid,
                        environment: currentEnvironment,
                    });

                    // Final attempt failed
                    if (attempt === maxRetries) {
                        console.error("[AuthGuard] All retry attempts failed");
                        setPermissionsLoaded(true);
                        await logout();
                        router.replace("/login?error=auth-error");
                        return;
                    }
                }
            }
            setIsCheckingAdmin(false);
        };

        checkAdminStatus();
    }, [auth, functions, user, isLoading, hasAuthChecked, logout, router, currentEnvironment, setPermissions, setPermissionsLoaded]);

    // Show loading while Firebase is initializing or checking admin status
    if (isLoading || !hasAuthChecked || isCheckingAdmin) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-black">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
                    <p className="mt-4 text-gray-400">Verifying credentials...</p>
                </div>
            </div>
        );
    }

    // Show nothing while redirecting (user is null)
    if (!user) {
        return null;
    }

    // Only show content when authorized
    if (!isAuthorized) {
        return null;
    }

    return <>{children}</>;
}
