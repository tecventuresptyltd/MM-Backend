"use client";

import { FirebaseProvider } from "@/lib/FirebaseContext";
import { AdminPermissionsProvider } from "@/lib/AdminPermissionsContext";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <FirebaseProvider>
            <AdminPermissionsProvider>
                {children}
            </AdminPermissionsProvider>
        </FirebaseProvider>
    );
}
