"use client";

import React, { createContext, useContext, useState } from "react";

// Admin permissions interface
export interface AdminPermissions {
    canViewAnalytics: boolean;
    displayName?: string;
    email?: string;
    photoURL?: string;
    role?: string;
}

// Default permissions (restrictive by default)
const DEFAULT_PERMISSIONS: AdminPermissions = {
    canViewAnalytics: false,
    displayName: undefined,
    email: undefined,
    photoURL: undefined,
    role: undefined,
};

interface AdminPermissionsContextType {
    permissions: AdminPermissions;
    setPermissions: (permissions: AdminPermissions) => void;
}

const AdminPermissionsContext = createContext<AdminPermissionsContextType>({
    permissions: DEFAULT_PERMISSIONS,
    setPermissions: () => { },
});

export function AdminPermissionsProvider({ children }: { children: React.ReactNode }) {
    const [permissions, setPermissions] = useState<AdminPermissions>(DEFAULT_PERMISSIONS);

    return (
        <AdminPermissionsContext.Provider value={{ permissions, setPermissions }}>
            {children}
        </AdminPermissionsContext.Provider>
    );
}

export function useAdminPermissions() {
    const context = useContext(AdminPermissionsContext);
    if (!context) {
        throw new Error("useAdminPermissions must be used within an AdminPermissionsProvider");
    }
    return context;
}

export { DEFAULT_PERMISSIONS };
