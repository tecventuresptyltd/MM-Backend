import type { protos } from "@google-analytics/data";

type Filter = protos.google.analytics.data.v1beta.IFilterExpression;
type Report = protos.google.analytics.data.v1beta.IRunReportResponse;
type Query = protos.google.analytics.data.v1beta.IRunReportRequest;

export function reportDays(value: unknown): number {
    const days = Number(value ?? 30);
    return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30;
}

export function reportDateRange(days: number) {
    return { startDate: days === 1 ? "today" : `${days - 1}daysAgo`, endDate: "today" };
}

export function platformFilter(value: unknown): Filter | undefined {
    const platform = typeof value === "string" ? value.toLowerCase() : "";
    const normalized = platform === "ios" ? "iOS" : platform === "android" ? "Android" : platform === "web" ? "web" : undefined;
    return normalized ? { filter: { fieldName: "platform", stringFilter: { value: normalized, matchType: "EXACT" } } } : undefined;
}

export function propertyToday(timeZone: string, now = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (kind: string) => parts.find(value => value.type === kind)!.value;
    return part("year") + "-" + part("month") + "-" + part("day");
}

export function cohortRequests(property: string, days: number, today: string, dimensionFilter?: Filter): Query[] {
    const anchor = new Date(today + "T00:00:00.000Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== today) throw new Error("Invalid property calendar date");
    const dateForAge = (age: number) => new Date(anchor.getTime() - age * 86400000).toISOString().slice(0, 10);
    const requests: Query[] = [];
    for (const [first, last] of [[2, 7], [8, 30], [31, 364]]) {
        for (let age = first; age <= Math.min(last, days - 1); age += 12) {
            const ages = Array.from({ length: Math.min(12, last - age + 1, days - age) }, (_, index) => age + index);
            requests.push({
                property,
                dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }],
                metrics: [{ name: "cohortActiveUsers" }, { name: "cohortTotalUsers" }],
                cohortSpec: {
                    cohorts: ages.map(value => ({ name: `age_${value}`, dimension: "firstSessionDate", dateRange: { startDate: dateForAge(value), endDate: dateForAge(value) } })),
                    cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: Math.min(30, age - 1) },
                },
                dimensionFilter,
                keepEmptyRows: true,
                limit: 10000,
            });
        }
    }
    return requests;
}

export function summarizeRetention(reports: Report[]) {
    const cohorts = new Map<string, { age: number; total: number; active: Map<number, number> }>();
    for (const report of reports) {
        for (const row of report.rows ?? []) {
            const name = row.dimensionValues?.[0]?.value ?? "";
            const age = Number(name.replace("age_", ""));
            if (!Number.isInteger(age) || age < 2) continue;
            const cohort = cohorts.get(name) ?? { age, total: 0, active: new Map<number, number>() };
            cohort.total = Math.max(cohort.total, Number(row.metricValues?.[1]?.value || 0));
            cohort.active.set(Number(row.dimensionValues?.[1]?.value), Number(row.metricValues?.[0]?.value || 0));
            cohorts.set(name, cohort);
        }
    }
    const calculate = (day: number) => {
        let total = 0;
        let active = 0;
        for (const cohort of cohorts.values()) {
            if (cohort.age <= day) continue;
            total += cohort.total;
            active += cohort.active.get(day) ?? 0;
        }
        return { rate: total ? Math.round(active / total * 1000) / 10 : null, users: total };
    };
    const d1 = calculate(1), d7 = calculate(7), d30 = calculate(30);
    return { day1Retention: d1.rate, day7Retention: d7.rate, day30Retention: d30.rate,
        cohortUsers: { day1: d1.users, day7: d7.users, day30: d30.users } };
}
