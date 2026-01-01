"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { useFirebase } from "@/lib/FirebaseContext";

interface AuthGuardProps {
    children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
    const router = useRouter();
    const { auth, db, user, isLoading, logout, currentEnvironment, hasAuthChecked } = useFirebase();
    const [isAuthorized, setIsAuthorized] = useState(false);
    const [isCheckingAdmin, setIsCheckingAdmin] = useState(false);

    useEffect(() => {
        // Reset authorization when environment or user changes
        setIsAuthorized(false);
    }, [currentEnvironment, user]);

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
            router.replace("/login");
            return;
        }

        // User exists, check if they're an admin
        const checkAdminStatus = async () => {
            console.log(`[AuthGuard] Checking admin status for ${user.uid} in ${currentEnvironment}`);
            setIsCheckingAdmin(true);

            try {
                const adminDocRef = doc(db, "AdminUsers", user.uid);
                const adminDoc = await getDoc(adminDocRef);

                console.log("[AuthGuard] Admin doc exists:", adminDoc.exists(), "data:", adminDoc.data());

                if (!adminDoc.exists() || adminDoc.data()?.role !== "admin") {
                    console.log(`[AuthGuard] User ${user.uid} is NOT an admin in ${currentEnvironment}`);
                    await logout();
                    router.replace("/login?error=unauthorized");
                    return;
                }

                console.log("[AuthGuard] User IS admin, authorizing");
                setIsAuthorized(true);
            } catch (error) {
                console.error("[AuthGuard] Error checking admin status:", error);
                await logout();
                router.replace("/login?error=auth-error");
            } finally {
                setIsCheckingAdmin(false);
            }
        };

        checkAdminStatus();
    }, [auth, db, user, isLoading, hasAuthChecked, logout, router, currentEnvironment]);

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
