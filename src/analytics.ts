import { onRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

// Define environment parameter
const ga4PropertyId = defineString("GA4_PROPERTY_ID");

// Initialize Analytics Data Client
const analyticsDataClient = new BetaAnalyticsDataClient();

/**
 * Get overview analytics metrics
 * Endpoint: /analyticsOverview
 */
export const analyticsOverview = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
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

            res.json({
                dau,
                wau,
                mau,
                totalUsers,
                totalSessions,
                avgSessionDuration: Math.round(avgDuration),
                engagementRate: Math.round(engagementRate * 1000) / 10,
                eventCount,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Analytics overview error:", error);
            console.error("Property ID used:", ga4PropertyId.value());
            console.error("Full error details:", JSON.stringify(error, null, 2));
            res.status(500).json({ error: "Failed to fetch analytics data" });
        }
    }
);

/**
 * Get user growth data
 * Endpoint: /analyticsGrowth?days=30
 */
export const analyticsGrowth = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        try {
            const propertyId = ga4PropertyId.value();
            const days = parseInt(req.query.days as string) || 30;

            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [{ startDate: `${days} daysAgo`, endDate: "today" }],
                dimensions: [{ name: "date" }],
                metrics: [{ name: "newUsers" }, { name: "activeUsers" }],
            });

            const data = response.rows?.map((row) => ({
                date: row.dimensionValues?.[0]?.value || "",
                newUsers: parseInt(row.metricValues?.[0]?.value || "0"),
                activeUsers: parseInt(row.metricValues?.[1]?.value || "0"),
            })) || [];

            res.json({ data, timestamp: new Date().toISOString() });
        } catch (error) {
            console.error("Analytics growth error:", error);
            res.status(500).json({ error: "Failed to fetch user growth data" });
        }
    }
);

/**
 * Get platform distribution
 * Endpoint: /analyticsPlatforms
 */
export const analyticsPlatforms = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
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

            res.json({ data, timestamp: new Date().toISOString() });
        } catch (error) {
            console.error("Analytics platforms error:", error);
            res.status(500).json({ error: "Failed to fetch platform data" });
        }
    }
);
