"use client";

import { useEffect, useState, useCallback } from "react";
import AuthGuard from "@/components/AuthGuard";
import PageHeader from "@/components/PageHeader";
import { useFirebase } from "@/lib/FirebaseContext";
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { format } from "date-fns";

// Types
interface OverviewMetrics {
    dau: number;
    wau: number;
    mau: number;
    totalUsers: number;
    avgSessionDuration: number;
    eventCount: number;
    engagementRate: number;
}

interface RevenueMetrics {
    totalRevenue: number;
    transactions: number;
    totalPurchasers: number;
    firstTimePurchasers: number;
    arpu: number;
    arppu: number;
    conversionRate: number;
    revenueOverTime: { date: string; revenue: number; transactions: number }[];
}

interface RetentionMetrics {
    day1Retention: number;
    day7Retention: number;
    day30Retention: number;
    newUsers: number;
    returningUsers: number;
    returningRate: number;
}

interface EventData {
    eventName: string;
    count: number;
    countPerUser: number;
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

interface ProductData {
    product: string;
    revenue: number;
    quantity: number;
}

type DateRange = "1" | "7" | "14" | "30" | "60" | "90" | "180" | "365";
type PlatformFilter = "all" | "Android" | "iOS";
type TabId = "overview" | "revenue" | "retention" | "events" | "live" | "devices";

interface RealtimeData {
    activeUsers: number;
    usersByCountry: { country: string; users: number }[];
    usersByCity: { city: string; country: string; users: number }[];
    realtimeEvents: { eventName: string; count: number }[];
}

interface DevicesData {
    devices: { device: string; users: number; sessions: number }[];
    osVersions: { os: string; users: number }[];
    screenResolutions: { resolution: string; users: number }[];
    deviceCategories: { category: string; users: number; sessions: number }[];
}

export default function AnalyticsPage() {
    const { environmentConfig, isProd } = useFirebase();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabId>("overview");

    // Filters
    const [dateRange, setDateRange] = useState<DateRange>("30");
    const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");

    // Data
    const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
    const [revenueMetrics, setRevenueMetrics] = useState<RevenueMetrics | null>(null);
    const [retentionMetrics, setRetentionMetrics] = useState<RetentionMetrics | null>(null);
    const [eventsData, setEventsData] = useState<EventData[]>([]);
    const [growthData, setGrowthData] = useState<GrowthData[]>([]);
    const [platformData, setPlatformData] = useState<PlatformData[]>([]);
    const [productData, setProductData] = useState<ProductData[]>([]);
    const [realtimeData, setRealtimeData] = useState<RealtimeData | null>(null);
    const [lastRealtimeUpdate, setLastRealtimeUpdate] = useState<string>("");
    const [devicesData, setDevicesData] = useState<DevicesData | null>(null);

    const fetchAnalytics = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            const baseUrl = environmentConfig.functionsUrl;
            const days = dateRange;
            const platform = platformFilter !== "all" ? `&platform=${platformFilter}` : "";

            const [overviewRes, growthRes, platformsRes, revenueRes, retentionRes, eventsRes, productsRes, devicesRes] = await Promise.all([
                fetch(`${baseUrl}/analyticsOverview`),
                fetch(`${baseUrl}/analyticsGrowth?days=${days}${platform}`),
                fetch(`${baseUrl}/analyticsPlatforms`),
                fetch(`${baseUrl}/analyticsRevenue?days=${days}${platform}`),
                fetch(`${baseUrl}/analyticsRetention`),
                fetch(`${baseUrl}/analyticsEvents?days=${days}&limit=15${platform}`),
                fetch(`${baseUrl}/analyticsRevenueByProduct?days=${days}${platform}`),
                fetch(`${baseUrl}/analyticsDevices?days=${days}${platform}`),
            ]);

            const [overview, growth, platforms, revenue, retention, events, products, devices] = await Promise.all([
                overviewRes.json(),
                growthRes.json(),
                platformsRes.json(),
                revenueRes.ok ? revenueRes.json() : null,
                retentionRes.ok ? retentionRes.json() : null,
                eventsRes.ok ? eventsRes.json() : null,
                productsRes.ok ? productsRes.json() : null,
                devicesRes.ok ? devicesRes.json() : null,
            ]);

            setMetrics(overview);
            setGrowthData(growth.data || []);
            setPlatformData(platforms.data || []);
            setRevenueMetrics(revenue);
            setRetentionMetrics(retention);
            setEventsData(events?.data || []);
            setProductData(products?.data || []);
            setDevicesData(devices);
            setLoading(false);
        } catch (err) {
            console.error("Error fetching analytics:", err);
            setError("Failed to load analytics data");
            setLoading(false);
        }
    }, [environmentConfig.functionsUrl, dateRange, platformFilter]);

    useEffect(() => {
        fetchAnalytics();
    }, [fetchAnalytics]);

    const COLORS = ["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#EC4899"];

    const tabs: { id: TabId; label: string; icon: string }[] = [
        { id: "live", label: "Live", icon: "🔴" },
        { id: "overview", label: "Overview", icon: "📊" },
        { id: "revenue", label: "Revenue", icon: "💰" },
        { id: "retention", label: "Retention", icon: "🔄" },
        { id: "events", label: "Events", icon: "🎮" },
        { id: "devices", label: "Devices", icon: "📱" },
    ];

    // Realtime data fetcher with auto-refresh
    const fetchRealtimeData = useCallback(async () => {
        try {
            const baseUrl = environmentConfig.functionsUrl;
            const res = await fetch(`${baseUrl}/analyticsRealtime`);
            if (res.ok) {
                const data = await res.json();
                setRealtimeData(data);
                setLastRealtimeUpdate(new Date().toLocaleTimeString());
            }
        } catch (err) {
            console.error("Error fetching realtime data:", err);
        }
    }, [environmentConfig.functionsUrl]);

    // Auto-refresh realtime data every 30 seconds when on Live tab
    useEffect(() => {
        if (activeTab === "live") {
            fetchRealtimeData();
            const interval = setInterval(fetchRealtimeData, 30000);
            return () => clearInterval(interval);
        }
    }, [activeTab, fetchRealtimeData]);

    return (
        <AuthGuard>
            <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black">
                {/* Production Warning Banner */}
                {isProd && (
                    <div className="bg-red-900/80 border-b border-red-700 py-2 px-4 text-center">
                        <span className="text-red-200 text-sm font-medium">
                            ⚠️ Viewing <strong>PRODUCTION</strong> analytics
                        </span>
                    </div>
                )}

                <PageHeader
                    title="Analytics Dashboard"
                    subtitle={`Game insights from ${environmentConfig.firebase.projectId}`}
                />

                <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
                    {/* Filters Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                        {/* Tabs */}
                        <div className="flex gap-2">
                            {tabs.map((tab) => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id
                                        ? "bg-blue-600 text-white shadow-lg"
                                        : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                                        }`}
                                >
                                    {tab.icon} {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Filters */}
                        <div className="flex items-center gap-3 flex-wrap">
                            {/* Date Range */}
                            <select
                                value={dateRange}
                                onChange={(e) => setDateRange(e.target.value as DateRange)}
                                className="bg-gray-800 border border-gray-600 text-white text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="1">Today</option>
                                <option value="7">Last 7 Days</option>
                                <option value="14">Last 14 Days</option>
                                <option value="30">Last 30 Days</option>
                                <option value="60">Last 60 Days</option>
                                <option value="90">Last 90 Days</option>
                                <option value="180">Last 6 Months</option>
                                <option value="365">Last Year</option>
                            </select>

                            {/* Platform */}
                            <select
                                value={platformFilter}
                                onChange={(e) => setPlatformFilter(e.target.value as PlatformFilter)}
                                className="bg-gray-800 border border-gray-600 text-white text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="all">All Platforms</option>
                                <option value="Android">🤖 Android</option>
                                <option value="iOS">🍎 iOS</option>
                            </select>

                            <button
                                onClick={fetchAnalytics}
                                disabled={loading}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
                            >
                                {loading ? "Loading..." : "🔄 Refresh"}
                            </button>
                        </div>
                    </div>

                    {/* Content */}
                    {loading ? (
                        <div className="flex items-center justify-center min-h-[400px]">
                            <div className="text-center">
                                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
                                <div className="text-gray-400 text-lg">Loading analytics data...</div>
                            </div>
                        </div>
                    ) : error ? (
                        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-8 backdrop-blur-sm shadow-lg">
                            <h3 className="font-semibold text-red-300 mb-2">⚠️ Error Loading Analytics</h3>
                            <p className="text-red-400">{error}</p>
                        </div>
                    ) : (
                        <>
                            {/* Live Tab */}
                            {activeTab === "live" && (
                                <LiveTab
                                    realtimeData={realtimeData}
                                    lastUpdate={lastRealtimeUpdate}
                                    onRefresh={fetchRealtimeData}
                                />
                            )}

                            {/* Overview Tab */}
                            {activeTab === "overview" && (
                                <OverviewTab
                                    metrics={metrics!}
                                    growthData={growthData}
                                    platformData={platformData}
                                    COLORS={COLORS}
                                />
                            )}

                            {/* Revenue Tab */}
                            {activeTab === "revenue" && (
                                <RevenueTab
                                    revenueMetrics={revenueMetrics}
                                    productData={productData}
                                    COLORS={COLORS}
                                />
                            )}

                            {/* Retention Tab */}
                            {activeTab === "retention" && (
                                <RetentionTab retentionMetrics={retentionMetrics} />
                            )}

                            {/* Events Tab */}
                            {activeTab === "events" && (
                                <EventsTab eventsData={eventsData} />
                            )}

                            {/* Devices Tab */}
                            {activeTab === "devices" && (
                                <DevicesTab devicesData={devicesData} />
                            )}
                        </>
                    )}
                </main>
            </div>
        </AuthGuard>
    );
}

// ========== WORLD MAP COMPONENT ==========

// Country to approximate map coordinates (x, y as percentages)
const COUNTRY_COORDS: Record<string, { x: number; y: number }> = {
    'United States': { x: 20, y: 40 },
    'Canada': { x: 18, y: 28 },
    'Mexico': { x: 15, y: 52 },
    'Brazil': { x: 32, y: 68 },
    'Argentina': { x: 28, y: 80 },
    'Chile': { x: 25, y: 78 },
    'Colombia': { x: 25, y: 58 },
    'United Kingdom': { x: 48, y: 32 },
    'Germany': { x: 52, y: 35 },
    'France': { x: 50, y: 38 },
    'Spain': { x: 47, y: 42 },
    'Italy': { x: 53, y: 42 },
    'Netherlands': { x: 51, y: 33 },
    'Poland': { x: 55, y: 34 },
    'Sweden': { x: 54, y: 25 },
    'Norway': { x: 52, y: 22 },
    'Finland': { x: 58, y: 22 },
    'Denmark': { x: 52, y: 30 },
    'Russia': { x: 70, y: 28 },
    'Ukraine': { x: 60, y: 36 },
    'Turkey': { x: 60, y: 42 },
    'India': { x: 72, y: 50 },
    'China': { x: 78, y: 42 },
    'Japan': { x: 88, y: 40 },
    'South Korea': { x: 85, y: 42 },
    'Australia': { x: 85, y: 75 },
    'New Zealand': { x: 92, y: 82 },
    'Indonesia': { x: 80, y: 62 },
    'Philippines': { x: 84, y: 54 },
    'Thailand': { x: 77, y: 54 },
    'Vietnam': { x: 79, y: 52 },
    'Malaysia': { x: 78, y: 60 },
    'Singapore': { x: 77, y: 62 },
    'South Africa': { x: 58, y: 78 },
    'Egypt': { x: 58, y: 48 },
    'Nigeria': { x: 52, y: 58 },
    'Kenya': { x: 62, y: 62 },
    'Saudi Arabia': { x: 63, y: 50 },
    'United Arab Emirates': { x: 66, y: 52 },
    'Israel': { x: 60, y: 46 },
    'Pakistan': { x: 68, y: 48 },
    'Bangladesh': { x: 74, y: 50 },
    'Taiwan': { x: 84, y: 50 },
    'Hong Kong': { x: 82, y: 52 },
};

function WorldMapSVG({ usersByCountry }: { usersByCountry: { country: string; users: number }[] }) {
    const maxUsers = Math.max(...usersByCountry.map(c => c.users), 1);

    return (
        <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
            {/* Simplified world map background */}
            <defs>
                <radialGradient id="dotGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#3B82F6" stopOpacity="1" />
                    <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
                </radialGradient>
                <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="1" result="coloredBlur" />
                    <feMerge>
                        <feMergeNode in="coloredBlur" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>

            {/* Map outline - simplified continents */}
            <g fill="#1F2937" stroke="#374151" strokeWidth="0.3">
                {/* North America */}
                <path d="M5,20 Q15,15 25,22 L30,35 L25,50 L15,55 L8,45 Z" />
                {/* South America */}
                <path d="M20,55 L30,52 L35,65 L32,82 L22,88 L18,75 Z" />
                {/* Europe */}
                <path d="M45,25 L58,22 L62,32 L55,40 L45,38 Z" />
                {/* Africa */}
                <path d="M45,42 L62,45 L65,55 L60,72 L50,78 L42,65 L43,50 Z" />
                {/* Asia */}
                <path d="M58,22 L90,18 L95,35 L88,55 L75,60 L65,50 L60,35 Z" />
                {/* Australia */}
                <path d="M78,68 L92,65 L95,75 L88,82 L78,78 Z" />
            </g>

            {/* User dots */}
            {usersByCountry.map((country) => {
                const coords = COUNTRY_COORDS[country.country];
                if (!coords) return null;

                const size = Math.max(1.5, (country.users / maxUsers) * 4 + 1);

                return (
                    <g key={country.country}>
                        {/* Pulsing glow effect */}
                        <circle
                            cx={coords.x}
                            cy={coords.y}
                            r={size * 2}
                            fill="url(#dotGlow)"
                            className="animate-ping"
                            style={{ animationDuration: '2s' }}
                        />
                        {/* Main dot */}
                        <circle
                            cx={coords.x}
                            cy={coords.y}
                            r={size}
                            fill="#3B82F6"
                            filter="url(#glow)"
                        />
                        {/* Center bright point */}
                        <circle
                            cx={coords.x}
                            cy={coords.y}
                            r={size * 0.4}
                            fill="#60A5FA"
                        />
                    </g>
                );
            })}

            {/* No active users message */}
            {usersByCountry.length === 0 && (
                <text x="50" y="50" textAnchor="middle" fill="#6B7280" fontSize="4">
                    No active users right now
                </text>
            )}
        </svg>
    );
}

// ========== TAB COMPONENTS ==========

function LiveTab({ realtimeData, lastUpdate, onRefresh }: { realtimeData: RealtimeData | null; lastUpdate: string; onRefresh: () => void }) {
    // Country code to flag emoji mapping
    const getCountryFlag = (country: string): string => {
        const flags: Record<string, string> = {
            'Australia': '🇦🇺', 'United States': '🇺🇸', 'United Kingdom': '🇬🇧', 'Canada': '🇨🇦',
            'Germany': '🇩🇪', 'France': '🇫🇷', 'Japan': '🇯🇵', 'South Korea': '🇰🇷',
            'Brazil': '🇧🇷', 'India': '🇮🇳', 'China': '🇨🇳', 'Russia': '🇷🇺',
            'Mexico': '🇲🇽', 'Spain': '🇪🇸', 'Italy': '🇮🇹', 'Netherlands': '🇳🇱',
            'Sweden': '🇸🇪', 'Norway': '🇳🇴', 'Finland': '🇫🇮', 'Denmark': '🇩🇰',
            'Poland': '🇵🇱', 'Turkey': '🇹🇷', 'Indonesia': '🇮🇩', 'Philippines': '🇵🇭',
            'Thailand': '🇹🇭', 'Vietnam': '🇻🇳', 'Malaysia': '🇲🇾', 'Singapore': '🇸🇬',
            'New Zealand': '🇳🇿', 'Argentina': '🇦🇷', 'Chile': '🇨🇱', 'Colombia': '🇨🇴',
        };
        return flags[country] || '🌍';
    };

    if (!realtimeData) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <div className="text-center">
                    <div className="animate-pulse text-6xl mb-4">🔴</div>
                    <div className="text-gray-400 text-lg">Loading live data...</div>
                </div>
            </div>
        );
    }

    const maxUsers = Math.max(...realtimeData.usersByCountry.map(c => c.users), 1);

    return (
        <>
            {/* Live Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                    </span>
                    <span className="text-xl font-bold text-white">Live Analytics</span>
                    <span className="text-sm text-gray-500">Last updated: {lastUpdate}</span>
                </div>
                <button
                    onClick={onRefresh}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition"
                >
                    🔄 Refresh Now
                </button>
            </div>

            {/* Active Users Count */}
            <div className="mb-8 text-center">
                <div className="inline-block bg-gradient-to-br from-green-900/60 to-green-700/30 border border-green-500/50 rounded-2xl px-12 py-8 shadow-xl">
                    <p className="text-sm font-medium text-green-400 mb-2">USERS RIGHT NOW</p>
                    <p className="text-7xl font-bold text-green-300">{realtimeData.activeUsers}</p>
                    <p className="text-xs text-green-500 mt-2">Active in the last 30 minutes</p>
                </div>
            </div>

            {/* World Map */}
            <ChartCard title="🌍 Users Around the World">
                <div className="relative w-full" style={{ height: "300px" }}>
                    <WorldMapSVG usersByCountry={realtimeData.usersByCountry} />
                </div>
            </ChartCard>

            {/* World Map Visualization - Country Breakdown */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <ChartCard title="🌍 Users by Country">
                    <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                        {realtimeData.usersByCountry.length > 0 ? (
                            realtimeData.usersByCountry.map((country, index) => (
                                <div key={country.country} className="flex items-center gap-3">
                                    <span className="text-2xl">{getCountryFlag(country.country)}</span>
                                    <div className="flex-1">
                                        <div className="flex justify-between items-center mb-1">
                                            <span className="text-sm font-medium text-white">{country.country}</span>
                                            <span className="text-sm font-bold text-gray-300">{country.users}</span>
                                        </div>
                                        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-500"
                                                style={{ width: `${(country.users / maxUsers) * 100}%` }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="text-center text-gray-500 py-8">No active users right now</div>
                        )}
                    </div>
                </ChartCard>

                <ChartCard title="🏙️ Top Cities">
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        {realtimeData.usersByCity.length > 0 ? (
                            realtimeData.usersByCity.map((city, index) => (
                                <div key={`${city.city}-${city.country}`} className="flex items-center justify-between py-2 border-b border-gray-700/50">
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg">{getCountryFlag(city.country)}</span>
                                        <div>
                                            <span className="text-sm font-medium text-white">{city.city}</span>
                                            <span className="text-xs text-gray-500 ml-2">{city.country}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-bold text-green-400">{city.users}</span>
                                        <span className="text-xs text-gray-500">users</span>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="text-center text-gray-500 py-8">No city data available</div>
                        )}
                    </div>
                </ChartCard>
            </div>

            {/* Live Events */}
            <ChartCard title="⚡ Live Events (Last 30 min)">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {realtimeData.realtimeEvents.map((event) => (
                        <div key={event.eventName} className="bg-gray-800/50 rounded-lg p-3 text-center">
                            <span className="text-lg">{getEventIcon(event.eventName)}</span>
                            <p className="text-xs text-gray-400 mt-1 truncate">{formatEventName(event.eventName)}</p>
                            <p className="text-xl font-bold text-white">{event.count.toLocaleString()}</p>
                        </div>
                    ))}
                </div>
            </ChartCard>

            {/* Info */}
            <div className="mt-6 bg-blue-900/30 border border-blue-700/50 rounded-xl p-4">
                <p className="text-sm text-blue-400">
                    <strong>💡 Tip:</strong> This data auto-refreshes every 30 seconds.
                    Shows users active in the last 30 minutes from Google Analytics realtime API.
                </p>
            </div>
        </>
    );
}

function OverviewTab({ metrics, growthData, platformData, COLORS }: { metrics: OverviewMetrics; growthData: GrowthData[]; platformData: PlatformData[]; COLORS: string[] }) {
    return (
        <>
            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
                <KPICard title="DAU" value={metrics.dau} icon="👥" color="blue" />
                <KPICard title="WAU" value={metrics.wau} icon="📊" color="purple" />
                <KPICard title="MAU" value={metrics.mau} icon="📈" color="green" />
                <KPICard title="Total Users" value={metrics.totalUsers} icon="🎮" color="blue" />
                <KPICard title="Avg Session" value={`${Math.round(metrics.avgSessionDuration / 60)}m`} icon="⏱️" color="purple" />
                <KPICard title="Engagement" value={`${metrics.engagementRate || 0}%`} icon="⚡" color="green" />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ChartCard title="User Growth">
                    <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={growthData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                            <XAxis
                                dataKey="date"
                                stroke="#9CA3AF"
                                fontSize={12}
                                tickFormatter={(value) => {
                                    try {
                                        const date = new Date(value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8));
                                        return format(date, 'MMM d');
                                    } catch {
                                        return value;
                                    }
                                }}
                            />
                            <YAxis stroke="#9CA3AF" fontSize={12} />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: "#1F2937",
                                    border: "1px solid #374151",
                                    borderRadius: "8px",
                                    color: "#fff",
                                }}
                            />
                            <Legend />
                            <Line type="monotone" dataKey="newUsers" stroke="#3B82F6" name="New Users" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="activeUsers" stroke="#10B981" name="Active Users" strokeWidth={2} dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Platform Distribution">
                    <ResponsiveContainer width="100%" height={300}>
                        <PieChart>
                            <Pie
                                data={platformData}
                                cx="50%"
                                cy="50%"
                                labelLine={false}
                                label={({ platform, percent }: any) => `${platform}: ${(percent * 100).toFixed(0)}%`}
                                outerRadius={100}
                                fill="#8884d8"
                                dataKey="users"
                                nameKey="platform"
                            >
                                {platformData.map((_, index) => (
                                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                ))}
                            </Pie>
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: "#1F2937",
                                    border: "1px solid #374151",
                                    borderRadius: "8px",
                                }}
                            />
                        </PieChart>
                    </ResponsiveContainer>
                </ChartCard>
            </div>
        </>
    );
}

function RevenueTab({ revenueMetrics, productData, COLORS }: { revenueMetrics: RevenueMetrics | null; productData: ProductData[]; COLORS: string[] }) {
    if (!revenueMetrics) {
        return (
            <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-8">
                <h3 className="font-semibold text-yellow-300 mb-2">📊 No Revenue Data</h3>
                <p className="text-yellow-400">Revenue data will appear once in-app purchases are tracked in Firebase Analytics.</p>
            </div>
        );
    }

    return (
        <>
            {/* Revenue KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <KPICard
                    title="Total Revenue"
                    value={`$${revenueMetrics.totalRevenue.toLocaleString()}`}
                    icon="💰"
                    color="green"
                />
                <KPICard
                    title="ARPU"
                    value={`$${revenueMetrics.arpu.toFixed(2)}`}
                    icon="📊"
                    color="blue"
                    subtitle="Avg Revenue Per User"
                />
                <KPICard
                    title="ARPPU"
                    value={`$${revenueMetrics.arppu.toFixed(2)}`}
                    icon="💎"
                    color="purple"
                    subtitle="Per Paying User"
                />
                <KPICard
                    title="Conversion"
                    value={`${revenueMetrics.conversionRate}%`}
                    icon="🎯"
                    color="green"
                    subtitle="Paying Users"
                />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                <KPICard title="Transactions" value={revenueMetrics.transactions} icon="🛒" color="blue" />
                <KPICard title="Paying Users" value={revenueMetrics.totalPurchasers} icon="👤" color="purple" />
                <KPICard title="First-Time Buyers" value={revenueMetrics.firstTimePurchasers} icon="🆕" color="green" />
            </div>

            {/* Revenue Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ChartCard title="Revenue Over Time">
                    <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={revenueMetrics.revenueOverTime}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                            <XAxis
                                dataKey="date"
                                stroke="#9CA3AF"
                                fontSize={12}
                                tickFormatter={(value) => {
                                    try {
                                        const date = new Date(value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8));
                                        return format(date, 'MMM d');
                                    } catch {
                                        return value;
                                    }
                                }}
                            />
                            <YAxis stroke="#9CA3AF" fontSize={12} />
                            <Tooltip
                                contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "8px" }}
                                formatter={(value: any) => [`$${Number(value).toFixed(2)}`, "Revenue"]}
                            />
                            <Line type="monotone" dataKey="revenue" stroke="#10B981" strokeWidth={2} dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Revenue by Product">
                    {productData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={300}>
                            <BarChart data={productData.slice(0, 8)} layout="vertical">
                                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                <XAxis type="number" stroke="#9CA3AF" fontSize={12} />
                                <YAxis type="category" dataKey="product" stroke="#9CA3AF" fontSize={11} width={120} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "8px" }}
                                    formatter={(value: any) => [`$${Number(value).toFixed(2)}`, "Revenue"]}
                                />
                                <Bar dataKey="revenue" fill="#8B5CF6" radius={[0, 4, 4, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : (
                        <div className="flex items-center justify-center h-[300px] text-gray-500">
                            No product data available
                        </div>
                    )}
                </ChartCard>
            </div>
        </>
    );
}

function RetentionTab({ retentionMetrics }: { retentionMetrics: RetentionMetrics | null }) {
    if (!retentionMetrics) {
        return (
            <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-8">
                <h3 className="font-semibold text-yellow-300 mb-2">📊 Loading Retention Data</h3>
                <p className="text-yellow-400">Retention metrics are being calculated...</p>
            </div>
        );
    }

    return (
        <>
            {/* Retention KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                <RetentionCard
                    title="Day 1 Retention"
                    value={retentionMetrics.day1Retention}
                    description="Users returning after 1 day"
                    color="green"
                />
                <RetentionCard
                    title="Day 7 Retention"
                    value={retentionMetrics.day7Retention}
                    description="Users returning after 7 days"
                    color="blue"
                />
                <RetentionCard
                    title="Day 30 Retention"
                    value={retentionMetrics.day30Retention}
                    description="Users returning after 30 days"
                    color="purple"
                />
            </div>

            {/* User Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KPICard title="New Users (30d)" value={retentionMetrics.newUsers} icon="🆕" color="blue" />
                <KPICard title="Returning Users" value={retentionMetrics.returningUsers} icon="🔄" color="green" />
                <KPICard title="Return Rate" value={`${retentionMetrics.returningRate}%`} icon="📈" color="purple" />
            </div>

            {/* Retention Info */}
            <div className="mt-8 bg-blue-900/30 border border-blue-700/50 rounded-xl p-6">
                <h3 className="font-semibold text-blue-300 mb-2">💡 Understanding Retention</h3>
                <ul className="text-sm text-blue-400 space-y-1">
                    <li>• <strong>Day 1 Retention:</strong> % of users who return the day after installation</li>
                    <li>• <strong>Day 7 Retention:</strong> % of users active within the first week</li>
                    <li>• <strong>Day 30 Retention:</strong> % of users still active after a month</li>
                    <li>• Industry average D1 retention for mobile games is 25-40%</li>
                </ul>
            </div>
        </>
    );
}

function EventsTab({ eventsData }: { eventsData: EventData[] }) {
    return (
        <>
            <ChartCard title="Top Game Events">
                {eventsData.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-700">
                                    <th className="text-left py-3 px-4 text-gray-400 font-medium">Event Name</th>
                                    <th className="text-right py-3 px-4 text-gray-400 font-medium">Total Count</th>
                                    <th className="text-right py-3 px-4 text-gray-400 font-medium">Per User</th>
                                </tr>
                            </thead>
                            <tbody>
                                {eventsData.map((event, index) => (
                                    <tr key={event.eventName} className={`border-b border-gray-800 ${index % 2 === 0 ? 'bg-gray-800/30' : ''}`}>
                                        <td className="py-3 px-4 text-white font-medium">
                                            <span className="mr-2">{getEventIcon(event.eventName)}</span>
                                            {formatEventName(event.eventName)}
                                        </td>
                                        <td className="py-3 px-4 text-right text-gray-300">
                                            {event.count.toLocaleString()}
                                        </td>
                                        <td className="py-3 px-4 text-right text-gray-400">
                                            {event.countPerUser.toFixed(2)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="flex items-center justify-center h-[200px] text-gray-500">
                        No event data available
                    </div>
                )}
            </ChartCard>
        </>
    );
}

function DevicesTab({ devicesData }: { devicesData: DevicesData | null }) {
    if (!devicesData) {
        return (
            <div className="flex items-center justify-center h-[300px] text-gray-500">
                Loading device data...
            </div>
        );
    }

    const maxDeviceUsers = Math.max(...devicesData.devices.map(d => d.users), 1);

    return (
        <>
            {/* Device Summary KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <KPICard
                    title="Top Device"
                    value={devicesData.devices[0]?.device || "N/A"}
                    icon="📱"
                    color="blue"
                />
                <KPICard
                    title="Device Models"
                    value={devicesData.devices.length}
                    icon="📋"
                    color="purple"
                />
                <KPICard
                    title="OS Versions"
                    value={devicesData.osVersions.length}
                    icon="⚙️"
                    color="green"
                />
                <KPICard
                    title="Screen Sizes"
                    value={devicesData.screenResolutions.length}
                    icon="📐"
                    color="blue"
                />
            </div>

            {/* Device Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <ChartCard title="📱 Top Device Models">
                    <div className="space-y-3 max-h-[350px] overflow-y-auto">
                        {devicesData.devices.slice(0, 15).map((device) => (
                            <div key={device.device} className="flex items-center gap-3">
                                <div className="flex-1">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="text-sm font-medium text-white truncate" title={device.device}>
                                            {device.device.length > 30 ? device.device.substring(0, 30) + "..." : device.device}
                                        </span>
                                        <span className="text-sm font-bold text-blue-400 ml-2">{device.users.toLocaleString()}</span>
                                    </div>
                                    <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-500"
                                            style={{ width: `${(device.users / maxDeviceUsers) * 100}%` }}
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </ChartCard>

                <ChartCard title="⚙️ OS Versions">
                    <div className="space-y-2 max-h-[350px] overflow-y-auto">
                        {devicesData.osVersions.map((os) => (
                            <div key={os.os} className="flex items-center justify-between py-2 border-b border-gray-700/50">
                                <span className="text-sm text-white">
                                    {os.os.includes("Android") ? "🤖 " : os.os.includes("iOS") ? "🍎 " : "💻 "}
                                    {os.os}
                                </span>
                                <span className="text-sm font-bold text-green-400">{os.users.toLocaleString()} users</span>
                            </div>
                        ))}
                    </div>
                </ChartCard>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ChartCard title="📐 Screen Resolutions">
                    <div className="space-y-2">
                        {devicesData.screenResolutions.map((screen) => (
                            <div key={screen.resolution} className="flex items-center justify-between py-2 border-b border-gray-700/50">
                                <span className="text-sm text-white font-mono">{screen.resolution}</span>
                                <span className="text-sm font-bold text-purple-400">{screen.users.toLocaleString()} users</span>
                            </div>
                        ))}
                    </div>
                </ChartCard>

                <ChartCard title="📊 Device Categories">
                    <div className="space-y-4">
                        {devicesData.deviceCategories.map((cat) => (
                            <div key={cat.category} className="bg-gray-800/50 rounded-lg p-4">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-lg font-semibold text-white capitalize">
                                        {cat.category === "mobile" ? "📱 Mobile" :
                                            cat.category === "tablet" ? "📱 Tablet" :
                                                cat.category === "desktop" ? "💻 Desktop" : cat.category}
                                    </span>
                                </div>
                                <div className="flex gap-6">
                                    <div>
                                        <p className="text-xs text-gray-500">Users</p>
                                        <p className="text-xl font-bold text-blue-400">{cat.users.toLocaleString()}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-500">Sessions</p>
                                        <p className="text-xl font-bold text-green-400">{cat.sessions.toLocaleString()}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </ChartCard>
            </div>

            {/* Optimization Tips */}
            <div className="mt-6 bg-purple-900/30 border border-purple-700/50 rounded-xl p-4">
                <p className="text-sm text-purple-400 font-semibold mb-2">📱 Device Optimization Tips</p>
                <ul className="text-sm text-purple-300 space-y-1">
                    <li>• Focus performance optimization on your top 5 devices</li>
                    <li>• Ensure minimum OS version support covers 95%+ of users</li>
                    <li>• Test UI layouts on your most common screen resolutions</li>
                </ul>
            </div>
        </>
    );
}

// ========== HELPER COMPONENTS ==========

function KPICard({ title, value, icon, color, subtitle }: { title: string; value: string | number; icon: string; color: "blue" | "purple" | "green"; subtitle?: string }) {
    const colorClasses = {
        blue: "from-blue-900/40 to-blue-800/20 border-blue-700/30",
        purple: "from-purple-900/40 to-purple-800/20 border-purple-700/30",
        green: "from-green-900/40 to-green-800/20 border-green-700/30",
    };

    return (
        <div className={`bg-gradient-to-br ${colorClasses[color]} backdrop-blur-sm rounded-xl p-4 shadow-xl border`}>
            <div className="flex items-center justify-between mb-1">
                <span className="text-xl">{icon}</span>
            </div>
            <h3 className="text-xs font-medium text-gray-400 mb-1">{title}</h3>
            <p className="text-2xl font-bold text-white">{typeof value === 'number' ? value.toLocaleString() : value}</p>
            {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
        </div>
    );
}

function RetentionCard({ title, value, description, color }: { title: string; value: number; description: string; color: "green" | "blue" | "purple" }) {
    const getColor = () => {
        if (value >= 40) return "text-green-400";
        if (value >= 20) return "text-yellow-400";
        return "text-red-400";
    };

    const colorClasses = {
        blue: "from-blue-900/40 to-blue-800/20 border-blue-700/30",
        purple: "from-purple-900/40 to-purple-800/20 border-purple-700/30",
        green: "from-green-900/40 to-green-800/20 border-green-700/30",
    };

    return (
        <div className={`bg-gradient-to-br ${colorClasses[color]} backdrop-blur-sm rounded-xl p-6 shadow-xl border text-center`}>
            <h3 className="text-sm font-medium text-gray-400 mb-2">{title}</h3>
            <p className={`text-5xl font-bold ${getColor()} mb-2`}>{value}%</p>
            <p className="text-xs text-gray-500">{description}</p>
        </div>
    );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="bg-gradient-to-br from-gray-800/40 to-gray-700/20 backdrop-blur-sm rounded-xl shadow-xl p-6 border border-gray-700/30">
            <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>
            {children}
        </div>
    );
}

function formatEventName(name: string): string {
    return name
        .replace(/_/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase())
        .trim();
}

function getEventIcon(name: string): string {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('purchase') || lowerName.includes('buy')) return '💰';
    if (lowerName.includes('level') || lowerName.includes('complete')) return '🏆';
    if (lowerName.includes('start') || lowerName.includes('begin')) return '▶️';
    if (lowerName.includes('race')) return '🏎️';
    if (lowerName.includes('spell') || lowerName.includes('magic')) return '✨';
    if (lowerName.includes('login') || lowerName.includes('session')) return '🔑';
    if (lowerName.includes('ad') || lowerName.includes('reward')) return '🎁';
    if (lowerName.includes('error') || lowerName.includes('crash')) return '❌';
    return '📊';
}
