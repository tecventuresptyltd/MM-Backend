import { onRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

// Define environment parameter
const ga4PropertyId = defineString("GA4_PROPERTY_ID");

/**
 * Simple test function to diagnose GA4 API connection issues
 * Endpoint: /testAnalytics
 */
export const testAnalytics = onRequest(
    { cors: true, region: "us-central1" },
    async (req, res) => {
        const logs: string[] = [];

        try {
            logs.push("1. Starting analytics test...");

            // Log the property ID
            const propertyId = ga4PropertyId.value();
            logs.push(`2. Property ID from env: ${propertyId}`);

            // Try to initialize the client
            logs.push("3. Initializing BetaAnalyticsDataClient...");
            const analyticsDataClient = new BetaAnalyticsDataClient();
            logs.push("4. Client initialized successfully");

            // Try a simple query
            logs.push("5. Attempting to run a simple report...");
            const [response] = await analyticsDataClient.runReport({
                property: propertyId,
                dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
                metrics: [{ name: "activeUsers" }],
            });

            logs.push("6. Report executed successfully!");
            logs.push(`7. Response received, checking data...`);

            const activeUsers = parseInt(
                response.rows?.[0]?.metricValues?.[0]?.value || "0"
            );

            logs.push(`8. Active users (last 7 days): ${activeUsers}`);

            res.json({
                success: true,
                logs,
                data: {
                    propertyId,
                    activeUsers,
                    rowCount: response.rows?.length || 0,
                },
            });
        } catch (error: any) {
            logs.push(`ERROR at step: ${error.message}`);
            logs.push(`Error code: ${error.code || "unknown"}`);
            logs.push(`Error details: ${error.details || "none"}`);

            console.error("Test analytics error:", error);
            console.error("Error stack:", error.stack);
            console.error("Full error object:", JSON.stringify(error, null, 2));

            res.status(500).json({
                success: false,
                logs,
                error: {
                    message: error.message,
                    code: error.code,
                    details: error.details,
                },
            });
        }
    }
);
