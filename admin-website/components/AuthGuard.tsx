"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { useFirebase } from "@/lib/FirebaseContext";
import { useAdminPermissions } from "@/lib/AdminPermissionsContext";

interface AuthGuardProps {
    children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
    const router = useRouter();
    const { auth, db, user, isLoading, logout, currentEnvironment, hasAuthChecked } = useFirebase();
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
        if (isLoading || !hasAuthChecked || !auth || !db) {
            console.log("[AuthGuard] Waiting for Firebase initialization...", {
                isLoading,
                hasAuthChecked,
                hasAuth: !!auth,
                hasDb: !!db
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

        // User exists, check if they're an admin
        const checkAdminStatus = async () => {
            console.log(`[AuthGuard] Checking admin status for ${user.uid} in ${currentEnvironment}`);
            setIsCheckingAdmin(true);

            // Debug: Log auth and db state
            console.log("[AuthGuard] DEBUG - Auth state:", {
                authInstance: !!auth,
                currentUser: auth?.currentUser?.uid,
                currentUserEmail: auth?.currentUser?.email,
                dbInstance: !!db,
                userUid: user.uid,
                userEmail: user.email,
            });

            // Retry logic for auth token propagation
            const maxRetries = 3;
            const retryDelay = 1000; // 1 second

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    // Wait for auth token to propagate to Firestore
                    if (attempt > 1) {
                        console.log(`[AuthGuard] Retry attempt ${attempt}/${maxRetries} after ${retryDelay}ms delay`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                    }

                    // Force refresh the auth token before Firestore read
                    if (auth?.currentUser) {
                        console.log("[AuthGuard] Getting current auth token...");
                        const token = await auth.currentUser.getIdToken(attempt > 1);
                        console.log("[AuthGuard] Token obtained, length:", token?.length || 0);
                    }

                    console.log(`[AuthGuard] Attempt ${attempt}: Fetching AdminUsers/${user.uid}`);
                    const adminDocRef = doc(db, "AdminUsers", user.uid);
                    const adminDoc = await getDoc(adminDocRef);

                    console.log("[AuthGuard] Admin doc exists:", adminDoc.exists(), "data:", adminDoc.data());

                    if (!adminDoc.exists() || adminDoc.data()?.role !== "admin") {
                        console.log(`[AuthGuard] User ${user.uid} is NOT an admin in ${currentEnvironment}`);
                        setPermissionsLoaded(true);
                        await logout();
                        router.replace("/login?error=unauthorized");
                        return;
                    }

                    // Extract permissions from the admin document
                    const adminData = adminDoc.data();
                    const canViewAnalytics = adminData?.canViewAnalytics === true; // Default to false if not set

                    console.log("[AuthGuard] Setting permissions - canViewAnalytics:", canViewAnalytics);
                    setPermissions({
                        canViewAnalytics,
                        displayName: adminData?.displayName || user.email || "Admin",
                        email: user.email || undefined,
                        photoURL: adminData?.photoURL || undefined,
                        role: adminData?.role,
                    });
                    setPermissionsLoaded(true);

                    console.log("[AuthGuard] User IS admin, authorizing");
                    setIsAuthorized(true);
                    return; // Success, exit the retry loop
                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const errorCode = (error as any)?.code || "unknown";
                    const isPermissionError = errorMessage.includes("permission") || errorMessage.includes("Permission");

                    console.error(`[AuthGuard] Attempt ${attempt}/${maxRetries} - Error checking admin status:`, {
                        message: errorMessage,
                        code: errorCode,
                        fullError: error,
                        userId: user.uid,
                        environment: currentEnvironment,
                    });

                    // If it's a permission error and we have more retries, continue
                    if (isPermissionError && attempt < maxRetries) {
                        console.log("[AuthGuard] Permission error - will retry with token refresh");
                        continue;
                    }

                    // Final attempt failed or non-permission error
                    if (attempt === maxRetries) {
                        console.error("[AuthGuard] All retry attempts failed");
                        await logout();
                        router.replace("/login?error=auth-error");
                        return;
                    }
                }
            }
            // Reset checking state when done
            setIsCheckingAdmin(false);
        };

        checkAdminStatus();
    }, [auth, db, user, isLoading, hasAuthChecked, logout, router, currentEnvironment, setPermissions]);

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
