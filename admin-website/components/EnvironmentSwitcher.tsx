"use client";

import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useFirebase } from "@/lib/FirebaseContext";
import { Environment, environments } from "@/lib/environments";

export default function EnvironmentSwitcher() {
    const { currentEnvironment, setEnvironment, isProd } = useFirebase();
    const [showConfirm, setShowConfirm] = useState(false);
    const [pendingEnv, setPendingEnv] = useState<Environment | null>(null);
    const [mounted, setMounted] = useState(false);

    // Only render portal on client side
    useEffect(() => {
        setMounted(true);
    }, []);

    const handleEnvChange = (env: Environment) => {
        if (env === "prod" && currentEnvironment !== "prod") {
            // Show confirmation before switching to prod
            setPendingEnv(env);
            setShowConfirm(true);
        } else {
            setEnvironment(env);
        }
    };

    const confirmSwitch = () => {
        if (pendingEnv) {
            setEnvironment(pendingEnv);
        }
        setShowConfirm(false);
        setPendingEnv(null);
    };

    const cancelSwitch = () => {
        setShowConfirm(false);
        setPendingEnv(null);
    };

    const config = environments[currentEnvironment];

    // Modal rendered via Portal at document body
    const modal = showConfirm && mounted ? createPortal(
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center backdrop-blur-sm" style={{ zIndex: 99999 }}>
            <div className="bg-gray-900 border border-red-700/50 rounded-2xl p-8 max-w-md mx-4 shadow-2xl">
                <div className="flex items-center gap-3 mb-4">
                    <span className="text-4xl">⚠️</span>
                    <h2 className="text-2xl font-bold text-red-400">Production Warning</h2>
                </div>

                <p className="text-gray-300 mb-4">
                    You are about to switch to the <strong className="text-red-400">LIVE production environment</strong>.
                </p>

                <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 mb-6">
                    <p className="text-red-300 text-sm">
                        <strong>⚠️ Any changes you make will affect real players!</strong>
                    </p>
                    <ul className="text-red-300/80 text-sm mt-2 list-disc list-inside">
                        <li>Maintenance mode will take the live game offline</li>
                        <li>Version changes will force player updates</li>
                        <li>Admin changes affect production access</li>
                    </ul>
                </div>

                <div className="flex gap-3">
                    <button
                        onClick={cancelSwitch}
                        className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition font-medium"
                    >
                        Stay in Sandbox
                    </button>
                    <button
                        onClick={confirmSwitch}
                        className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition font-medium"
                    >
                        Switch to Production
                    </button>
                </div>
            </div>
        </div>,
        document.body
    ) : null;

    return (
        <>
            <div className="relative flex items-center gap-2">
                {/* Environment Badge */}
                <div className={`px-3 py-1.5 rounded-lg ${config.bgColor} ${config.borderColor} border`}>
                    <span className={`text-sm font-semibold ${config.color}`}>
                        {isProd ? "⚠️ " : "🛠️ "}{config.displayName}
                    </span>
                </div>

                {/* Environment Dropdown */}
                <select
                    value={currentEnvironment}
                    onChange={(e) => handleEnvChange(e.target.value as Environment)}
                    className="bg-gray-800 border border-gray-600 text-white text-sm rounded-lg px-3 py-1.5 cursor-pointer hover:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                    <option value="sandbox">Sandbox (Dev)</option>
                    <option value="prod">Production</option>
                </select>
            </div>

            {modal}
        </>
    );
}
