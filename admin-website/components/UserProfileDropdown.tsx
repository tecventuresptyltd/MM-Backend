"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { doc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { signOut } from "firebase/auth";
import { useFirebase } from "@/lib/FirebaseContext";
import { useAdminPermissions } from "@/lib/AdminPermissionsContext";
import Image from "next/image";

export default function UserProfileDropdown() {
    const router = useRouter();
    const { auth, db, storage, user } = useFirebase();
    const { permissions, setPermissions } = useAdminPermissions();
    const [isOpen, setIsOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editDisplayName, setEditDisplayName] = useState(permissions.displayName || "");
    const [isUploading, setIsUploading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Update edit form when permissions change
    useEffect(() => {
        setEditDisplayName(permissions.displayName || "");
    }, [permissions.displayName]);

    const handleLogout = async () => {
        try {
            if (auth) {
                await signOut(auth);
            }
            router.push("/login");
        } catch (error) {
            console.error("Logout error:", error);
        }
    };

    const handlePhotoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !user || !storage || !db) return;

        setIsUploading(true);
        try {
            // Upload to Firebase Storage
            const storageRef = ref(storage, `admin-avatars/${user.uid}`);
            await uploadBytes(storageRef, file);
            const photoURL = await getDownloadURL(storageRef);

            // Update Firestore
            const adminDocRef = doc(db, "AdminUsers", user.uid);
            await updateDoc(adminDocRef, { photoURL });

            // Update local permissions
            setPermissions({ ...permissions, photoURL });
        } catch (error) {
            console.error("Error uploading photo:", error);
        } finally {
            setIsUploading(false);
        }
    };

    const handleSaveProfile = async () => {
        if (!user || !db) return;

        setIsSaving(true);
        try {
            const adminDocRef = doc(db, "AdminUsers", user.uid);
            await updateDoc(adminDocRef, { displayName: editDisplayName });

            // Update local permissions
            setPermissions({ ...permissions, displayName: editDisplayName });
            setIsEditModalOpen(false);
        } catch (error) {
            console.error("Error saving profile:", error);
        } finally {
            setIsSaving(false);
        }
    };

    // Get initials for avatar fallback
    const getInitials = (name?: string) => {
        if (!name) return "?";
        return name
            .split(" ")
            .map(word => word[0])
            .join("")
            .toUpperCase()
            .slice(0, 2);
    };

    return (
        <>
            <div className="relative" ref={dropdownRef}>
                {/* Avatar Button */}
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/10 transition-all duration-200"
                >
                    <div className="hidden sm:block text-right">
                        <p className="text-sm font-medium text-white leading-tight">
                            {permissions.displayName || "Admin"}
                        </p>
                        <p className="text-xs text-gray-400 leading-tight">
                            {permissions.email}
                        </p>
                    </div>
                    <div className="relative w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center ring-2 ring-white/20 hover:ring-white/40 transition">
                        {permissions.photoURL ? (
                            <Image
                                src={permissions.photoURL}
                                alt="Profile"
                                fill
                                className="object-cover"
                            />
                        ) : (
                            <span className="text-white font-semibold text-sm">
                                {getInitials(permissions.displayName)}
                            </span>
                        )}
                    </div>
                    <svg
                        className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </button>

                {/* Dropdown Menu */}
                {isOpen && (
                    <div className="absolute right-0 mt-2 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl py-2 z-[100] animate-in fade-in slide-in-from-top-2 duration-200">
                        {/* User Info */}
                        <div className="px-4 py-3 border-b border-gray-700">
                            <div className="flex items-center gap-3">
                                <div className="relative w-12 h-12 rounded-full overflow-hidden bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center">
                                    {permissions.photoURL ? (
                                        <Image
                                            src={permissions.photoURL}
                                            alt="Profile"
                                            fill
                                            className="object-cover"
                                        />
                                    ) : (
                                        <span className="text-white font-semibold">
                                            {getInitials(permissions.displayName)}
                                        </span>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-white truncate">
                                        {permissions.displayName || "Admin"}
                                    </p>
                                    <p className="text-sm text-gray-400 truncate">
                                        {permissions.email}
                                    </p>
                                    <p className="text-xs text-gray-500 capitalize">
                                        {permissions.role}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Menu Items */}
                        <div className="py-2">
                            <button
                                onClick={() => {
                                    setIsOpen(false);
                                    setIsEditModalOpen(true);
                                }}
                                className="w-full px-4 py-2.5 text-left text-gray-300 hover:bg-white/5 hover:text-white flex items-center gap-3 transition"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                </svg>
                                Edit Profile
                            </button>
                        </div>

                        {/* Logout */}
                        <div className="border-t border-gray-700 pt-2">
                            <button
                                onClick={handleLogout}
                                className="w-full px-4 py-2.5 text-left text-red-400 hover:bg-red-950/50 hover:text-red-300 flex items-center gap-3 transition"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                                </svg>
                                Logout
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Edit Profile Modal - Using Portal to escape header stacking context */}
            {isEditModalOpen && createPortal(
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[9999] backdrop-blur-sm p-4">
                    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl my-auto">
                        <h2 className="text-xl font-bold text-white mb-6">Edit Profile</h2>

                        {/* Avatar Upload */}
                        <div className="flex flex-col items-center mb-6">
                            <div className="relative w-24 h-24 rounded-full overflow-hidden bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center mb-3">
                                {permissions.photoURL ? (
                                    <Image
                                        src={permissions.photoURL}
                                        alt="Profile"
                                        fill
                                        className="object-cover"
                                    />
                                ) : (
                                    <span className="text-white font-bold text-2xl">
                                        {getInitials(permissions.displayName)}
                                    </span>
                                )}
                                {isUploading && (
                                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
                                    </div>
                                )}
                            </div>
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handlePhotoUpload}
                                accept="image/*"
                                className="hidden"
                            />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploading}
                                className="text-sm text-blue-400 hover:text-blue-300 transition disabled:opacity-50"
                            >
                                {isUploading ? "Uploading..." : "Change Photo"}
                            </button>
                        </div>

                        {/* Display Name */}
                        <div className="mb-6">
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Display Name
                            </label>
                            <input
                                type="text"
                                value={editDisplayName}
                                onChange={(e) => setEditDisplayName(e.target.value)}
                                className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                placeholder="Enter display name"
                            />
                        </div>

                        {/* Email (read-only) */}
                        <div className="mb-6">
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Email
                            </label>
                            <input
                                type="email"
                                value={permissions.email || ""}
                                disabled
                                className="w-full px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-lg text-gray-400 cursor-not-allowed"
                            />
                        </div>

                        {/* Actions */}
                        <div className="flex gap-3">
                            <button
                                onClick={() => setIsEditModalOpen(false)}
                                className="flex-1 px-4 py-3 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition font-medium"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveProfile}
                                disabled={isSaving}
                                className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-semibold disabled:opacity-50"
                            >
                                {isSaving ? "Saving..." : "Save Changes"}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}
