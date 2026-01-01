import { BetaAnalyticsDataClient } from '@google-analytics/data';

// Initialize Analytics Data Client
let analyticsDataClient: BetaAnalyticsDataClient | null = null;

function getAnalyticsClient() {
    if (!analyticsDataClient) {
        analyticsDataClient = new BetaAnalyticsDataClient({
            credentials: {
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            },
        });
    }
    return analyticsDataClient;
}

const propertyId = process.env.GA4_PROPERTY_ID || '';

/**
 * Get Daily Active Users
 */
export async function getDailyActiveUsers() {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: 'yesterday',
                    endDate: 'today',
                },
            ],
            metrics: [
                {
                    name: 'activeUsers',
                },
            ],
        });

        return parseInt(response.rows?.[0]?.metricValues?.[0]?.value || '0');
    } catch (error) {
        console.error('Error fetching DAU:', error);
        return 0;
    }
}

/**
 * Get Weekly Active Users
 */
export async function getWeeklyActiveUsers() {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: '7daysAgo',
                    endDate: 'today',
                },
            ],
            metrics: [
                {
                    name: 'activeUsers',
                },
            ],
        });

        return parseInt(response.rows?.[0]?.metricValues?.[0]?.value || '0');
    } catch (error) {
        console.error('Error fetching WAU:', error);
        return 0;
    }
}

/**
 * Get Monthly Active Users
 */
export async function getMonthlyActiveUsers() {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: '30daysAgo',
                    endDate: 'today',
                },
            ],
            metrics: [
                {
                    name: 'activeUsers',
                },
            ],
        });

        return parseInt(response.rows?.[0]?.metricValues?.[0]?.value || '0');
    } catch (error) {
        console.error('Error fetching MAU:', error);
        return 0;
    }
}

/**
 * Get total users (all time)
 */
export async function getTotalUsers() {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: '2020-01-01', // Far enough back to get all users
                    endDate: 'today',
                },
            ],
            metrics: [
                {
                    name: 'totalUsers',
                },
            ],
        });

        return parseInt(response.rows?.[0]?.metricValues?.[0]?.value || '0');
    } catch (error) {
        console.error('Error fetching total users:', error);
        return 0;
    }
}

/**
 * Get session metrics
 */
export async function getSessionMetrics() {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: '30daysAgo',
                    endDate: 'today',
                },
            ],
            metrics: [
                {
                    name: 'sessions',
                },
                {
                    name: 'averageSessionDuration',
                },
                {
                    name: 'engagementRate',
                },
            ],
        });

        const row = response.rows?.[0];
        return {
            totalSessions: parseInt(row?.metricValues?.[0]?.value || '0'),
            avgDuration: parseFloat(row?.metricValues?.[1]?.value || '0'),
            engagementRate: parseFloat(row?.metricValues?.[2]?.value || '0') * 100,
        };
    } catch (error) {
        console.error('Error fetching session metrics:', error);
        return {
            totalSessions: 0,
            avgDuration: 0,
            engagementRate: 0,
        };
    }
}

/**
 * Get user growth over time
 */
export async function getUserGrowth(days: number = 30) {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: `${days}daysAgo`,
                    endDate: 'today',
                },
            ],
            dimensions: [
                {
                    name: 'date',
                },
            ],
            metrics: [
                {
                    name: 'newUsers',
                },
                {
                    name: 'activeUsers',
                },
            ],
        });

        return response.rows?.map(row => ({
            date: row.dimensionValues?.[0]?.value || '',
            newUsers: parseInt(row.metricValues?.[0]?.value || '0'),
            activeUsers: parseInt(row.metricValues?.[1]?.value || '0'),
        })) || [];
    } catch (error) {
        console.error('Error fetching user growth:', error);
        return [];
    }
}

/**
 * Get platform distribution (iOS vs Android)
 */
export async function getPlatformDistribution() {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: '30daysAgo',
                    endDate: 'today',
                },
            ],
            dimensions: [
                {
                    name: 'platform',
                },
            ],
            metrics: [
                {
                    name: 'activeUsers',
                },
            ],
        });

        return response.rows?.map(row => ({
            platform: row.dimensionValues?.[0]?.value || 'Unknown',
            users: parseInt(row.metricValues?.[0]?.value || '0'),
        })) || [];
    } catch (error) {
        console.error('Error fetching platform distribution:', error);
        return [];
    }
}

/**
 * Get events count for today
 */
export async function getTodayEventCount() {
    const client = getAnalyticsClient();

    try {
        const [response] = await client.runReport({
            property: propertyId,
            dateRanges: [
                {
                    startDate: 'today',
                    endDate: 'today',
                },
            ],
            metrics: [
                {
                    name: 'eventCount',
                },
            ],
        });

        return parseInt(response.rows?.[0]?.metricValues?.[0]?.value || '0');
    } catch (error) {
        console.error('Error fetching event count:', error);
        return 0;
    }
}
