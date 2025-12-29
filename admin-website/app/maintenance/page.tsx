"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import PageHeader from "@/components/PageHeader";
import { callFunction } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

export default function MaintenancePage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [currentStatus, setCurrentStatus] = useState<any>(null);
    const [enabled, setEnabled] = useState(false);
    const [rewardAvailable, setRewardAvailable] = useState(false);
    const [rewardGems, setRewardGems] = useState(100);
    const [immediate, setImmediate] = useState(true); // Default to immediate activation
    const [delayMinutes, setDelayMinutes] = useState(15); // Default to 15 minutes
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
        try {
            const maintenanceRef = doc(db, "GameConfig", "maintenance");
            const maintenanceDoc = await getDoc(maintenanceRef);

            if (maintenanceDoc.exists()) {
                const data = maintenanceDoc.data();
                setCurrentStatus(data);
                setEnabled(data.maintenance || data.enabled || false);
                setRewardAvailable(data.rewardAvailable || false);
                setRewardGems(data.rewardGems || 100);
                if (data.delayMinutes) {
                    setDelayMinutes(data.delayMinutes);
                }
            }
        } catch (err) {
            console.error("Error loading maintenance status:", err);
        }
    };

    const loadMaintenanceHistory = async () => {
        try {
            const { collection, query, orderBy, limit, getDocs } = await import("firebase/firestore");
            const historyRef = collection(db, "MaintenanceHistory");
            const q = query(historyRef, orderBy("startedAt", "desc"), limit(10));
            const snapshot = await getDocs(q);
            const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setMaintenanceHistory(history);
        } catch (err) {
            console.error("Error loading maintenance history:", err);
        }
    };

    const handleSave = async () => {
        setError("");
        setSuccess("");
        setLoading(true);

        try {
            // Build the request payload
            const payload: any = {
                enabled,
                rewardAvailable,
                rewardGems: Number(rewardGems),
            };

            // Only include immediate and delayMinutes when ENABLING maintenance
            if (enabled) {
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

            if (enabled && !immediate) {
                setSuccess(`Maintenance break scheduled for ${delayMinutes} minutes from now. Players will receive a warning.`);
            } else if (enabled) {
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
            <div className="min-h-screen bg-gray-50">
                <PageHeader title="Maintenance Mode Control" />

                {/* Main Content */}
                <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
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

                    {/* Current Status Card */}
                    {currentStatus && (
                        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-6">
                            <h3 className="text-lg font-semibold text-blue-900 mb-3">
                                Current Status
                            </h3>

                            {/* Countdown Timer - Show prominently when scheduled */}
                            {countdown && currentStatus.scheduledMaintenanceTime && (
                                <div className="mb-4 p-4 bg-orange-100 border-2 border-orange-400 rounded-lg">
                                    <div className="text-center">
                                        <p className="text-sm font-medium text-orange-700 mb-1">Maintenance Enforcement In:</p>
                                        <p className="text-3xl font-bold text-orange-900">{countdown}</p>
                                        <p className="text-xs text-orange-600 mt-1">Players are currently seeing the warning popup</p>
                                    </div>
                                </div>
                            )}

                            {/* Running Timer - Show when maintenance is ACTIVE */}
                            {runningTimer && (currentStatus.maintenance || currentStatus.enabled) && (
                                <div className="mb-4 p-4 bg-red-100 border-2 border-red-500 rounded-lg">
                                    <div className="text-center">
                                        <p className="text-sm font-medium text-red-700 mb-1">🚨 Maintenance ACTIVE For:</p>
                                        <p className="text-3xl font-bold text-red-900">{runningTimer}</p>
                                        <p className="text-xs text-red-600 mt-1">Players are currently blocked from the game</p>
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                    <span className="text-blue-700 font-medium">Maintenance:</span>
                                    <span className={`ml-2 px-3 py-1 rounded-full text-xs font-semibold ${currentStatus.maintenance || currentStatus.enabled
                                        ? "bg-red-100 text-red-700"
                                        : "bg-green-100 text-green-700"
                                        }`}>
                                        {currentStatus.maintenance || currentStatus.enabled ? "ON" : "OFF"}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-blue-700 font-medium">Reward Available:</span>
                                    <span className="ml-2 text-blue-900">
                                        {currentStatus.rewardAvailable ? "Yes" : "No"}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-blue-700 font-medium">Reward Gems:</span>
                                    <span className="ml-2 text-blue-900">
                                        {currentStatus.rewardGems || 0}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Emergency Off Button - Show when maintenance is active */}
                    {(currentStatus?.maintenance || currentStatus?.enabled) && (
                        <div className="mb-6 p-4 bg-red-50 border-2 border-red-300 rounded-lg">
                            {!showEmergencyConfirm ? (
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h4 className="font-semibold text-red-900">Emergency Stop</h4>
                                        <p className="text-sm text-red-700 mt-1">
                                            Turn off maintenance immediately
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => setShowEmergencyConfirm(true)}
                                        disabled={loading}
                                        className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition shadow-lg disabled:opacity-50"
                                    >
                                        END MAINTENANCE NOW
                                    </button>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div>
                                        <h4 className="font-semibold text-red-900">⚠️ Confirm Emergency Stop</h4>
                                        <p className="text-sm text-red-700 mt-2">
                                            Are you sure you want to END MAINTENANCE NOW? This will allow all players back into the game immediately.
                                        </p>
                                    </div>
                                    <div className="flex gap-3 justify-end">
                                        <button
                                            onClick={() => setShowEmergencyConfirm(false)}
                                            disabled={loading}
                                            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition disabled:opacity-50"
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
                                                    console.log("[EMERGENCY] Calling setMaintenanceMode with enabled:false");
                                                    const result = await callFunction("setMaintenanceMode", {
                                                        enabled: false,
                                                        rewardAvailable,
                                                        rewardGems: Number(rewardGems),
                                                    });
                                                    console.log("[EMERGENCY] Cloud function returned:", result);

                                                    setEnabled(false);
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
                                            className="px-6 py-2 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition shadow-lg disabled:opacity-50"
                                        >
                                            {loading ? "Ending..." : "Yes, End Now"}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Settings Card */}
                    <div className="bg-white rounded-lg shadow-lg p-8">
                        <h2 className="text-xl font-semibold text-gray-900 mb-6">
                            Update Maintenance Settings
                        </h2>

                        <div className="space-y-6">
                            {/* Maintenance Toggle */}
                            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                <div>
                                    <label htmlFor="enabled" className="font-medium text-gray-900 block">
                                        Maintenance Mode
                                    </label>
                                    <p className="text-sm text-gray-600 mt-1">
                                        When enabled, players will see the maintenance message
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setEnabled(!enabled)}
                                    className={`relative inline-flex h-8 w-14 items-center rounded-full transition ${enabled ? "bg-blue-600" : "bg-gray-300"
                                        }`}
                                >
                                    <span
                                        className={`inline-block h-6 w-6 transform rounded-full bg-white transition ${enabled ? "translate-x-7" : "translate-x-1"
                                            }`}
                                    />
                                </button>
                            </div>

                            {/* Activation Timing - Only show when enabling maintenance */}
                            {enabled && (
                                <div className="p-4 bg-gray-50 rounded-lg">
                                    <label className="font-medium text-gray-900 block mb-3">
                                        Activation Timing
                                    </label>
                                    <div className="space-y-3">
                                        <label className="flex items-start p-3 border-2 rounded-lg cursor-pointer hover:bg-white transition">
                                            <input
                                                type="radio"
                                                checked={immediate}
                                                onChange={() => setImmediate(true)}
                                                className="mt-1 h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                                            />
                                            <div className="ml-3">
                                                <span className="font-medium text-gray-900">Immediate</span>
                                                <p className="text-sm text-gray-600 mt-0.5">
                                                    Block all players instantly. Use for emergency maintenance.
                                                </p>
                                            </div>
                                        </label>

                                        <label className="flex items-start p-3 border-2 rounded-lg cursor-pointer hover:bg-white transition">
                                            <input
                                                type="radio"
                                                checked={!immediate}
                                                onChange={() => setImmediate(false)}
                                                className="mt-1 h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                                            />
                                            <div className="ml-3">
                                                <span className="font-medium text-gray-900">Scheduled (15 minutes)</span>
                                                <p className="text-sm text-gray-600 mt-0.5">
                                                    Warn players now, block new logins immediately, kick existing players after 15 minutes
                                                </p>
                                            </div>
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Delay Minutes Selector - Only show when scheduled maintenance */}
                            {enabled && !immediate && (
                                <div>
                                    <label htmlFor="delayMinutes" className="block text-sm font-medium text-gray-700 mb-2">
                                        Delay Duration
                                    </label>
                                    <select
                                        id="delayMinutes"
                                        value={delayMinutes}
                                        onChange={(e) => setDelayMinutes(Number(e.target.value))}
                                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                    >
                                        <option value={5}>5 minutes</option>
                                        <option value={10}>10 minutes</option>
                                        <option value={15}>15 minutes</option>
                                        <option value={30}>30 minutes</option>
                                        <option value={45}>45 minutes</option>
                                        <option value={60}>60 minutes (1 hour)</option>
                                    </select>
                                    <p className="text-sm text-gray-500 mt-1">
                                        Players will be warned immediately and kicked after this delay
                                    </p>
                                </div>
                            )}

                            {/* Duration - Always show when enabling */}
                            {enabled && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Maintenance Duration
                                    </label>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-xs text-gray-600 mb-1">Hours</label>
                                            <input
                                                type="number"
                                                min="0"
                                                max="24"
                                                value={durationHours}
                                                onChange={(e) => setDurationHours(Number(e.target.value))}
                                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                                placeholder="0"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-gray-600 mb-1">Minutes</label>
                                            <input
                                                type="number"
                                                min="0"
                                                max="59"
                                                value={durationMinutes}
                                                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                                placeholder="30"
                                            />
                                        </div>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-2">
                                        Optional: How long maintenance will last (shown to players as countdown)
                                    </p>
                                </div>
                            )}

                            {/* Reward Available */}
                            <div className="flex items-center">
                                <input
                                    id="rewardAvailable"
                                    type="checkbox"
                                    checked={rewardAvailable}
                                    onChange={(e) => setRewardAvailable(e.target.checked)}
                                    className="h-5 w-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                                />
                                <label htmlFor="rewardAvailable" className="ml-3 text-sm font-medium text-gray-700">
                                    Make reward available to players
                                </label>
                            </div>

                            {/* Reward Gems */}
                            <div>
                                <label htmlFor="rewardGems" className="block text-sm font-medium text-gray-700 mb-2">
                                    Reward Gems
                                </label>
                                <input
                                    id="rewardGems"
                                    type="number"
                                    min="0"
                                    value={rewardGems}
                                    onChange={(e) => setRewardGems(Number(e.target.value))}
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                                />
                                <p className="text-sm text-gray-500 mt-1">
                                    Number of gems to award as compensation
                                </p>
                            </div>

                            {/* Save Button */}
                            <button
                                onClick={handleSave}
                                disabled={loading}
                                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                            >
                                {loading ? "Saving..." : "Save Changes"}
                            </button>
                        </div>
                    </div>

                    {/* Maintenance History */}
                    <div className="mt-8 bg-white rounded-lg shadow-lg p-8">
                        <h2 className="text-xl font-semibold text-gray-900 mb-6">
                            Maintenance History
                        </h2>

                        {maintenanceHistory.length === 0 ? (
                            <p className="text-gray-500 text-center py-8">No maintenance history yet</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-200">
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Started</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Ended</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Duration</th>
                                            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Type</th>
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
                                                    className={`border-b border-gray-100 hover:bg-gray-50 ${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                                                >
                                                    <td className="py-3 px-4 text-sm text-gray-900">
                                                        {startDate.toLocaleString()}
                                                    </td>
                                                    <td className="py-3 px-4 text-sm text-gray-900">
                                                        {endDate ? endDate.toLocaleString() : "—"}
                                                    </td>
                                                    <td className="py-3 px-4 text-sm">
                                                        <span className={`${event.endedAt ? 'text-gray-900' : 'text-red-600 font-semibold'}`}>
                                                            {durationText}
                                                        </span>
                                                    </td>
                                                    <td className="py-3 px-4 text-sm text-gray-900">
                                                        {typeText}
                                                    </td>
                                                </tr>
                                            );
                                        })}
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
