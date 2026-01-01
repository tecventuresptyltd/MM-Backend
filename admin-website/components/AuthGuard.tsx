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
    const { auth, db, user, isLoading, logout, currentEnvironment } = useFirebase();
    const [isAuthorized, setIsAuthorized] = useState(false);
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        const checkAuth = async () => {
            console.log("[AuthGuard] checkAuth called", {
                isLoading,
                hasAuth: !!auth,
                hasDb: !!db,
                hasUser: !!user,
                currentEnvironment
            });

            // Wait for Firebase to initialize
            if (isLoading || !auth || !db) {
                console.log("[AuthGuard] Still loading, waiting...");
                return;
            }

            setChecking(true);

            if (!user) {
                // Not logged in - redirect to login
                console.log("[AuthGuard] No user, redirecting to login");
                router.push("/login");
                return;
            }

            console.log(`[AuthGuard] Checking admin status for ${user.uid} in ${currentEnvironment}`);

            try {
                // Check if user is an admin in this environment
                const adminDocRef = doc(db, "AdminUsers", user.uid);
                console.log("[AuthGuard] Fetching admin doc...");
                const adminDoc = await getDoc(adminDocRef);

                console.log("[AuthGuard] Admin doc exists:", adminDoc.exists(), "data:", adminDoc.data());

                if (!adminDoc.exists() || adminDoc.data()?.role !== "admin") {
                    // User is not an admin in this environment
                    console.log(`[AuthGuard] User ${user.uid} is NOT an admin in ${currentEnvironment}`);
                    await logout();
                    router.push("/login?error=unauthorized");
                    return;
                }

                console.log("[AuthGuard] User IS admin, authorizing");
                setIsAuthorized(true);
            } catch (error) {
                console.error("[AuthGuard] Error checking admin status:", error);
                await logout();
                router.push("/login?error=auth-error");
            } finally {
                setChecking(false);
            }
        };

        checkAuth();
    }, [auth, db, user, isLoading, logout, router, currentEnvironment]);

    if (isLoading || checking) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-black">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
                    <p className="mt-4 text-gray-400">Verifying credentials...</p>
                </div>
            </div>
        );
    }

    if (!isAuthorized) {
        return null;
    }

    return <>{children}</>;
}

