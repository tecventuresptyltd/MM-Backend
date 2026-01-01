"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { format } from "date-fns";

interface OverviewMetrics {
    dau: number;
    wau: number;
    mau: number;
    totalUsers: number;
    avgSessionDuration: number;
    eventCount: number;
}

interface GrowthData {
    date: string;
    newUsers: number;
    activeUsers: number;
}

interface PlatformData {
    platform: string;
    users: number;
    [key: string]: string | number;
}

export default function AnalyticsPage() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [metrics, setMetrics] = useState<OverviewMetrics>({
        dau: 0,
        wau: 0,
        mau: 0,
        totalUsers: 0,
        avgSessionDuration: 0,
        eventCount: 0,
    });
    const [growthData, setGrowthData] = useState<GrowthData[]>([]);
    const [platformData, setPlatformData] = useState<PlatformData[]>([]);

    useEffect(() => {
        const fetchAnalytics = async () => {
            try {
                setLoading(true);
                setError(null);

                // Call Cloud Functions to fetch analytics data
                const baseUrl = "https://us-central1-mystic-motors-sandbox.cloudfunctions.net";

                const [overviewRes, growthRes, platformsRes] = await Promise.all([
                    fetch(`${baseUrl}/analyticsOverview`),
                    fetch(`${baseUrl}/analyticsGrowth?days=30`),
                    fetch(`${baseUrl}/analyticsPlatforms`),
                ]);

                const overview = await overviewRes.json();
                const growth = await growthRes.json();
                const platforms = await platformsRes.json();

                setMetrics(overview);
                setGrowthData(growth.data || []);
                setPlatformData(platforms.data || []);
                setLoading(false);
            } catch (err) {
                console.error("Error fetching analytics:", err);
                setError("Failed to load analytics data");
                setLoading(false);
            }
        };

        fetchAnalytics();
    }, []);

    const COLORS = ["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B"];

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black">
            <PageHeader title="Analytics Dashboard" subtitle="Real-time game insights from Firebase Analytics" />

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
                {loading ? (
                    <div className="flex items-center justify-center min-h-[400px]">
                        <div className="text-gray-400 text-lg">Loading analytics data...</div>
                    </div>
                ) : error ? (
                    <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-8 backdrop-blur-sm shadow-lg">
                        <h3 className="font-semibold text-red-300 mb-2">⚠️ Error Loading Analytics</h3>
                        <p className="text-red-400">{error}</p>
                    </div>
                ) : (
                    <>
                        {/* KPI Cards */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                            <KPICard
                                title="Daily Active Users"
                                value={metrics.dau.toLocaleString()}
                                icon="👥"
                                color="blue"
                            />
                            <KPICard
                                title="Weekly Active Users"
                                value={metrics.wau.toLocaleString()}
                                icon="📊"
                                color="purple"
                            />
                            <KPICard
                                title="Monthly Active Users"
                                value={metrics.mau.toLocaleString()}
                                icon="📈"
                                color="green"
                            />
                            <KPICard
                                title="Total Users"
                                value={metrics.totalUsers.toLocaleString()}
                                icon="🎮"
                                color="blue"
                            />
                            <KPICard
                                title="Avg Session (sec)"
                                value={metrics.avgSessionDuration.toLocaleString()}
                                icon="⏱️"
                                color="purple"
                            />
                            <KPICard
                                title="Events Today"
                                value={metrics.eventCount.toLocaleString()}
                                icon="⚡"
                                color="green"
                            />
                        </div>

                        {/* Charts */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            {/* User Growth Chart */}
                            <ChartCard title="User Growth (Last 30 Days)">
                                <ResponsiveContainer width="100%" height={300}>
                                    <LineChart data={growthData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                        <XAxis
                                            dataKey="date"
                                            stroke="#9CA3AF"
                                            tickFormatter={(value) => {
                                                try {
                                                    const date = new Date(value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8));
                                                    return format(date, 'MMM d');
                                                } catch {
                                                    return value;
                                                }
                                            }}
                                        />
                                        <YAxis stroke="#9CA3AF" />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: "#1F2937",
                                                border: "1px solid #374151",
                                                borderRadius: "8px",
                                                color: "#fff",
                                            }}
                                        />
                                        <Legend />
                                        <Line
                                            type="monotone"
                                            dataKey="newUsers"
                                            stroke="#3B82F6"
                                            name="New Users"
                                            strokeWidth={2}
                                        />
                                        <Line
                                            type="monotone"
                                            dataKey="activeUsers"
                                            stroke="#10B981"
                                            name="Active Users"
                                            strokeWidth={2}
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            </ChartCard>

                            {/* Platform Distribution */}
                            <ChartCard title="Platform Distribution">
                                <ResponsiveContainer width="100%" height={300}>
                                    <PieChart>
                                        <Pie
                                            data={platformData}
                                            cx="50%"
                                            cy="50%"
                                            labelLine={false}
                                            label={(entry: any) =>
                                                `${entry.platform}: ${((entry.percent || 0) * 100).toFixed(0)}%`
                                            }
                                            outerRadius={80}
                                            fill="#8884d8"
                                            dataKey="users"
                                            nameKey="platform"
                                        >
                                            {platformData.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: "#1F2937",
                                                border: "1px solid #374151",
                                                borderRadius: "8px",
                                                color: "#fff",
                                            }}
                                        />
                                    </PieChart>
                                </ResponsiveContainer>
                            </ChartCard>
                        </div>

                        {/* Info Box */}
                        <div className="mt-8 bg-blue-900/30 border border-blue-700/50 rounded-xl p-6 backdrop-blur-sm shadow-lg">
                            <h3 className="font-semibold text-blue-300 mb-2">📊 About Analytics</h3>
                            <p className="text-sm text-blue-400">
                                This dashboard displays real-time analytics from Firebase Analytics (Google Analytics 4).
                                Data is automatically collected from your Unity app and served via Cloud Functions.
                                Metrics update in real-time and provide insights into user engagement, platform distribution, and growth trends.
                            </p>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}

interface KPICardProps {
    title: string;
    value: string;
    icon: string;
    color: "blue" | "purple" | "green";
}

function KPICard({ title, value, icon, color }: KPICardProps) {
    const colorClasses = {
        blue: "from-blue-900/40 to-blue-800/20 border-blue-700/30",
        purple: "from-purple-900/40 to-purple-800/20 border-purple-700/30",
        green: "from-green-900/40 to-green-800/20 border-green-700/30",
    };

    return (
        <div
            className={`bg-gradient-to-br ${colorClasses[color]} backdrop-blur-sm rounded-2xl p-6 shadow-2xl border`}
        >
            <div className="flex items-center justify-between mb-2">
                <span className="text-2xl">{icon}</span>
            </div>
            <h3 className="text-sm font-medium text-gray-400 mb-1">{title}</h3>
            <p className="text-3xl font-bold text-white">{value}</p>
        </div>
    );
}

interface ChartCardProps {
    title: string;
    children: React.ReactNode;
}

function ChartCard({ title, children }: ChartCardProps) {
    return (
        <div className="bg-gradient-to-br from-gray-800/40 to-gray-700/20 backdrop-blur-sm rounded-2xl shadow-2xl p-6 border border-gray-700/30">
            <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>
            {children}
        </div>
    );
}
