import { cohortRequests, platformFilter, propertyToday, reportDateRange, reportDays, summarizeRetention } from "../src/analytics/reporting";

describe("analytics reporting", () => {
    test("selected windows include exactly the requested number of dates", () => {
        expect(reportDateRange(1)).toEqual({ startDate: "today", endDate: "today" });
        expect(reportDateRange(7).startDate).toBe("6daysAgo");
        expect(reportDateRange(30).startDate).toBe("29daysAgo");
        for (const value of [0, -1, 366, "x", 2.5]) expect(reportDays(value)).toBe(30);
    });

    test("daily cohorts stop before incomplete return days and preserve platform", () => {
        const filter = platformFilter("ios");
        const queries = cohortRequests("properties/test", 365, "2026-10-09", filter);
        const ages: number[] = [];
        for (const query of queries) {
            expect(query.dateRanges).toBeUndefined();
            expect(query.dimensionFilter).toEqual(filter);
            expect(query.dimensions?.map(item => item.name)).toEqual(["cohort", "cohortNthDay"]);
            expect(query.metrics?.map(item => item.name)).toEqual(["cohortActiveUsers", "cohortTotalUsers"]);
            expect(query.cohortSpec?.cohorts?.length).toBeLessThanOrEqual(12);
            for (const cohort of query.cohortSpec?.cohorts ?? []) {
                const age = Number(cohort.name?.replace("age_", ""));
                ages.push(age);
                expect(cohort.dateRange?.startDate).toBe(cohort.dateRange?.endDate);
                expect(cohort.dateRange?.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                expect((Date.parse("2026-10-09T00:00:00Z") - Date.parse(cohort.dateRange!.startDate! + "T00:00:00Z")) / 86400000).toBe(age);
                expect(query.cohortSpec?.cohortsRange?.endOffset).toBeLessThan(age);
                for (const day of [1, 7, 30]) {
                    if (age > day) expect(query.cohortSpec?.cohortsRange?.endOffset).toBeGreaterThanOrEqual(day);
                }
            }
        }
        expect(ages).toEqual(Array.from({ length: 363 }, (_, index) => index + 2));
        expect(cohortRequests("properties/test", 1, "2026-10-09")).toEqual([]);
        expect(cohortRequests("properties/test", 2, "2026-10-09")).toEqual([]);
    });

    test("cohort dates follow the property calendar across midnight and DST", () => {
        const instant = new Date("2026-03-09T02:00:00Z");
        expect(propertyToday("America/Los_Angeles", instant)).toBe("2026-03-08");
        expect(propertyToday("Asia/Kolkata", instant)).toBe("2026-03-09");
        const query = cohortRequests("properties/test", 8, propertyToday("America/Los_Angeles", instant))[0];
        expect(query.cohortSpec?.cohorts?.[0].dateRange).toEqual({ startDate: "2026-03-06", endDate: "2026-03-06" });
        expect(() => cohortRequests("properties/test", 8, "2026-02-30")).toThrow("Invalid property calendar date");
    });

    test("retention is weighted by mature cohort size, retaining zero-return cohorts", () => {
        const row = (age: number, day: number, active: number, total: number) => ({ dimensionValues: [{ value: `age_${age}` }, { value: String(day).padStart(4, "0") }], metricValues: [{ value: String(active) }, { value: String(total) }] });
        const result = summarizeRetention([{ rows: [row(2, 0, 100, 100), row(2, 1, 50, 100), row(8, 0, 10, 10), row(8, 1, 10, 10), row(8, 7, 2, 10), row(31, 0, 90, 90), row(31, 1, 0, 90), row(31, 7, 9, 90), row(31, 30, 9, 90)] }]);
        expect(result).toEqual({ day1Retention: 30, day7Retention: 11, day30Retention: 10, cohortUsers: { day1: 200, day7: 100, day30: 90 } });
        expect(summarizeRetention([{ rows: [row(31, 0, 100, 100)] }]).day30Retention).toBe(0);
        expect(summarizeRetention([]).day1Retention).toBeNull();
    });
});
