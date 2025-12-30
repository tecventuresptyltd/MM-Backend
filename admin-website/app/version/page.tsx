"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
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
            <div className="min-h-screen bg-gray-50">
                {/* Header */}
                <header className="bg-white shadow-sm border-b">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
                        <div className="flex items-center">
                            <button
                                onClick={() => router.push("/")}
                                className="mr-4 p-2 hover:bg-gray-100 rounded-lg transition"
                            >
                                <svg
                                    className="w-6 h-6 text-gray-600"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M15 19l-7-7 7-7"
                                    />
                                </svg>
                            </button>
                            <h1 className="text-2xl font-bold text-gray-900">
                                Version Control
                            </h1>
                        </div>
                    </div>
                </header>

                {/* Main Content */}
                <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
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

                    {/* Current Version Card */}
                    <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-6">
                        <h3 className="text-lg font-semibold text-blue-900 mb-3">
                            Current Minimum Version
                        </h3>
                        <div className="flex items-center">
                            <span className="text-3xl font-bold text-blue-700">
                                {currentVersion}
                            </span>
                        </div>
                        <p className="text-sm text-blue-600 mt-2">
                            Players with app versions below this will be forced to update
                        </p>
                    </div>

                    {/* Warning Card */}
                    <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                        <div className="flex">
                            <svg
                                className="w-6 h-6 text-yellow-600 mr-3 flex-shrink-0"
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
                                <h4 className="text-sm font-semibold text-yellow-900 mb-1">
                                    Important Note
                                </h4>
                                <p className="text-sm text-yellow-800">
                                    This value is currently stored in Firestore for tracking. The actual version enforcement
                                    uses the <code className="bg-yellow-100 px-1 rounded">MIN_SUPPORTED_APP_VERSION</code> environment
                                    variable. After updating here, you may need to update the environment variable and redeploy
                                    the backend functions for full enforcement.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Update Version Card */}
                    <div className="bg-white rounded-lg shadow-lg p-8">
                        <h2 className="text-xl font-semibold text-gray-900 mb-6">
                            Update Minimum Version
                        </h2>

                        <div className="space-y-6">
                            <div>
                                <label htmlFor="version" className="block text-sm font-medium text-gray-700 mb-2">
                                    New Minimum Version
                                </label>
                                <input
                                    id="version"
                                    type="text"
                                    value={newVersion}
                                    onChange={(e) => handleVersionChange(e.target.value)}
                                    className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${versionError ? "border-red-300" : "border-gray-300"
                                        }`}
                                    placeholder="1.2.3"
                                />
                                {versionError && (
                                    <p className="mt-2 text-sm text-red-600">{versionError}</p>
                                )}
                                <p className="text-sm text-gray-500 mt-2">
                                    Format: X.Y.Z (e.g., 1.2.3)
                                </p>
                            </div>

                            <div className="bg-gray-50 rounded-lg p-4">
                                <h3 className="text-sm font-semibold text-gray-900 mb-2">
                                    What happens when you update:
                                </h3>
                                <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside">
                                    <li>Players with older versions will be prompted to update</li>
                                    <li>They cannot use the game until they update to the minimum version or higher</li>
                                    <li>The change takes effect immediately</li>
                                </ul>
                            </div>

                            <button
                                onClick={handleUpdate}
                                disabled={loading || !!versionError || !newVersion}
                                className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                            >
                                {loading ? "Updating..." : "Update Minimum Version"}
                            </button>
                        </div>
                    </div>

                    {/* Version History */}
                    <div className="mt-8 bg-white rounded-lg shadow-lg p-8">
                        <h2 className="text-xl font-semibold text-gray-900 mb-6">
                            Version History
                        </h2>

                        {versionHistory.length === 0 ? (
                            <p className="text-gray-500 text-center py-8">No version history yet</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-200">
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Changed At</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Old Version</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">New Version</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Changed By</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {versionHistory.map((event, index) => (
                                            <tr
                                                key={event.id}
                                                className={`border-b border-gray-100 hover:bg-gray-50 ${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                                            >
                                                <td className="py-3 px-4 text-sm text-gray-900">
                                                    {new Date(event.changedAt).toLocaleString()}
                                                </td>
                                                <td className="py-3 px-4 text-sm text-gray-600">
                                                    {event.oldVersion || "—"}
                                                </td>
                                                <td className="py-3 px-4 text-sm font-semibold text-green-600">
                                                    {event.newVersion}
                                                </td>
                                                <td className="py-3 px-4 text-sm text-gray-600">
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
