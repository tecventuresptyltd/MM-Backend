"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import PageHeader from "@/components/PageHeader";
import { callFunction } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

export default function VersionPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [currentVersion, setCurrentVersion] = useState("");
    const [newVersion, setNewVersion] = useState("");
    const [success, setSuccess] = useState("");
    const [error, setError] = useState("");
    const [versionError, setVersionError] = useState("");
    const [versionHistory, setVersionHistory] = useState<any[]>([]);

    useEffect(() => {
        loadCurrentVersion();
        loadVersionHistory();
    }, []);

    const loadCurrentVersion = async () => {
        try {
            const versionRef = doc(db, "GameConfig", "appVersion");
            const versionDoc = await getDoc(versionRef);

            if (versionDoc.exists()) {
                const data = versionDoc.data();
                setCurrentVersion(data.minimumVersion || "Not set");
            } else {
                setCurrentVersion("Not set");
            }
        } catch (err) {
            console.error("Error loading version:", err);
            setCurrentVersion("Error loading");
        }
    };

    const loadVersionHistory = async () => {
        try {
            const { collection, query, orderBy, limit, getDocs } = await import("firebase/firestore");
            const historyRef = collection(db, "VersionHistory");
            const q = query(historyRef, orderBy("changedAt", "desc"), limit(20));
            const snapshot = await getDocs(q);
            const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setVersionHistory(history);
        } catch (err) {
            console.error("Error loading version history:", err);
        }
    };

    const validateVersion = (version: string): boolean => {
        const versionRegex = /^\d+\.\d+\.\d+$/;
        return versionRegex.test(version);
    };

    const handleVersionChange = (value: string) => {
        setNewVersion(value);
        if (value && !validateVersion(value)) {
            setVersionError("Version must be in format X.Y.Z (e.g., 1.2.3)");
        } else {
            setVersionError("");
        }
    };

    const handleUpdate = async () => {
        if (!newVersion) {
            setError("Please enter a version number");
            return;
        }

        if (!validateVersion(newVersion)) {
            setError("Invalid version format. Use X.Y.Z format (e.g., 1.2.3)");
            return;
        }

        setError("");
        setSuccess("");
        setLoading(true);

        try {
            const response = await callFunction("setMinimumVersion", {
                version: newVersion
            });

            setSuccess("Minimum version updated successfully!");
            await loadCurrentVersion();
            await loadVersionHistory();
            setNewVersion("");

            setTimeout(() => setSuccess(""), 3000);
        } catch (err: any) {
            console.error("Error updating version:", err);
            setError(err.message || "Failed to update minimum version");
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthGuard>
            <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black">
                <PageHeader title="Version Control" />

                {/* Main Content */}
                <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
                    {success && (
                        <div className="mb-6 p-4 bg-green-900/30 border border-green-500/50 rounded-xl text-green-300 backdrop-blur-sm shadow-lg shadow-green-500/20">
                            {success}
                        </div>
                    )}

                    {error && (
                        <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 backdrop-blur-sm shadow-lg shadow-red-500/20">
                            {error}
                        </div>
                    )}

                    {/* Current Version Card */}
                    <div className="mb-6 bg-gradient-to-br from-blue-900/40 to-blue-800/20 backdrop-blur-sm border border-blue-700/30 rounded-2xl p-6 shadow-2xl">
                        <h3 className="text-lg font-semibold text-blue-300 mb-3">
                            Current Minimum Version
                        </h3>
                        <div className="flex items-center">
                            <span className="text-3xl font-bold text-blue-200">
                                {currentVersion}
                            </span>
                        </div>
                        <p className="text-sm text-blue-400 mt-2">
                            Players with app versions below this will be forced to update
                        </p>
                    </div>

                    {/* Warning Card */}
                    <div className="mb-6 bg-yellow-900/30 border border-yellow-500/50 rounded-xl p-6 backdrop-blur-sm shadow-lg">
                        <div className="flex">
                            <svg
                                className="w-6 h-6 text-yellow-400 mr-3 flex-shrink-0"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                />
                            </svg>
                            <div>
                                <h4 className="text-sm font-semibold text-yellow-300 mb-1">
                                    Important Note
                                </h4>
                                <p className="text-sm text-yellow-400">
                                    This value is currently stored in Firestore for tracking. The actual version enforcement
                                    uses the <code className="bg-yellow-900/50 px-1 rounded text-yellow-200">MIN_SUPPORTED_APP_VERSION</code> environment
                                    variable. After updating here, you may need to update the environment variable and redeploy
                                    the backend functions for full enforcement.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Update Version Card */}
                    <div className="bg-gradient-to-br from-gray-800/40 to-gray-700/20 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-gray-700/30">
                        <h2 className="text-xl font-semibold text-white mb-6">
                            Update Minimum Version
                        </h2>

                        <div className="space-y-6">
                            <div>
                                <label htmlFor="version" className="block text-sm font-medium text-gray-300 mb-2">
                                    New Minimum Version
                                </label>
                                <input
                                    id="version"
                                    type="text"
                                    value={newVersion}
                                    onChange={(e) => handleVersionChange(e.target.value)}
                                    className={`w-full px-4 py-3 bg-gray-900/50 border text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${versionError ? "border-red-500/50" : "border-gray-700/50"
                                        }`}
                                    placeholder="1.2.3"
                                />
                                {versionError && (
                                    <p className="mt-2 text-sm text-red-400">{versionError}</p>
                                )}
                                <p className="text-sm text-gray-400 mt-2">
                                    Format: X.Y.Z (e.g., 1.2.3)
                                </p>
                            </div>

                            <div className="bg-gray-900/30 rounded-xl p-4 border border-gray-700/50">
                                <h3 className="text-sm font-semibold text-white mb-2">
                                    What happens when you update:
                                </h3>
                                <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
                                    <li>Players with older versions will be prompted to update</li>
                                    <li>They cannot use the game until they update to the minimum version or higher</li>
                                    <li>The change takes effect immediately</li>
                                </ul>
                            </div>

                            <button
                                onClick={handleUpdate}
                                disabled={loading || !!versionError || !newVersion}
                                className="w-full bg-green-600/90 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-green-500/50"
                            >
                                {loading ? "Updating..." : "Update Minimum Version"}
                            </button>
                        </div>
                    </div>

                    {/* Version History */}
                    <div className="mt-8 bg-gradient-to-br from-gray-800/40 to-gray-700/20 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-gray-700/30">
                        <h2 className="text-xl font-semibold text-white mb-6">
                            Version History
                        </h2>

                        {versionHistory.length === 0 ? (
                            <p className="text-gray-400 text-center py-8">No version history yet</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-700/50">
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Changed At</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Old Version</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">New Version</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Changed By</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {versionHistory.map((event, index) => (
                                            <tr
                                                key={event.id}
                                                className={`border-b border-gray-700/30 hover:bg-gray-800/30 transition ${index % 2 === 0 ? 'bg-gray-800/10' : 'bg-gray-800/20'}`}
                                            >
                                                <td className="py-3 px-4 text-sm text-gray-300">
                                                    {new Date(event.changedAt).toLocaleString()}
                                                </td>
                                                <td className="py-3 px-4 text-sm text-gray-400">
                                                    {event.oldVersion || "—"}
                                                </td>
                                                <td className="py-3 px-4 text-sm font-semibold text-green-400">
                                                    {event.newVersion}
                                                </td>
                                                <td className="py-3 px-4 text-sm text-gray-400">
                                                    {event.changedBy}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </main>
            </div>
        </AuthGuard>
    );
}
