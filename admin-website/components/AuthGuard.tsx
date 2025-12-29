"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

interface AuthGuardProps {
    children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [isAuthorized, setIsAuthorized] = useState(false);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
            if (!user) {
                router.push("/login");
                return;
            }

            try {
                // Check if user is an admin
                const adminDocRef = doc(db, "AdminUsers", user.uid);
                const adminDoc = await getDoc(adminDocRef);

                if (!adminDoc.exists() || adminDoc.data()?.role !== "admin") {
                    // User is not an admin
                    await auth.signOut();
                    router.push("/login?error=unauthorized");
                    return;
                }

                setIsAuthorized(true);
            } catch (error) {
                console.error("Error checking admin status:", error);
                await auth.signOut();
                router.push("/login?error=auth-error");
            } finally {
                setLoading(false);
            }
        });

        return () => unsubscribe();
    }, [router]);

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
                    <p className="mt-4 text-gray-600">Verifying credentials...</p>
                </div>
            </div>
        );
    }

    if (!isAuthorized) {
        return null;
    }

    return <>{children}</>;
}
