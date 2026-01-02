import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import * as admin from "firebase-admin";
import type { Request, Response } from "express";

// Define environment parameter
const ga4PropertyId = defineString("GA4_PROPERTY_ID");

// Initialize Analytics Data Client
const analyticsDataClient = new BetaAnalyticsDataClient();

/**
 * Verify that the callable request comes from an authenticated admin user.
 * Uses the built-in Firebase Auth context from onCall functions.
 * @throws HttpsError if user is not authenticated or not an admin
 */
async function verifyAdminCallable(request: CallableRequest): Promise<string> {
    console.log("[verifyAdminCallable] Starting verification...");

    // Check if user is authenticated (onCall provides this automatically)
    if (!request.auth) {
        console.log("[verifyAdminCallable] No auth context found");
        throw new HttpsError("unauthenticated", "User must be authenticated to access analytics");
    }

    const uid = request.auth.uid;
    const email = request.auth.token?.email || "unknown";
    console.log("[verifyAdminCallable] User UID:", uid);
    console.log("[verifyAdminCallable] User Email:", email);

    // Check if user is an admin
    try {
        const adminDoc = await admin.firestore().collection("AdminUsers").doc(uid).get();
        console.log("[verifyAdminCallable] Admin doc exists:", adminDoc.exists);
        if (adminDoc.exists) {
            console.log("[verifyAdminCallable] Admin doc data:", JSON.stringify(adminDoc.data()));
        }

        if (!adminDoc.exists) {
            console.log("[verifyAdminCallable] User is NOT an admin - doc does not exist");
            throw new HttpsError("permission-denied", "User is not an administrator");
        }
    } catch (error: any) {
        if (error.code === "permission-denied") {
            throw error;
        }
        console.error("[verifyAdminCallable] Firestore error:", error);
        throw new HttpsError("internal", "Failed to verify admin status");
    }

    console.log("[verifyAdminCallable] Verification successful for UID:", uid);
    return uid;
}


/**
 * Verify that the request comes from an authenticated admin user.
 * Checks Authorization header for Bearer token, verifies it, and confirms admin status.
 * @returns Object with success boolean. If false, response has already been sent.
 */
async function verifyAdminRequest(req: Request, res: Response): Promise<{ success: boolean; uid?: string }> {
    try {
        // Get Authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            res.status(401).json({ error: "Unauthorized: Missing or invalid Authorization header" });
            return { success: false };
        }

        const idToken = authHeader.split("Bearer ")[1];

        // Verify the ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Check if user is an admin
        const adminDoc = await admin.firestore().collection("AdminUsers").doc(uid).get();
        if (!adminDoc.exists) {
            res.status(403).json({ error: "Forbidden: User is not an administrator" });
            return { success: false };
        }

        return { success: true, uid };
    } catch (error) {
        console.error("Auth verification failed:", error);
        res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
        return { success: false };
    }
}


/**
 * Get overview analytics metrics
 * Callable function - requires Firebase Auth
 */
export const analyticsOverview = onCall(
    { region: "us-central1" },
    async (request) => {
        // Verify admin authentication using built-in Firebase Auth
        await verifyAdminCallable(request);

        try {
            const propertyId = ga4PropertyId.value();

            // Fetch all metrics in parallel
            const [dauResponse, wauResponse, mauResponse, totalUsersResponse, sessionsResponse, eventsResponse] = await Promise.all([
                // DAU
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "yesterday", endDate: "today" }],
                    metrics: [{ name: "activeUsers" }],
                }),
                // WAU
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
                    metrics: [{ name: "activeUsers" }],
                }),
                // MAU
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
                    metrics: [{ name: "activeUsers" }],
                }),
                // Total Users
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "2020-01-01", endDate: "today" }],
                    metrics: [{ name: "totalUsers" }],
                }),
                // Session Metrics
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
                    metrics: [
                        { name: "sessions" },
                        { name: "averageSessionDuration" },
                        { name: "engagementRate" },
                    ],
                }),
                // Events Today
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "today", endDate: "today" }],
                    metrics: [{ name: "eventCount" }],
                }),
            ]);

            const dau = parseInt(dauResponse[0].rows?.[0]?.metricValues?.[0]?.value || "0");
            const wau = parseInt(wauResponse[0].rows?.[0]?.metricValues?.[0]?.value || "0");
            const mau = parseInt(mauResponse[0].rows?.[0]?.metricValues?.[0]?.value || "0");
            const totalUsers = parseInt(totalUsersResponse[0].rows?.[0]?.metricValues?.[0]?.value || "0");

            const sessionRow = sessionsResponse[0].rows?.[0];
            const totalSessions = parseInt(sessionRow?.metricValues?.[0]?.value || "0");
            const avgDuration = parseFloat(sessionRow?.metricValues?.[1]?.value || "0");
            const engagementRate = parseFloat(sessionRow?.metricValues?.[2]?.value || "0");

            const eventCount = parseInt(eventsResponse[0].rows?.[0]?.metricValues?.[0]?.value || "0");

            return {
                dau,
                wau,
                mau,
                totalUsers,
                totalSessions,
                avgSessionDuration: Math.round(avgDuration),
                engagementRate: Math.round(engagementRate * 1000) / 10,
                eventCount,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            console.error("Analytics overview error:", error);
            console.error("Property ID used:", ga4PropertyId.value());
            throw new HttpsError("internal", "Failed to fetch analytics data");
        }
    }
);


/**
 * Get user growth data
 * Callable function - requires Firebase Auth
 */
export const analyticsGrowth = onCall(
    { region: "us-central1" },
    async (request) => {
        await verifyAdminCallable(request);

        try {
            const propertyId = ga4PropertyId.value();
            const days = (request.data?.days as number) || 30;
            const platform = (request.data?.platform as string) || "";

            // Build dimension filter for platform
            const dimensionFilter = platform && platform !== "all" ? {
                filter: {
                    fieldName: "platform",
                    stringFilter: { value: platform },
                },
            } : undefined;

            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                dimensions: [{ name: "date" }],
                metrics: [{ name: "newUsers" }, { name: "activeUsers" }],
                orderBys: [{ dimension: { dimensionName: "date" } }],
                dimensionFilter,
            });

            const data = response.rows?.map((row) => ({
                date: row.dimensionValues?.[0]?.value || "",
                newUsers: parseInt(row.metricValues?.[0]?.value || "0"),
                activeUsers: parseInt(row.metricValues?.[1]?.value || "0"),
            })) || [];

            return { data, days, platform: platform || "all", timestamp: new Date().toISOString() };
        } catch (error) {
            console.error("Analytics growth error:", error);
            throw new HttpsError("internal", "Failed to fetch user growth data");
        }
    }
);

/**
 * Get platform distribution
 * Callable function - requires Firebase Auth
 */
export const analyticsPlatforms = onCall(
    { region: "us-central1" },
    async (request) => {
        await verifyAdminCallable(request);

        try {
            const propertyId = ga4PropertyId.value();

            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
                dimensions: [{ name: "platform" }],
                metrics: [{ name: "activeUsers" }],
            });

            const data = response.rows?.map((row) => ({
                platform: row.dimensionValues?.[0]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            return { data, timestamp: new Date().toISOString() };
        } catch (error) {
            console.error("Analytics platforms error:", error);
            throw new HttpsError("internal", "Failed to fetch platform data");
        }
    }
);


/**
 * Get revenue analytics
 * Endpoint: /analyticsRevenue?days=30&platform=iOS
 */
export const analyticsRevenue = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();
            const days = parseInt(req.query.days as string) || 30;
            const platform = req.query.platform as string || "";

            // Build dimension filter for platform
            const dimensionFilter = platform && platform !== "all" ? {
                filter: {
                    fieldName: "platform",
                    stringFilter: { value: platform },
                },
            } : undefined;

            // Fetch revenue metrics
            const [revenueResponse, revenueOverTimeResponse, purchasersResponse] = await Promise.all([
                // Total revenue and transactions
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    metrics: [
                        { name: "purchaseRevenue" },
                        { name: "transactions" },
                        { name: "totalPurchasers" },
                        { name: "activeUsers" },
                    ],
                    dimensionFilter,
                }),
                // Revenue over time
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "date" }],
                    metrics: [
                        { name: "purchaseRevenue" },
                        { name: "transactions" },
                    ],
                    orderBys: [{ dimension: { dimensionName: "date" } }],
                    dimensionFilter,
                }),
                // First-time vs returning purchasers
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    metrics: [
                        { name: "firstTimePurchasers" },
                    ],
                    dimensionFilter,
                }),
            ]);

            const revenueRow = revenueResponse[0].rows?.[0];
            const totalRevenue = parseFloat(revenueRow?.metricValues?.[0]?.value || "0");
            const transactions = parseInt(revenueRow?.metricValues?.[1]?.value || "0");
            const totalPurchasers = parseInt(revenueRow?.metricValues?.[2]?.value || "0");
            const activeUsers = parseInt(revenueRow?.metricValues?.[3]?.value || "0");
            const firstTimePurchasers = parseInt(purchasersResponse[0].rows?.[0]?.metricValues?.[0]?.value || "0");

            // Calculate ARPU (Average Revenue Per User) and ARPPU (Average Revenue Per Paying User)
            const arpu = activeUsers > 0 ? totalRevenue / activeUsers : 0;
            const arppu = totalPurchasers > 0 ? totalRevenue / totalPurchasers : 0;
            const conversionRate = activeUsers > 0 ? (totalPurchasers / activeUsers) * 100 : 0;

            // Revenue over time data
            const revenueOverTime = revenueOverTimeResponse[0].rows?.map((row) => ({
                date: row.dimensionValues?.[0]?.value || "",
                revenue: parseFloat(row.metricValues?.[0]?.value || "0"),
                transactions: parseInt(row.metricValues?.[1]?.value || "0"),
            })) || [];

            res.json({
                totalRevenue: Math.round(totalRevenue * 100) / 100,
                transactions,
                totalPurchasers,
                firstTimePurchasers,
                arpu: Math.round(arpu * 100) / 100,
                arppu: Math.round(arppu * 100) / 100,
                conversionRate: Math.round(conversionRate * 100) / 100,
                revenueOverTime,
                days,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Analytics revenue error:", error);
            res.status(500).json({ error: "Failed to fetch revenue data" });
        }
    }
);

/**
 * Get revenue by product/item
 * Endpoint: /analyticsRevenueByProduct?days=30&platform=iOS
 */
export const analyticsRevenueByProduct = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();
            const days = parseInt(req.query.days as string) || 30;
            const platform = req.query.platform as string || "";

            // Build dimension filter for platform
            const dimensionFilter = platform && platform !== "all" ? {
                filter: {
                    fieldName: "platform",
                    stringFilter: { value: platform },
                },
            } : undefined;

            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                dimensions: [{ name: "itemName" }],
                metrics: [
                    { name: "itemRevenue" },
                    { name: "itemsPurchased" },
                ],
                orderBys: [{ metric: { metricName: "itemRevenue" }, desc: true }],
                limit: 20,
                dimensionFilter,
            });

            const data = response.rows?.map((row) => ({
                product: row.dimensionValues?.[0]?.value || "Unknown",
                revenue: parseFloat(row.metricValues?.[0]?.value || "0"),
                quantity: parseInt(row.metricValues?.[1]?.value || "0"),
            })) || [];

            res.json({ data, days, platform: platform || "all", timestamp: new Date().toISOString() });
        } catch (error) {
            console.error("Analytics revenue by product error:", error);
            res.status(500).json({ error: "Failed to fetch product revenue data" });
        }
    }
);

/**
 * Get retention metrics
 * Endpoint: /analyticsRetention?days=30
 */
export const analyticsRetention = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();

            // Day 1, Day 7, Day 30 retention using cohort analysis
            const [day1Response, day7Response, day30Response, newUsersResponse] = await Promise.all([
                // Day 1 retention - users who returned the next day
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "8daysAgo", endDate: "7daysAgo" }],
                    metrics: [{ name: "dauPerMau" }],
                }),
                // Day 7 retention approximation
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "14daysAgo", endDate: "7daysAgo" }],
                    metrics: [{ name: "wauPerMau" }],
                }),
                // Day 30 retention approximation
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "60daysAgo", endDate: "30daysAgo" }],
                    metrics: [{ name: "dauPerMau" }],
                }),
                // New vs returning users
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
                    metrics: [
                        { name: "newUsers" },
                        { name: "activeUsers" },
                    ],
                }),
            ]);

            // Extract retention rates (these are approximations)
            const dauPerMau1 = parseFloat(day1Response[0].rows?.[0]?.metricValues?.[0]?.value || "0");
            const wauPerMau = parseFloat(day7Response[0].rows?.[0]?.metricValues?.[0]?.value || "0");
            const dauPerMau30 = parseFloat(day30Response[0].rows?.[0]?.metricValues?.[0]?.value || "0");

            const userRow = newUsersResponse[0].rows?.[0];
            const newUsers = parseInt(userRow?.metricValues?.[0]?.value || "0");
            const activeUsers = parseInt(userRow?.metricValues?.[1]?.value || "0");
            const returningUsers = activeUsers - newUsers;
            const returningRate = activeUsers > 0 ? (returningUsers / activeUsers) * 100 : 0;

            res.json({
                day1Retention: Math.round(dauPerMau1 * 100 * 10) / 10,
                day7Retention: Math.round(wauPerMau * 100 * 10) / 10,
                day30Retention: Math.round(dauPerMau30 * 100 * 10) / 10,
                newUsers,
                returningUsers: Math.max(0, returningUsers),
                returningRate: Math.round(returningRate * 10) / 10,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Analytics retention error:", error);
            res.status(500).json({ error: "Failed to fetch retention data" });
        }
    }
);

/**
 * Get top game events
 * Endpoint: /analyticsEvents?days=30&limit=15
 */
export const analyticsEvents = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();
            const days = parseInt(req.query.days as string) || 30;
            const limit = parseInt(req.query.limit as string) || 15;

            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                dimensions: [{ name: "eventName" }],
                metrics: [
                    { name: "eventCount" },
                    { name: "eventCountPerUser" },
                ],
                orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
                limit,
            });

            const data = response.rows?.map((row) => ({
                eventName: row.dimensionValues?.[0]?.value || "Unknown",
                count: parseInt(row.metricValues?.[0]?.value || "0"),
                countPerUser: parseFloat(row.metricValues?.[1]?.value || "0"),
            })) || [];

            res.json({ data, days, timestamp: new Date().toISOString() });
        } catch (error) {
            console.error("Analytics events error:", error);
            res.status(500).json({ error: "Failed to fetch events data" });
        }
    }
);

/**
 * Get realtime analytics data
 * Endpoint: /analyticsRealtime
 * Returns current active users with country breakdown for world map
 */
export const analyticsRealtime = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();

            // Fetch realtime data
            const [activeUsersResponse, countryResponse, cityResponse, eventResponse] = await Promise.all([
                // Total active users right now
                analyticsDataClient.runRealtimeReport({
                    property: propertyId,
                    metrics: [{ name: "activeUsers" }],
                }),
                // Active users by country
                analyticsDataClient.runRealtimeReport({
                    property: propertyId,
                    dimensions: [{ name: "country" }],
                    metrics: [{ name: "activeUsers" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                }),
                // Active users by city (top 20)
                analyticsDataClient.runRealtimeReport({
                    property: propertyId,
                    dimensions: [{ name: "city" }, { name: "country" }],
                    metrics: [{ name: "activeUsers" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 20,
                }),
                // Realtime events in last 30 minutes
                analyticsDataClient.runRealtimeReport({
                    property: propertyId,
                    dimensions: [{ name: "eventName" }],
                    metrics: [{ name: "eventCount" }],
                    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
                    limit: 10,
                }),
            ]);

            const totalActiveUsers = parseInt(activeUsersResponse[0].rows?.[0]?.metricValues?.[0]?.value || "0");

            const usersByCountry = countryResponse[0].rows?.map((row) => ({
                country: row.dimensionValues?.[0]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            const usersByCity = cityResponse[0].rows?.map((row) => ({
                city: row.dimensionValues?.[0]?.value || "Unknown",
                country: row.dimensionValues?.[1]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            const realtimeEvents = eventResponse[0].rows?.map((row) => ({
                eventName: row.dimensionValues?.[0]?.value || "Unknown",
                count: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            res.json({
                activeUsers: totalActiveUsers,
                usersByCountry,
                usersByCity,
                realtimeEvents,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Analytics realtime error:", error);
            res.status(500).json({ error: "Failed to fetch realtime data" });
        }
    }
);

/**
 * Get geographic analytics (for world map historical view)
 * Endpoint: /analyticsGeography?days=30
 */
export const analyticsGeography = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();
            const days = parseInt(req.query.days as string) || 30;

            const [countryResponse, cityResponse] = await Promise.all([
                // Users and revenue by country
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "country" }],
                    metrics: [
                        { name: "activeUsers" },
                        { name: "sessions" },
                        { name: "purchaseRevenue" },
                    ],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                }),
                // Top 50 cities
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "city" }, { name: "country" }],
                    metrics: [{ name: "activeUsers" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 50,
                }),
            ]);

            const countries = countryResponse[0].rows?.map((row) => ({
                country: row.dimensionValues?.[0]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
                sessions: parseInt(row.metricValues?.[1]?.value || "0"),
                revenue: parseFloat(row.metricValues?.[2]?.value || "0"),
            })) || [];

            const cities = cityResponse[0].rows?.map((row) => ({
                city: row.dimensionValues?.[0]?.value || "Unknown",
                country: row.dimensionValues?.[1]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            res.json({
                countries,
                cities,
                days,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Analytics geography error:", error);
            res.status(500).json({ error: "Failed to fetch geography data" });
        }
    }
);

/**
 * Get device analytics
 * Endpoint: /analyticsDevices?days=30
 */
export const analyticsDevices = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();
            const days = parseInt(req.query.days as string) || 30;
            const platform = req.query.platform as string || "";

            // Build dimension filter for platform
            const dimensionFilter = platform && platform !== "all" ? {
                filter: {
                    fieldName: "platform",
                    stringFilter: { value: platform },
                },
            } : undefined;

            const [devicesResponse, osResponse, screenResponse, browserResponse] = await Promise.all([
                // Top device models
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "deviceModel" }],
                    metrics: [{ name: "activeUsers" }, { name: "sessions" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 20,
                    dimensionFilter,
                }),
                // Operating system versions
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "operatingSystemWithVersion" }],
                    metrics: [{ name: "activeUsers" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 15,
                    dimensionFilter,
                }),
                // Screen resolutions
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "screenResolution" }],
                    metrics: [{ name: "activeUsers" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 10,
                    dimensionFilter,
                }),
                // Device category breakdown
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "deviceCategory" }],
                    metrics: [{ name: "activeUsers" }, { name: "sessions" }],
                    dimensionFilter,
                }),
            ]);

            const devices = devicesResponse[0].rows?.map((row) => ({
                device: row.dimensionValues?.[0]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
                sessions: parseInt(row.metricValues?.[1]?.value || "0"),
            })) || [];

            const osVersions = osResponse[0].rows?.map((row) => ({
                os: row.dimensionValues?.[0]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            const screenResolutions = screenResponse[0].rows?.map((row) => ({
                resolution: row.dimensionValues?.[0]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            const deviceCategories = browserResponse[0].rows?.map((row) => ({
                category: row.dimensionValues?.[0]?.value || "Unknown",
                users: parseInt(row.metricValues?.[0]?.value || "0"),
                sessions: parseInt(row.metricValues?.[1]?.value || "0"),
            })) || [];

            res.json({
                devices,
                osVersions,
                screenResolutions,
                deviceCategories,
                days,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Analytics devices error:", error);
            res.status(500).json({ error: "Failed to fetch device data" });
        }
    }
);

/**
 * Get session analytics for game optimization
 * Endpoint: /analyticsSessions?days=30
 */
export const analyticsSessions = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();
            const days = parseInt(req.query.days as string) || 30;
            const platform = req.query.platform as string || "";

            const dimensionFilter = platform && platform !== "all" ? {
                filter: {
                    fieldName: "platform",
                    stringFilter: { value: platform },
                },
            } : undefined;

            const [sessionsResponse, sessionDurationResponse, sessionsPerUserResponse] = await Promise.all([
                // Session metrics over time
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "date" }],
                    metrics: [
                        { name: "sessions" },
                        { name: "averageSessionDuration" },
                        { name: "sessionsPerUser" },
                    ],
                    orderBys: [{ dimension: { dimensionName: "date" } }],
                    dimensionFilter,
                }),
                // Session duration distribution (using engagement time buckets)
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    metrics: [
                        { name: "sessions" },
                        { name: "averageSessionDuration" },
                        { name: "engagementRate" },
                        { name: "bounceRate" },
                    ],
                    dimensionFilter,
                }),
                // Sessions by hour of day
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
                    dimensions: [{ name: "hour" }],
                    metrics: [{ name: "sessions" }],
                    orderBys: [{ dimension: { dimensionName: "hour" } }],
                    dimensionFilter,
                }),
            ]);

            const sessionsByDate = sessionsResponse[0].rows?.map((row) => ({
                date: row.dimensionValues?.[0]?.value || "",
                sessions: parseInt(row.metricValues?.[0]?.value || "0"),
                avgDuration: parseFloat(row.metricValues?.[1]?.value || "0"),
                sessionsPerUser: parseFloat(row.metricValues?.[2]?.value || "0"),
            })) || [];

            const summaryRow = sessionDurationResponse[0].rows?.[0];
            const summary = {
                totalSessions: parseInt(summaryRow?.metricValues?.[0]?.value || "0"),
                avgSessionDuration: parseFloat(summaryRow?.metricValues?.[1]?.value || "0"),
                engagementRate: parseFloat(summaryRow?.metricValues?.[2]?.value || "0"),
                bounceRate: parseFloat(summaryRow?.metricValues?.[3]?.value || "0"),
            };

            const sessionsByHour = sessionsPerUserResponse[0].rows?.map((row) => ({
                hour: row.dimensionValues?.[0]?.value || "0",
                sessions: parseInt(row.metricValues?.[0]?.value || "0"),
            })) || [];

            res.json({
                sessionsByDate,
                summary,
                sessionsByHour,
                days,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Analytics sessions error:", error);
            res.status(500).json({ error: "Failed to fetch session data" });
        }
    }
);
