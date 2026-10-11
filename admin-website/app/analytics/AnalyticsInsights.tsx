"use client";

import { useEffect, useState } from "react";
import { useFirebase } from "@/lib/FirebaseContext";

type Row = Record<string, string | number>;
type Report = { rows?: Row[]; note?: string; notice?: string; truncated?: boolean; funnels?: { name: string; rows: Row[]; error?: string }[] };
const sections = { maps: "Map preferences", gameplay: "Cars, modes and race outcomes", funnels: "Ordered funnels", economy: "Client economy observations", ledger: "Server ledger", ledgerDetails: "Server transaction details", ads: "Advertising revenue", adEvents: "Rewarded ad activity" };

function ReportTable({ rows }: { rows: Row[] }) {
    if (!rows.length) return <p className="text-gray-400 p-4">No data for this period. New custom fields populate only after registration and new events arrive.</p>;
    const columns = Object.keys(rows[0]);
    return <div className="overflow-auto max-h-[600px]"><table className="w-full text-sm"><thead><tr>{columns.map(column => <th key={column} className="p-3 text-left text-gray-300">{column.replace("customEvent:", "").replaceAll("_", " ")}</th>)}</tr></thead><tbody>{rows.slice(0, 500).map((row, index) => <tr key={index} className="border-t border-gray-700">{columns.map(column => <td key={column} className="p-3">{typeof row[column] === "number" ? row[column].toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(row[column] ?? "")}</td>)}</tr>)}</tbody></table>{rows.length > 500 && <p className="p-3 text-yellow-300">Showing the first 500 rows.</p>}</div>;
}

export default function AnalyticsInsights({ days, platform }: { days: string; platform: string }) {
    const { user, environmentConfig } = useFirebase();
    const [section, setSection] = useState<keyof typeof sections>("maps");
    const [revision, setRevision] = useState(0);
    const [report, setReport] = useState<Report | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const abort = new AbortController();
        setReport(null); setError(null);
        (async () => {
            if (!user) throw new Error("Sign in to view this report.");
            const token = await user.getIdToken();
            const query = new URLSearchParams({ section, days, platform });
            const response = await fetch(environmentConfig.functionsUrl + "/analyticsInsights?" + query, { headers: { Authorization: "Bearer " + token }, signal: abort.signal });
            if (!response.ok) throw new Error("This report could not be loaded (HTTP " + response.status + ").");
            const next = await response.json();
            if (!abort.signal.aborted) setReport(next);
        })().catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Report unavailable"); });
        return () => abort.abort();
    }, [user, environmentConfig.functionsUrl, days, platform, section, revision]);
    return <section className="rounded-xl bg-gray-800/50 border border-gray-700 p-4 space-y-4">
        <div className="flex flex-wrap gap-3"><select aria-label="Analysis report" value={section} onChange={event => setSection(event.target.value as keyof typeof sections)} className="bg-gray-900 p-2 rounded">{Object.entries(sections).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button onClick={() => setRevision(value => value + 1)} className="bg-blue-700 rounded px-4 py-2">Refresh report</button></div>
        {error && <p role="alert" className="text-red-300">{error}</p>}
        {!error && !report && <p className="text-gray-400">Loading report...</p>}
        {report?.note && <p className="text-gray-300">{report.note}</p>}
        {report?.notice && <p role="status" className="text-yellow-300">{report.notice}</p>}
        {report?.truncated && <p className="text-yellow-300">Results reached the report row limit. Shorten the reporting period for complete results.</p>}
        {report?.rows && <ReportTable rows={report.rows} />}
        {report?.funnels?.map(funnel => <section key={funnel.name}><h3 className="font-semibold capitalize mb-2">{funnel.name}</h3>{funnel.error ? <p className="text-yellow-300">{funnel.error}</p> : <ReportTable rows={funnel.rows} />}</section>)}
    </section>;
}
