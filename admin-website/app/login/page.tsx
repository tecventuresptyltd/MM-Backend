"use client";

import { useState, Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useFirebase } from "@/lib/FirebaseContext";
import { environments, Environment } from "@/lib/environments";

function LoginForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { auth, user, isLoading, currentEnvironment, setEnvironment } = useFirebase();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const queryError = searchParams.get("error");
    const config = environments[currentEnvironment];

    // Redirect if already logged in
    useEffect(() => {
        if (!isLoading && user) {
            router.push("/");
        }
    }, [user, isLoading, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        if (!auth) {
            setError("Firebase not initialized");
            setLoading(false);
            return;
        }

        try {
            console.log("[Login] Attempting login for", email, "to", currentEnvironment);
            await signInWithEmailAndPassword(auth, email, password);
            console.log("[Login] Login successful, waiting for auth state to sync...");
            // Don't redirect here - the useEffect will handle it when user state updates
            // This prevents a race condition where we redirect before FirebaseContext syncs the user
        } catch (err: any) {
            console.error("Login error:", err);
            if (err.code === "auth/wrong-password" || err.code === "auth/user-not-found" || err.code === "auth/invalid-credential") {
                setError("Invalid email or password");
            } else if (err.code === "auth/too-many-requests") {
                setError("Too many failed attempts. Please try again later.");
            } else {
                setError(`An error occurred: ${err.message}`);
            }
        } finally {
            setLoading(false);
        }
    };

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-black">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
            </div>
        );
    }

    return (
        <div
            className="min-h-screen flex items-center justify-center relative overflow-hidden"
            style={{
                backgroundImage: 'url(/game-bg.png)',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat'
            }}
        >
            {/* Dark overlay for better contrast */}
            <div className="absolute inset-0 bg-gradient-to-br from-black/70 via-black/60 to-black/80 backdrop-blur-sm" />

            {/* Login Card */}
            <div className="relative z-10 bg-gradient-to-br from-gray-900/90 to-gray-800/90 backdrop-blur-xl p-8 sm:p-10 rounded-3xl shadow-2xl border border-gray-700/50 w-full max-w-md mx-4">
                {/* Environment Selector */}
                <div className="mb-6 flex items-center justify-center gap-2">
                    <span className="text-gray-400 text-sm">Environment:</span>
                    <select
                        value={currentEnvironment}
                        onChange={(e) => setEnvironment(e.target.value as Environment)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-semibold cursor-pointer border transition ${currentEnvironment === "prod"
                            ? "bg-red-900/50 border-red-700/50 text-red-300"
                            : "bg-green-900/50 border-green-700/50 text-green-300"
                            }`}
                    >
                        <option value="sandbox">🛠️ Sandbox (Dev)</option>
                        <option value="prod">⚠️ Production</option>
                    </select>
                </div>

                <div className="text-center mb-8">
                    <div className="flex justify-center mb-4">
                        <div className="bg-gradient-to-br from-blue-500 to-purple-600 p-4 rounded-2xl shadow-lg shadow-blue-500/50">
                            <svg
                                className="w-12 h-12 text-white"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                />
                            </svg>
                        </div>
                    </div>
                    <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                        Mystic Motors Admin
                    </h1>
                    <p className="text-gray-400">
                        Sign in to <span className={config.color}>{config.displayName}</span>
                    </p>
                </div>

                {currentEnvironment === "prod" && (
                    <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 backdrop-blur-sm shadow-lg shadow-red-500/20">
                        ⚠️ You are logging into <strong>PRODUCTION</strong>. Changes will affect real players.
                    </div>
                )}

                {queryError === "unauthorized" && (
                    <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 backdrop-blur-sm shadow-lg shadow-red-500/20">
                        You do not have admin privileges in this environment.
                    </div>
                )}

                {queryError === "auth-error" && (
                    <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 backdrop-blur-sm shadow-lg shadow-red-500/20">
                        Authentication error. Please try again.
                    </div>
                )}

                {error && (
                    <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 backdrop-blur-sm shadow-lg shadow-red-500/20">
                        {error}
                    </div>
                )}

                <form onSubmit={handleLogin} className="space-y-6">
                    <div>
                        <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">
                            Email Address
                        </label>
                        <input
                            id="email"
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-900/50 border border-gray-700/50 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-gray-500"
                            placeholder="admin@example.com"
                        />
                    </div>

                    <div>
                        <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-2">
                            Password
                        </label>
                        <input
                            id="password"
                            type="password"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-4 py-3 bg-gray-900/50 border border-gray-700/50 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition placeholder-gray-500"
                            placeholder="••••••••"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className={`w-full py-3 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg ${currentEnvironment === "prod"
                            ? "bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 hover:shadow-red-500/50"
                            : "bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 hover:shadow-blue-500/50"
                            } text-white`}
                    >
                        {loading ? "Signing in..." : `Sign In to ${config.displayName}`}
                    </button>
                </form>

                <div className="mt-8 text-center text-sm text-gray-500">
                    <p>Admin access only • Contact support for access</p>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-black"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div></div>}>
            <LoginForm />
        </Suspense>
    );
}

