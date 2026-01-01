"use client";

import { FirebaseProvider } from "@/lib/FirebaseContext";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <FirebaseProvider>
            {children}
        </FirebaseProvider>
    );
}
