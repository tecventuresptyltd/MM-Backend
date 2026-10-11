import { insightQuery, reportRows, mapPreferenceRows, funnelDefinitions } from "./insights.js";
import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { BetaAnalyticsDataClient, v1alpha } from "@google-analytics/data";
import * as admin from "firebase-admin";
import type { Request, Response } from "express";
import { reportDays, reportDateRange, platformFilter, propertyToday, cohortRequests, summarizeRetention } from "./reporting.js";

// Define environment parameter
const ga4PropertyId = defineString("GA4_PROPERTY_ID");

// Initialize Analytics Data Client
const analyticsDataClient = new BetaAnalyticsDataClient();

/**
 * Verify that the callable request comes from an authenticated admin user with analytics access.
 * Uses the built-in Firebase Auth context from onCall functions.
 * @throws HttpsError if user is not authenticated, not an admin, or doesn't have analytics permission
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

    // Check if user is an admin with analytics permission
    try {
        const adminDoc = await admin.firestore().collection("AdminUsers").doc(uid).get();
        console.log("[verifyAdminCallable] Admin doc exists:", adminDoc.exists);

        if (!adminDoc.exists) {
            console.log("[verifyAdminCallable] User is NOT an admin - doc does not exist");
            throw new HttpsError("permission-denied", "User is not an administrator");
        }

        const adminData = adminDoc.data();
        console.log("[verifyAdminCallable] Admin doc data:", JSON.stringify(adminData));

        // Check canViewAnalytics permission
        if (adminData?.canViewAnalytics !== true) {
            console.log("[verifyAdminCallable] User does not have canViewAnalytics permission");
            throw new HttpsError("permission-denied", "User does not have permission to view analytics");
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
 * Verify that the request comes from an authenticated admin user with analytics access.
 * Checks Authorization header for Bearer token, verifies it, and confirms admin status with analytics permission.
 * @returns Object with success boolean. If false, response has already been sent.
 */
async function verifyAdminRequest(req: Request, res: Response): Promise<{ success: boolean; uid?: string }> {
    console.log("[verifyAdminRequest] Starting verification...");
    console.log("[verifyAdminRequest] Request method:", req.method);
    console.log("[verifyAdminRequest] Request URL:", req.url);

    try {
        // Get Authorization header
        const authHeader = req.headers.authorization;
        console.log("[verifyAdminRequest] Auth header present:", !!authHeader);
        console.log("[verifyAdminRequest] Auth header starts with Bearer:", authHeader?.startsWith("Bearer "));

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.log("[verifyAdminRequest] FAILED: Missing or invalid Authorization header");
            res.status(401).json({ error: "Unauthorized: Missing or invalid Authorization header" });
            return { success: false };
        }

        const idToken = authHeader.split("Bearer ")[1];
        console.log("[verifyAdminRequest] Token length:", idToken?.length || 0);

        // Verify the ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;
        const email = decodedToken.email || "unknown";
        console.log("[verifyAdminRequest] Token verified, UID:", uid);
        console.log("[verifyAdminRequest] Token email:", email);

        // Check if user is an admin with analytics permission
        const adminDoc = await admin.firestore().collection("AdminUsers").doc(uid).get();
        console.log("[verifyAdminRequest] AdminUsers doc exists:", adminDoc.exists);

        if (!adminDoc.exists) {
            console.log("[verifyAdminRequest] FAILED: User not in AdminUsers collection");
            res.status(403).json({ error: "Forbidden: User is not an administrator" });
            return { success: false };
        }

        const adminData = adminDoc.data();

        // Check canViewAnalytics permission
        if (adminData?.canViewAnalytics !== true) {
            console.log("[verifyAdminRequest] FAILED: User does not have canViewAnalytics permission");
            res.status(403).json({ error: "Forbidden: User does not have permission to view analytics" });
            return { success: false };
        }

        console.log("[verifyAdminRequest] SUCCESS: User verified as admin with analytics access");
        return { success: true, uid };
    } catch (error: any) {
        console.error("[verifyAdminRequest] EXCEPTION:", error?.code || "unknown", error?.message || error);
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
            const dimensionFilter = platformFilter(request.data?.platform);

            // Fetch all metrics in parallel
            const [dauResponse, wauResponse, mauResponse, totalUsersResponse, sessionsResponse, eventsResponse] = await Promise.all([
                // DAU
                analyticsDataClient.runReport({
                    property: propertyId,
                    dimensionFilter,
                    dateRanges: [{ startDate: "today", endDate: "today" }],
                    metrics: [{ name: "activeUsers" }],
                }),
                // WAU
                analyticsDataClient.runReport({
                    property: propertyId,
                    dimensionFilter,
                    dateRanges: [{ startDate: "6daysAgo", endDate: "today" }],
                    metrics: [{ name: "activeUsers" }],
                }),
                // MAU
                analyticsDataClient.runReport({
                    property: propertyId,
                    dimensionFilter,
                    dateRanges: [{ startDate: "29daysAgo", endDate: "today" }],
                    metrics: [{ name: "activeUsers" }],
                }),
                // Total Users
                analyticsDataClient.runReport({
                    property: propertyId,
                    dimensionFilter,
                    dateRanges: [{ startDate: "2020-01-01", endDate: "today" }],
                    metrics: [{ name: "totalUsers" }],
                }),
                // Session Metrics
                analyticsDataClient.runReport({
                    property: propertyId,
                    dimensionFilter,
                    dateRanges: [{ startDate: "29daysAgo", endDate: "today" }],
                    metrics: [
                        { name: "sessions" },
                        { name: "averageSessionDuration" },
                        { name: "engagementRate" },
                    ],
                }),
                // Events Today
                analyticsDataClient.runReport({
                    property: propertyId,
                    dimensionFilter,
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
            const days = reportDays(request.data?.days);
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
                dateRanges: [reportDateRange(days)],
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
                dateRanges: [reportDateRange(reportDays(request.data?.days))],
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
            const days = reportDays(req.query.days);
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
                    currencyCode: "USD",
                    dateRanges: [reportDateRange(days)],
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
                    currencyCode: "USD",
                    dateRanges: [reportDateRange(days)],
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
                    currencyCode: "USD",
                    dateRanges: [reportDateRange(days)],
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
            const days = reportDays(req.query.days);
            const platform = req.query.platform as string || "";

            // Build dimension filter for platform
            const dimensionFilter = platform && platform !== "all" ? {
                filter: {
                    fieldName: "platform",
                    stringFilter: { value: platform },
                },
            } : undefined;

            const [metadata] = await analyticsDataClient.getMetadata({ name: propertyId + "/metadata" });
            if (!metadata.dimensions?.some(item => item.apiName === "customEvent:product_id")) {
                res.json({ data: [], notice: "Product revenue requires an event-scoped product_id custom dimension in this GA4 property. Historical item reports cannot represent automatic in-app purchases.", days });
                return;
            }
            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                currencyCode: "USD",
                dateRanges: [reportDateRange(days)],
                dimensions: [{ name: "customEvent:product_id" }],
                metrics: [
                    { name: "purchaseRevenue" },
                    { name: "eventCount" },
                ],
                orderBys: [{ metric: { metricName: "purchaseRevenue" }, desc: true }],
                limit: 20,
                dimensionFilter: { andGroup: { expressions: [
                    { filter: { fieldName: "eventName", stringFilter: { value: "in_app_purchase", matchType: "EXACT" } } },
                    ...(dimensionFilter ? [dimensionFilter] : []),
                ] } },
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
 * Get revenue analytics by country (for ad targeting and revenue optimization)
 * Endpoint: /analyticsRevenueByCountry?days=30&platform=iOS
 * Returns: country, revenue, users, purchasers, ARPU, ARPPU, conversion rate
 */
export const analyticsRevenueByCountry = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();
            const days = reportDays(req.query.days);
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
                currencyCode: "USD",
                dateRanges: [reportDateRange(days)],
                dimensions: [{ name: "country" }],
                metrics: [
                    { name: "purchaseRevenue" },
                    { name: "activeUsers" },
                    { name: "totalPurchasers" },
                    { name: "transactions" },
                    { name: "averagePurchaseRevenue" },
                ],
                orderBys: [{ metric: { metricName: "purchaseRevenue" }, desc: true }],
                dimensionFilter,
            });

            const data = response.rows?.map((row) => {
                const country = row.dimensionValues?.[0]?.value || "Unknown";
                const revenue = parseFloat(row.metricValues?.[0]?.value || "0");
                const users = parseInt(row.metricValues?.[1]?.value || "0");
                const purchasers = parseInt(row.metricValues?.[2]?.value || "0");
                const transactions = parseInt(row.metricValues?.[3]?.value || "0");
                const avgPurchase = parseFloat(row.metricValues?.[4]?.value || "0");

                // Calculate ARPU (Average Revenue Per User) and ARPPU (Average Revenue Per Paying User)
                const arpu = users > 0 ? revenue / users : 0;
                const arppu = purchasers > 0 ? revenue / purchasers : 0;
                const conversionRate = users > 0 ? (purchasers / users) * 100 : 0;

                return {
                    country,
                    revenue: Math.round(revenue * 100) / 100,
                    users,
                    purchasers,
                    transactions,
                    arpu: Math.round(arpu * 100) / 100,
                    arppu: Math.round(arppu * 100) / 100,
                    avgPurchase: Math.round(avgPurchase * 100) / 100,
                    conversionRate: Math.round(conversionRate * 100) / 100,
                };
            }).filter(item => item.revenue > 0 || item.users > 0) || [];

            // Sort by ARPU for top spending countries view
            const sortedByArpu = [...data].sort((a, b) => b.arpu - a.arpu);

            res.json({
                data,
                topByArpu: sortedByArpu.slice(0, 15),
                days,
                platform: platform || "all",
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error("Analytics revenue by country error:", error);
            res.status(500).json({ error: "Failed to fetch country revenue data" });
        }
    }
);

/**
 * Get retention metrics
 * Endpoint: /analyticsRetention?days=30
 */
export const analyticsRetention = onRequest(
    { cors: true, region: "us-central1", timeoutSeconds: 120 },
    async (req, res) => {
        // Verify admin authentication
        const authResult = await verifyAdminRequest(req, res);
        if (!authResult.success) return;

        try {
            const propertyId = ga4PropertyId.value();

            const days = reportDays(req.query.days);
            const dimensionFilter = platformFilter(req.query.platform);
            const [users] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [reportDateRange(days)],
                dimensions: [{ name: "newVsReturning" }],
                metrics: [{ name: "activeUsers" }],
                dimensionFilter,
            });
            const timeZone = users.metadata?.timeZone;
            if (!timeZone) throw new Error("GA4 did not return the property time zone");
            const requests = cohortRequests(propertyId, days, propertyToday(timeZone), dimensionFilter);
            const reports = [];
            for (let index = 0; index < requests.length; index += 4) {
                const batch = await Promise.all(requests.slice(index, index + 4).map(query => analyticsDataClient.runReport(query)));
                reports.push(...batch.map(result => result[0]));
            }
            const count = (kind: string) => Number(users.rows?.find(row => row.dimensionValues?.[0]?.value === kind)?.metricValues?.[0]?.value || 0);
            const newUsers = count("new");
            const returningUsers = count("returning");
            res.json({ ...summarizeRetention(reports), newUsers, returningUsers, days,
                returningRate: newUsers + returningUsers > 0 ? Math.round(returningUsers / (newUsers + returningUsers) * 1000) / 10 : 0,
                timestamp: new Date().toISOString() });
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
            const days = reportDays(req.query.days);
            const limit = parseInt(req.query.limit as string) || 15;

            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [reportDateRange(days)],
                dimensions: [{ name: "eventName" }],
                metrics: [
                    { name: "eventCount" },
                    { name: "eventCountPerUser" },
                ],
                orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
                limit: Math.min(100, Math.max(1, limit)),
                dimensionFilter: platformFilter(req.query.platform),
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
        } catch (error: any) {
            console.error("Analytics realtime error:", error);

            // Check if this is a quota exhaustion error
            const isQuotaError = error?.code === 8 ||
                error?.details?.includes("RESOURCE_EXHAUSTED") ||
                error?.message?.includes("quota");

            if (isQuotaError) {
                // Return empty data gracefully with a message instead of failing
                res.json({
                    activeUsers: 0,
                    usersByCountry: [],
                    usersByCity: [],
                    realtimeEvents: [],
                    timestamp: new Date().toISOString(),
                    quotaExhausted: true,
                    message: "Analytics API quota temporarily exhausted. Will reset within an hour."
                });
            } else {
                res.status(500).json({ error: "Failed to fetch realtime data" });
            }
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
            const days = reportDays(req.query.days);

            const [countryResponse, cityResponse] = await Promise.all([
                // Users and revenue by country
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [reportDateRange(days)],
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
                    dateRanges: [reportDateRange(days)],
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
            const days = reportDays(req.query.days);
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
                    dateRanges: [reportDateRange(days)],
                    dimensions: [{ name: "mobileDeviceModel" }],
                    metrics: [{ name: "activeUsers" }, { name: "sessions" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 20,
                    dimensionFilter,
                }),
                // Operating system versions
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [reportDateRange(days)],
                    dimensions: [{ name: "operatingSystemWithVersion" }],
                    metrics: [{ name: "activeUsers" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 15,
                    dimensionFilter,
                }),
                // Screen resolutions
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [reportDateRange(days)],
                    dimensions: [{ name: "screenResolution" }],
                    metrics: [{ name: "activeUsers" }],
                    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                    limit: 10,
                    dimensionFilter,
                }),
                // Device category breakdown
                analyticsDataClient.runReport({
                    property: propertyId,
                    dateRanges: [reportDateRange(days)],
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
            const days = reportDays(req.query.days);
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
                    dateRanges: [reportDateRange(days)],
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
                    dateRanges: [reportDateRange(days)],
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
                    dateRanges: [reportDateRange(days)],
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

export const analyticsInsights = onRequest({ cors: true, region: "us-central1", timeoutSeconds: 120 }, async (req, res) => {
    if (!(await verifyAdminRequest(req, res)).success) return;
    const section = String(req.query.section || "gameplay");
    const days = reportDays(req.query.days);
    try {
        const property = ga4PropertyId.value();
        if (section === "ledgerDetails") {
            const start = new Date();
            start.setUTCDate(start.getUTCDate() - days + 1);
            start.setUTCHours(0, 0, 0, 0);
            const snapshot = await admin.firestore().collection("AnalyticsLedger").where("occurredAt", ">=", admin.firestore.Timestamp.fromDate(start)).orderBy("occurredAt", "desc").limit(1000).get();
            const records = snapshot.docs.map(doc => doc.data());
            const sources = new Map<string, string>();
            for (const record of records) for (const entry of record.entries ?? []) {
                if (entry.kind === "server_operation_result" && entry.status === "completed") sources.set(record.commitKey, String(entry.target || "operation"));
                if (entry.kind === "server_iap_granted") sources.set(record.commitKey, "iap:" + String(entry.target || "unknown"));
                if (entry.kind === "server_race_settled") sources.set(record.commitKey, "race_settlement:" + String(entry.target || "unknown"));
            }
            const rows = records.flatMap(record => (record.entries ?? []).map((entry: { kind: string; currency?: string; delta?: number; target?: string; status?: string }) => ({
                occurredAt: record.occurredAt.toDate().toISOString(), commitKey: record.commitKey || "unknown", kind: entry.kind,
                currency: entry.currency || "", delta: entry.delta ?? 0, target: entry.target || "", status: entry.status || "",
                source: sources.get(record.commitKey) || "unattributed",
            })));
            res.json({ rows, truncated: snapshot.size === 1000, note: "Latest 1,000 server write events, UTC/all platforms. Source is joined only from a completed receipt, purchase grant or settlement with the same player and exact commit timestamp. Missing companions remain unattributed; background admin sources are never guessed." });
            return;
        }
        if (section === "ledger") {
            const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
            const snapshot = await admin.firestore().collection("AnalyticsDaily").where("day", ">=", start).orderBy("day", "desc").limit(10000).get();
            res.json({ rows: snapshot.docs.map(doc => doc.data()), note: "Authoritative server outcomes, UTC dates, all platforms. Kept separate from client balance observations. Collection starts after ledger triggers are deployed. GA4/Meta delivery is relayed by the client on its next login; this ledger is the authoritative source.", truncated: snapshot.size === 10000 });
            return;
        }
        if (section === "funnels") {
            const client = new v1alpha.AlphaAnalyticsDataClient();
            const funnels = await Promise.all(Object.entries(funnelDefinitions).map(async ([name, events]) => {
                try {
                    const [report] = await client.runFunnelReport({ property, dateRanges: [reportDateRange(days)],
                        dimensionFilter: platformFilter(req.query.platform),
                        funnel: { isOpenFunnel: false, steps: events.map(eventName => ({ name: eventName, filterExpression: { funnelEventFilter: { eventName } } })) }, limit: 10000 });
                    return { name, rows: reportRows(report.funnelTable ?? {}) };
                } catch { return { name, rows: [], error: "GA4 could not return this funnel. Check property access and Data API availability." }; }
            }));
            res.json({ funnels, note: "Closed ordered user funnels over the selected dates. Purchase success is the client-confirmed grant step, not a replacement for revenue reporting." });
            return;
        }
        const query = insightQuery(property, section, days, req.query.platform);
        const [metadata] = await analyticsDataClient.getMetadata({ name: property + "/metadata" });
        const available = new Set([...(metadata.dimensions ?? []), ...(metadata.metrics ?? [])].map(item => item.apiName));
        const missing = [...(query.dimensions ?? []), ...(query.metrics ?? [])].map(item => item.name!).filter(name => !available.has(name));
        if (missing.length) { res.json({ rows: [], notice: "Register the required GA4 report fields: " + missing.join(", "), missing }); return; }
        const [report] = await analyticsDataClient.runReport(query);
        const rows = reportRows(report);
        res.json({ rows: section === "maps" ? mapPreferenceRows(rows) : rows, truncated: Number(report.rowCount || 0) > rows.length,
            note: section === "maps" ? "Final non-abstaining votes divided by offered-map exposures. Changed-vote clicks are excluded; assignments are shown separately. These are event rates, not distinct-user preference percentages. Period boundaries may separate exposures and outcomes."
                : section === "economy" ? "Client balance observations only: net changes between snapshots, not authoritative transaction totals. Use Server Ledger for complete server changes."
                : section === "ads" ? "GA4 advertising revenue in USD from linked ad integrations. Diagnostic paid callbacks are not added to this revenue."
                : "Event and user counts; race starts show usage, not preference among offered choices." });
    } catch (error) {
        console.error("Analytics insight report failed", { section, code: (error as { code?: unknown }).code });
        res.status(500).json({ error: "This analytics report could not be loaded." });
    }
});
