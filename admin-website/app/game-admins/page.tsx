"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import PageHeader from "@/components/PageHeader";
import { callFunction } from "@/lib/firebase";

export default function GameAdminsPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [currentAdmins, setCurrentAdmins] = useState<any[]>([]);
    const [success, setSuccess] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        loadCurrentAdmins();
    }, []);

    const loadCurrentAdmins = async () => {
        try {
            const response = await callFunction("getGameAdmins", {});
            setCurrentAdmins(response.data?.admins || []);
        } catch (err) {
            console.error("Error loading admins:", err);
        }
    };

    const handleSearch = async () => {
        if (!searchQuery.trim()) {
            setError("Please enter a search query");
            return;
        }

        setError("");
        setSuccess("");
        setLoading(true);

        try {
            const response = await callFunction("searchGameUsers", {
                query: searchQuery,
                limit: 20
            });

            setSearchResults(response.data?.users || []);

            if (!response.data?.users || response.data.users.length === 0) {
                setError("No users found matching your search");
            }
        } catch (err: any) {
            console.error("Error searching users:", err);
            setError(err.message || "Failed to search users");
        } finally {
            setLoading(false);
        }
    };

    const handleToggleAdmin = async (uid: string, currentStatus: boolean) => {
        setError("");
        setSuccess("");
        setLoading(true);

        try {
            await callFunction("setGameAdminStatus", {
                targetUid: uid,
                isGameAdmin: !currentStatus
            });

            setSuccess(`Successfully ${currentStatus ? 'removed' : 'granted'} game admin status`);

            // Refresh both lists
            await loadCurrentAdmins();
            if (searchQuery) {
                await handleSearch();
            }

            setTimeout(() => setSuccess(""), 3000);
        } catch (err: any) {
            console.error("Error toggling admin status:", err);
            setError(err.message || "Failed to update admin status");
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthGuard>
            <div className="min-h-screen bg-gray-50">
                <PageHeader title="Game Admin Management" subtitle="Manage which players can bypass maintenance mode for testing" />

                {/* Main Content */}
                <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

                    {/* Success/Error Messages */}
                    {success && (
                        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg text-green-700">
                            {success}
                        </div>
                    )}

                    {error && (
                        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                            {error}
                        </div>
                    )}

                    {/* Search Section */}
                    <div className="bg-white rounded-lg shadow-sm p-6 mb-8">
                        <h2 className="text-xl font-semibold text-gray-900 mb-4">
                            Search Users
                        </h2>
                        <div className="flex gap-4">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                                placeholder="Search by username, email, or UID..."
                                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                            />
                            <button
                                onClick={handleSearch}
                                disabled={loading}
                                className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                            >
                                {loading ? "Searching..." : "Search"}
                            </button>
                        </div>

                        {/* Search Results */}
                        {searchResults.length > 0 && (
                            <div className="mt-6">
                                <h3 className="text-lg font-medium text-gray-900 mb-3">
                                    Search Results ({searchResults.length})
                                </h3>
                                <div className="space-y-2">
                                    {searchResults.map((user) => (
                                        <div
                                            key={user.uid}
                                            className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200"
                                        >
                                            <div>
                                                <div className="font-medium text-gray-900">
                                                    {user.username}
                                                    {user.isGameAdmin && (
                                                        <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded">
                                                            GAME ADMIN
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-sm text-gray-600">
                                                    {user.email}
                                                </div>
                                                <div className="text-xs text-gray-500 mt-1">
                                                    UID: {user.uid}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => handleToggleAdmin(user.uid, user.isGameAdmin)}
                                                disabled={loading}
                                                className={`px-4 py-2 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${user.isGameAdmin
                                                    ? "bg-red-100 text-red-700 hover:bg-red-200"
                                                    : "bg-green-100 text-green-700 hover:bg-green-200"
                                                    }`}
                                            >
                                                {user.isGameAdmin ? "Remove Admin" : "Make Admin"}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Current Game Admins */}
                    <div className="bg-white rounded-lg shadow-sm p-6">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-xl font-semibold text-gray-900">
                                Current Game Admins ({currentAdmins.length})
                            </h2>
                            <button
                                onClick={loadCurrentAdmins}
                                className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                            >
                                Refresh
                            </button>
                        </div>

                        {currentAdmins.length === 0 ? (
                            <p className="text-gray-500 text-center py-8">
                                No game admins configured yet
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {currentAdmins.map((admin) => (
                                    <div
                                        key={admin.uid}
                                        className="flex items-center justify-between p-4 bg-blue-50 rounded-lg border border-blue-200"
                                    >
                                        <div>
                                            <div className="font-medium text-gray-900">
                                                {admin.username}
                                                <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded">
                                                    GAME ADMIN
                                                </span>
                                            </div>
                                            <div className="text-sm text-gray-600">
                                                {admin.email}
                                            </div>
                                            <div className="text-xs text-gray-500 mt-1">
                                                UID: {admin.uid}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleToggleAdmin(admin.uid, true)}
                                            disabled={loading}
                                            className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            Remove Admin
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Info Box */}
                    <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <h3 className="font-semibold text-blue-900 mb-2">ℹ️ About Game Admins</h3>
                        <ul className="text-sm text-blue-800 space-y-1">
                            <li>• Game admins can bypass maintenance mode to test the game during downtime</li>
                            <li>• They do NOT get access to this admin dashboard (Firebase admin only)</li>
                            <li>• Use this to allow your QA team to test during scheduled maintenance</li>
                            <li>• Game admin status is stored in Firebase under /Players/{'{'}uid{'}'}/Profile/info</li>
                        </ul>
                    </div>
                </main>
            </div>
        </AuthGuard>
    );
}
