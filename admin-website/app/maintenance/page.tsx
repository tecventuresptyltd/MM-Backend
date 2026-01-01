"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import PageHeader from "@/components/PageHeader";
import { useFirebase, useProductionConfirm } from "@/lib/FirebaseContext";
import { doc, getDoc } from "firebase/firestore";

export default function MaintenancePage() {
    const router = useRouter();
    const { db, callFunction, isProd, environmentConfig } = useFirebase();
    const confirmProd = useProductionConfirm();
    const [loading, setLoading] = useState(false);
    const [currentStatus, setCurrentStatus] = useState<any>(null);
    const [maintenance, setMaintenance] = useState(false);
    // rewardAvailable removed - rewards are now auto-credited
    const [rewardGems, setRewardGems] = useState(100);
    const [immediate, setImmediate] = useState(true); // Default to immediate activation
    const [delayMinutes, setDelayMinutes] = useState(1); // Default to 1 minute (minimum)
    const [durationHours, setDurationHours] = useState(0); // Duration hours
    const [durationMinutes, setDurationMinutes] = useState(30); // Duration minutes (default 30min)
    const [countdown, setCountdown] = useState<string>(""); // Countdown timer display
    const [runningTimer, setRunningTimer] = useState<string>(""); // Running timer (how long active)
    const [maintenanceHistory, setMaintenanceHistory] = useState<any[]>([]);
    const [success, setSuccess] = useState("");
    const [error, setError] = useState("");
    const [showEmergencyConfirm, setShowEmergencyConfirm] = useState(false);

    useEffect(() => {
        loadCurrentStatus();
        loadMaintenanceHistory();
    }, []);

    // Real-time listener for maintenance status changes
    useEffect(() => {
        if (!db) return; // Wait for db to be initialized

        const setupRealtimeListener = async () => {
            const { onSnapshot } = await import("firebase/firestore");
            const maintenanceRef = doc(db, "GameConfig", "maintenance");

            const unsubscribe = onSnapshot(maintenanceRef, (snapshot) => {
                if (snapshot.exists()) {
                    const data = snapshot.data();
                    console.log("[Real-time] Maintenance status updated:", data);

                    // Update all state automatically
                    setCurrentStatus(data);
                    setMaintenance(data.maintenance || false);
                    setRewardGems(data.rewardGems || 100);

                    if (data.delayMinutes && data.delayMinutes >= 1) {
                        setDelayMinutes(data.delayMinutes);
                    }
                }
            }, (error) => {
                console.error("[Real-time] Error listening to maintenance status:", error);
            });

            return unsubscribe;
        };

        let unsubscribe: (() => void) | undefined;
        setupRealtimeListener().then(unsub => { unsubscribe = unsub; });

        // Cleanup
        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, [db]); // Add db as dependency

    // Countdown timer effect (before maintenance activates)
    useEffect(() => {
        if (!currentStatus) return;

        const scheduledTime = currentStatus.scheduledMaintenanceTime;
        if (!scheduledTime) {
            setCountdown("");
            return;
        }

        const updateCountdown = () => {
            const now = Date.now();
            const remaining = scheduledTime - now;

            if (remaining <= 0) {
                setCountdown("");
                return;
            }

            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

            setCountdown(`${hours}h ${minutes}m ${seconds}s`);
        };

        updateCountdown();
        const interval = setInterval(updateCountdown, 1000);

        return () => clearInterval(interval);
    }, [currentStatus]);

    // Running timer effect (when maintenance is ACTIVE)
    useEffect(() => {
        if (!currentStatus?.maintenance && !currentStatus?.enabled) {
            setRunningTimer("");
            return;
        }

        const scheduledTime = currentStatus.scheduledMaintenanceTime;
        if (!scheduledTime) {
            // Immediate maintenance - no scheduled time
            setRunningTimer("");
            return;
        }

        const updateRunning = () => {
            const now = Date.now();

            // Only show running timer if we've passed the scheduled time
            if (now < scheduledTime) {
                setRunningTimer("");
                return;
            }

            const elapsed = now - scheduledTime;
            const hours = Math.floor(elapsed / (1000 * 60 * 60));
            const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);

            setRunningTimer(`${hours}h ${minutes}m ${seconds}s`);
        };

        updateRunning();
        const interval = setInterval(updateRunning, 1000);

        return () => clearInterval(interval);
    }, [currentStatus]);

    const loadCurrentStatus = async () => {
        if (!db) return; // Wait for db to be initialized
        try {
            const maintenanceRef = doc(db, "GameConfig", "maintenance");
            const maintenanceDoc = await getDoc(maintenanceRef);

            if (maintenanceDoc.exists()) {
                const data = maintenanceDoc.data();
                setCurrentStatus(data);
                setMaintenance(data.maintenance || data.enabled || false);
                setRewardGems(data.rewardGems || 100);
                if (data.delayMinutes && data.delayMinutes >= 1) {
                    setDelayMinutes(data.delayMinutes);
                }
            }
        } catch (err) {
            console.error("Error loading maintenance status:", err);
        }
    };

    const loadMaintenanceHistory = async (loadMore = false) => {
        if (!db) return; // Wait for db to be initialized
        try {
            const { collection, query, orderBy, limit, getDocs, startAfter } = await import("firebase/firestore");
            const historyRef = collection(db, "MaintenanceHistory");

            let q;
            if (loadMore && maintenanceHistory.length > 0) {
                // Get the last document for pagination
                const lastDoc = maintenanceHistory[maintenanceHistory.length - 1];
                q = query(historyRef, orderBy("startedAt", "desc"), startAfter(lastDoc.startedAt), limit(10));
            } else {
                q = query(historyRef, orderBy("startedAt", "desc"), limit(10));
            }

            const snapshot = await getDocs(q);
            const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            if (loadMore) {
                setMaintenanceHistory([...maintenanceHistory, ...history]);
            } else {
                setMaintenanceHistory(history);
            }
        } catch (err) {
            console.error("Error loading maintenance history:", err);
        }
    };

    const handleSave = async () => {
        setError("");
        setSuccess("");

        // Confirm production action
        if (isProd) {
            const confirmed = await confirmProd(maintenance ? "enable maintenance mode" : "disable maintenance mode");
            if (!confirmed) return;
        }

        setLoading(true);

        try {
            // Build the request payload
            const payload: any = {
                maintenance: Boolean(maintenance), // Explicit boolean conversion
                rewardGems: Number(rewardGems),
            };

            console.log('[DEBUG] Payload before sending:', payload);
            console.log('[DEBUG] maintenance value:', maintenance, 'type:', typeof maintenance);

            // Only include immediate and delayMinutes when ENABLING maintenance
            if (maintenance) {
                payload.immediate = immediate;
                if (!immediate) {
                    payload.delayMinutes = delayMinutes;
                }
            }
            // Calculate total duration in minutes
            const totalDurationMinutes = (durationHours * 60) + durationMinutes;
            if (totalDurationMinutes > 0) {
                payload.durationMinutes = totalDurationMinutes;
            }

            const response = await callFunction("setMaintenanceMode", payload);

            if (maintenance && !immediate) {
                setSuccess(`Maintenance break scheduled for ${delayMinutes} minutes from now. Players will receive a warning.`);
            } else if (maintenance) {
                setSuccess("Maintenance mode activated immediately!");
            } else {
                setSuccess("Maintenance mode disabled. Players can now access the game.");
            }

            await loadCurrentStatus();

            setTimeout(() => setSuccess(""), 5000);

            // Reload history to show latest event
            await loadMaintenanceHistory();
        } catch (err: any) {
            console.error("Error updating maintenance:", err);
            setError(err.message || "Failed to update maintenance settings");
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthGuard>
            <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black">
                {/* Production Warning Banner */}
                {isProd && (
                    <div className="bg-red-900/80 border-b border-red-700 py-2 px-4 text-center">
                        <span className="text-red-200 text-sm font-medium">
                            ⚠️ You are managing <strong>PRODUCTION</strong> maintenance. Changes will affect live players!
                        </span>
                    </div>
                )}
                <PageHeader title={`Maintenance Mode Control ${isProd ? '(PROD)' : ''}`} />

                {/* Main Content */}
                <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
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

                    {/* Current Status Card */}
                    {currentStatus && (
                        <div className={`mb-6 bg-gradient-to-br ${isProd ? 'from-red-900/40 to-red-800/20 border-red-700/30' : 'from-blue-900/40 to-blue-800/20 border-blue-700/30'} backdrop-blur-sm border rounded-2xl p-6 shadow-2xl`}>
                            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                <h3 className={`text-lg font-semibold ${isProd ? 'text-red-300' : 'text-blue-300'}`}>
                                    Current Status
                                </h3>
                                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${isProd ? 'bg-red-900/60 border border-red-500/50' : 'bg-green-900/60 border border-green-500/50'}`}>
                                    <span className="text-sm">📍</span>
                                    <span className={`text-sm font-semibold ${isProd ? 'text-red-300' : 'text-green-300'}`}>
                                        {environmentConfig.firebase.projectId}
                                    </span>
                                </div>
                            </div>

                            {/* Countdown Timer - Show prominently when scheduled */}
                            {countdown && currentStatus.scheduledMaintenanceTime && (
                                <div className="mb-4 p-4 bg-orange-900/40 border-2 border-orange-500/50 rounded-xl backdrop-blur-sm shadow-lg">
                                    <div className="text-center">
                                        <p className="text-sm font-medium text-orange-300 mb-1">Maintenance Enforcement In:</p>
                                        <p className="text-3xl font-bold text-orange-200">{countdown}</p>
                                        <p className="text-xs text-orange-400 mt-1">Players are currently seeing the warning popup</p>
                                    </div>
                                </div>
                            )}

                            {/* Running Timer - Show when maintenance is ACTIVE */}
                            {runningTimer && (currentStatus.maintenance || currentStatus.enabled) && (
                                <div className="mb-4 p-4 bg-red-900/40 border-2 border-red-500/50 rounded-xl backdrop-blur-sm shadow-lg shadow-red-500/30">
                                    <div className="text-center">
                                        <p className="text-sm font-medium text-red-300 mb-1">🚨 Maintenance ACTIVE For:</p>
                                        <p className="text-3xl font-bold text-red-200">{runningTimer}</p>
                                        <p className="text-xs text-red-400 mt-1">Players are currently blocked from the game</p>
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                    <span className="text-blue-300 font-medium">Maintenance:</span>
                                    <span className={`ml-2 px-3 py-1 rounded-full text-xs font-semibold ${currentStatus.maintenance || currentStatus.enabled
                                        ? "bg-red-900/50 text-red-300 border border-red-500/50"
                                        : "bg-green-900/50 text-green-300 border border-green-500/50"
                                        }`}>
                                        {currentStatus.maintenance || currentStatus.enabled ? "ON" : "OFF"}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-blue-300 font-medium">Reward Gems:</span>
                                    <span className="ml-2 text-blue-200">
                                        {currentStatus.rewardGems || 0}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Emergency Off Button - Show when maintenance is active */}
                    {(currentStatus?.maintenance || currentStatus?.enabled) && (
                        <div className="mb-6 p-4 bg-red-900/30 border-2 border-red-500/50 rounded-xl backdrop-blur-sm shadow-lg shadow-red-500/20">
                            {!showEmergencyConfirm ? (
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h4 className="font-semibold text-red-300">Emergency Stop</h4>
                                        <p className="text-sm text-red-400 mt-1">
                                            Turn off maintenance immediately
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => setShowEmergencyConfirm(true)}
                                        disabled={loading}
                                        className="px-6 py-3 bg-red-600/90 text-white font-semibold rounded-lg hover:bg-red-700 transition shadow-lg hover:shadow-red-500/50 disabled:opacity-50"
                                    >
                                        END MAINTENANCE NOW
                                    </button>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div>
                                        <h4 className="font-semibold text-red-300">⚠️ Confirm Emergency Stop</h4>
                                        <p className="text-sm text-red-400 mt-2">
                                            Are you sure you want to END MAINTENANCE NOW? This will allow all players back into the game immediately.
                                        </p>
                                    </div>
                                    <div className="flex gap-3 justify-end">
                                        <button
                                            onClick={() => setShowEmergencyConfirm(false)}
                                            disabled={loading}
                                            className="px-4 py-2 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={async () => {
                                                console.log("[EMERGENCY] Confirmed, starting shutdown...");
                                                setLoading(true);
                                                setError("");
                                                setSuccess("");

                                                try {
                                                    console.log("[EMERGENCY] Calling setMaintenanceMode with maintenance:false");
                                                    const emergencyResponse = await callFunction("setMaintenanceMode", {
                                                        maintenance: false,  // Changed from 'enabled'
                                                        rewardGems: 0,
                                                    });
                                                    console.log("[EMERGENCY] Cloud function returned:", emergencyResponse);

                                                    setMaintenance(false);
                                                    setSuccess("Maintenance mode disabled. Players can now access the game.");

                                                    console.log("[EMERGENCY] Reloading status and history...");
                                                    await loadCurrentStatus();
                                                    await loadMaintenanceHistory();

                                                    setTimeout(() => setSuccess(""), 5000);
                                                    console.log("[EMERGENCY] Success!");
                                                    setShowEmergencyConfirm(false);
                                                } catch (err: any) {
                                                    console.error("[EMERGENCY] Error ending maintenance:", err);
                                                    console.error("[EMERGENCY] Error details:", err.message, err.code);
                                                    setError(err.message || "Failed to end maintenance");
                                                } finally {
                                                    setLoading(false);
                                                }
                                            }}
                                            disabled={loading}
                                            className="px-6 py-2 bg-red-600/90 text-white font-semibold rounded-lg hover:bg-red-700 transition shadow-lg hover:shadow-red-500/50 disabled:opacity-50"
                                        >
                                            {loading ? "Ending..." : "Yes, End Now"}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Settings Card */}
                    <div className="bg-gradient-to-br from-gray-800/40 to-gray-700/20 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-gray-700/30">
                        <h2 className="text-xl font-semibold text-white mb-6">
                            Update Maintenance Settings
                        </h2>

                        <div className="space-y-6">
                            {/* Maintenance Toggle */}
                            <div className="flex items-center justify-between p-4 bg-gray-900/30 rounded-xl border border-gray-700/50">
                                <div>
                                    <label htmlFor="enabled" className="font-medium text-white block">
                                        Maintenance Mode
                                    </label>
                                    <p className="text-sm text-gray-400 mt-1">
                                        When enabled, players will see the maintenance message
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setMaintenance(!maintenance)}
                                    className={`relative inline-flex h-8 w-14 items-center rounded-full transition ${maintenance ? "bg-blue-600" : "bg-gray-300"
                                        }`}
                                >
                                    <span
                                        className={`inline-block h-6 w-6 transform rounded-full bg-white transition ${maintenance ? "translate-x-7" : "translate-x-1"
                                            }`}
                                    />
                                </button>
                            </div>

                            {/* Activation Timing - Only show when enabling maintenance */}
                            {maintenance && (
                                <div className="p-4 bg-gray-900/30 rounded-xl border border-gray-700/50">
                                    <label className="font-medium text-white block mb-3">
                                        Activation Timing
                                    </label>
                                    <div className="space-y-3">
                                        <label className="flex items-start p-3 border-2 border-gray-700/50 rounded-xl cursor-pointer hover:bg-gray-800/30 transition">
                                            <input
                                                type="radio"
                                                checked={immediate}
                                                onChange={() => setImmediate(true)}
                                                className="mt-1 h-4 w-4 text-blue-500 border-gray-600 focus:ring-blue-500"
                                            />
                                            <div className="ml-3">
                                                <span className="font-medium text-white">Immediate</span>
                                                <p className="text-sm text-gray-400 mt-0.5">
                                                    Block all players instantly. Use for emergency maintenance.
                                                </p>
                                            </div>
                                        </label>

                                        <label className="flex items-start p-3 border-2 border-gray-700/50 rounded-xl cursor-pointer hover:bg-gray-800/30 transition">
                                            <input
                                                type="radio"
                                                checked={!immediate}
                                                onChange={() => setImmediate(false)}
                                                className="mt-1 h-4 w-4 text-blue-500 border-gray-600 focus:ring-blue-500"
                                            />
                                            <div className="ml-3">
                                                <span className="font-medium text-white">Scheduled (15 minutes)</span>
                                                <p className="text-sm text-gray-400 mt-0.5">
                                                    Warn players now, block new logins immediately, kick existing players after 15 minutes
                                                </p>
                                            </div>
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Delay Minutes Selector - Only show when scheduled maintenance */}
                            {maintenance && !immediate && (
                                <div>
                                    <label htmlFor="delayMinutes" className="block text-sm font-medium text-gray-300 mb-2">
                                        Delay Duration
                                    </label>
                                    <select
                                        id="delayMinutes"
                                        value={delayMinutes}
                                        onChange={(e) => setDelayMinutes(Number(e.target.value))}
                                        className="w-full px-4 py-3 bg-gray-900/50 border border-gray-700/50 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                    >
                                        <option value={1}>1 minute</option>
                                        <option value={5}>5 minutes</option>
                                        <option value={10}>10 minutes</option>
                                        <option value={15}>15 minutes</option>
                                        <option value={30}>30 minutes</option>
                                        <option value={45}>45 minutes</option>
                                        <option value={60}>60 minutes (1 hour)</option>
                                    </select>
                                    <p className="text-sm text-gray-400 mt-1">
                                        Players will be warned immediately and kicked after this delay
                                    </p>
                                </div>
                            )}

                            {/* Duration - Always show when enabling */}
                            {maintenance && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-300 mb-2">
                                        Maintenance Duration
                                    </label>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-xs text-gray-400 mb-1">Hours</label>
                                            <input
                                                type="number"
                                                min="0"
                                                max="24"
                                                value={durationHours}
                                                onChange={(e) => setDurationHours(Number(e.target.value))}
                                                className="w-full px-4 py-3 bg-gray-900/50 border border-gray-700/50 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                                placeholder="0"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-gray-400 mb-1">Minutes</label>
                                            <input
                                                type="number"
                                                min="0"
                                                max="59"
                                                value={durationMinutes}
                                                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                                                className="w-full px-4 py-3 bg-gray-900/50 border border-gray-700/50 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                                placeholder="30"
                                            />
                                        </div>
                                    </div>
                                    <p className="text-xs text-gray-400 mt-2">
                                        Optional: How long maintenance will last (shown to players as countdown)
                                    </p>
                                </div>
                            )}

                            {/* Reward Available */}

                            {/* Reward Gems */}
                            <div>
                                <label htmlFor="rewardGems" className="block text-sm font-medium text-gray-300 mb-2">
                                    Reward Gems
                                </label>
                                <input
                                    id="rewardGems"
                                    type="number"
                                    min="0"
                                    value={rewardGems}
                                    onChange={(e) => setRewardGems(Number(e.target.value))}
                                    className="w-full px-4 py-3 bg-gray-900/50 border border-gray-700/50 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                />
                                <p className="text-sm text-gray-400 mt-1">
                                    Number of gems to award as compensation
                                </p>
                            </div>

                            {/* Save Button */}
                            <button
                                onClick={handleSave}
                                disabled={loading}
                                className="w-full bg-blue-600/90 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-blue-500/50"
                            >
                                {loading ? "Saving..." : "Save Changes"}
                            </button>
                        </div>
                    </div>

                    {/* Maintenance History */}
                    <div className="mt-8 bg-gradient-to-br from-gray-800/40 to-gray-700/20 backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-gray-700/30">
                        <h2 className="text-xl font-semibold text-white mb-6">
                            Maintenance History
                        </h2>

                        {maintenanceHistory.length === 0 ? (
                            <p className="text-gray-400 text-center py-8">No maintenance history yet</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-700/50">
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Started</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Ended</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Duration</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Gems Rewarded</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-300">Type</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {maintenanceHistory.map((event, index) => {
                                            const startDate = new Date(event.startedAt);
                                            const endDate = event.endedAt ? new Date(event.endedAt) : null;

                                            let durationText = "Still Active";
                                            if (event.duration) {
                                                const hours = Math.floor(event.duration / (1000 * 60 * 60));
                                                const minutes = Math.floor((event.duration % (1000 * 60 * 60)) / (1000 * 60));
                                                const seconds = Math.floor((event.duration % (1000 * 60)) / 1000);
                                                durationText = `${hours}h ${minutes}m ${seconds}s`;
                                            }

                                            const typeText = event.immediate
                                                ? "Immediate"
                                                : `Scheduled ${event.delayMinutes}min`;

                                            return (
                                                <tr
                                                    key={event.id}
                                                    className={`border-b border-gray-700/30 hover:bg-gray-800/30 transition ${index % 2 === 0 ? 'bg-gray-800/10' : 'bg-gray-800/20'}`}
                                                >
                                                    <td className="py-3 px-4 text-sm text-gray-300">
                                                        {startDate.toLocaleString()}
                                                    </td>
                                                    <td className="py-3 px-4 text-sm text-gray-300">
                                                        {endDate ? endDate.toLocaleString() : "—"}
                                                    </td>
                                                    <td className="py-3 px-4 text-sm">
                                                        <span className={`${event.endedAt ? 'text-gray-300' : 'text-red-400 font-semibold'}`}>
                                                            {durationText}
                                                        </span>
                                                    </td>
                                                    <td className="py-3 px-4 text-sm">
                                                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-900/50 text-green-300 border border-green-500/50">
                                                            {event.rewardGems || 100} gems
                                                        </span>
                                                    </td>
                                                    <td className="py-3 px-4 text-sm text-gray-300">
                                                        {typeText}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>

                                {/* Load More Button */}
                                <div className="mt-6 text-center">
                                    <button
                                        onClick={() => loadMaintenanceHistory(true)}
                                        className="px-6 py-2 bg-blue-600/90 text-white rounded-lg hover:bg-blue-700 transition shadow-lg hover:shadow-blue-500/50"
                                    >
                                        Load More
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </main>
            </div>
        </AuthGuard>
    );
}
