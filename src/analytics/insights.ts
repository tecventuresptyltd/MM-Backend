import type { protos } from "@google-analytics/data";
import { platformFilter, reportDateRange } from "./reporting.js";

export const funnelDefinitions: Record<string, string[]> = {
    onboarding: ["tutorial_begin", "tutorial_complete", "race_start"],
    purchase: ["iap_view", "iap_initiated", "iap_success"],
    race: ["race_start", "race_finish", "race_reward_settled"],
};

export function insightQuery(property: string, section: string, days: number, platform: unknown): protos.google.analytics.data.v1beta.IRunReportRequest {
    const dimensions: Record<string, string[]> = {
        gameplay: ["eventName", "customEvent:map_id", "customEvent:car_id", "customEvent:mode", "customEvent:result"],
        maps: ["eventName", "customEvent:map_id", "customEvent:mode", "customEvent:reason"],
        economy: ["customEvent:currency", "customEvent:direction", "customEvent:source"],
        ads: ["date"],
        adEvents: ["eventName"],
    };
    const events: Record<string, string[]> = {
        gameplay: ["race_start", "race_finish", "police_chase_end", "infected_round_end"],
        maps: ["map_choice_exposed", "map_choice_outcome", "map_assigned"],
        economy: ["currency_balance_change"],
        adEvents: ["rewarded_ad_load", "rewarded_ad_requested", "rewarded_ad_started", "rewarded_ad_result", "ad_paid_callback", "ad_reward_claim_result", "ad_reward_claim_started", "rewarded_ad_viewed"],
    };
    if (!dimensions[section]) throw new Error("Unknown report section");
    const filter = platformFilter(platform);
    const expressions: protos.google.analytics.data.v1beta.IFilterExpression[] = filter ? [filter] : [];
    if (events[section]) expressions.push({ filter: { fieldName: "eventName", inListFilter: { values: events[section] } } });
    const metrics = section === "ads" ? ["totalAdRevenue", "publisherAdClicks", "publisherAdImpressions"] : section === "economy" ? ["eventCount", "customEvent:amount"] : ["eventCount", "totalUsers"];
    return { property, currencyCode: "USD", dateRanges: [reportDateRange(days)],
        dimensions: dimensions[section].map(name => ({ name })), metrics: metrics.map(name => ({ name })),
        dimensionFilter: expressions.length ? { andGroup: { expressions } } : undefined,
        limit: 10000, orderBys: [{ metric: { metricName: metrics[0] }, desc: true }] };
}

export function reportRows(report: { dimensionHeaders?: { name?: string | null }[] | null; metricHeaders?: { name?: string | null }[] | null; rows?: { dimensionValues?: { value?: string | null }[] | null; metricValues?: { value?: string | null }[] | null }[] | null }): Record<string, string | number>[] {
    return (report.rows ?? []).map(row => Object.fromEntries([
        ...(report.dimensionHeaders ?? []).map((header, index) => [header.name ?? String(index), row.dimensionValues?.[index]?.value ?? ""]),
        ...(report.metricHeaders ?? []).map((header, index) => [header.name ?? String(index), Number(row.metricValues?.[index]?.value || 0)]),
    ]));
}

export function mapPreferenceRows(rows: Record<string, string | number>[]) {
    const maps = new Map<string, { map: string; mode: string; exposures: number; finalVotes: number; assignments: number }>();
    for (const row of rows) {
        const map = String(row["customEvent:map_id"] || "unknown"), mode = String(row["customEvent:mode"] || "unknown");
        const key = JSON.stringify([map, mode]);
        const total = maps.get(key) ?? { map, mode, exposures: 0, finalVotes: 0, assignments: 0 };
        const count = Number(row.eventCount || 0);
        if (row.eventName === "map_choice_exposed") total.exposures += count;
        if (row.eventName === "map_choice_outcome" && row["customEvent:reason"] !== "abstained") total.finalVotes += count;
        if (row.eventName === "map_assigned") total.assignments += count;
        maps.set(key, total);
    }
    return [...maps.values()].map(row => ({ ...row, finalVotesPerExposurePercent: row.exposures ? Math.round(row.finalVotes / row.exposures * 10000) / 100 : "N/A" }));
}
