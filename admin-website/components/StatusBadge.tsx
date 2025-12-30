import React from "react";

type StatusType = "active" | "inactive" | "scheduled" | "warning";

interface StatusBadgeProps {
    status: StatusType;
    label?: string;
}

const statusStyles = {
    active: "bg-red-100 text-red-800 border-red-200",
    inactive: "bg-gray-100 text-gray-800 border-gray-200",
    scheduled: "bg-orange-100 text-orange-800 border-orange-200",
    warning: "bg-yellow-100 text-yellow-800 border-yellow-200",
};

const defaultLabels = {
    active: "Active",
    inactive: "Inactive",
    scheduled: "Scheduled",
    warning: "Warning",
};

export default function StatusBadge({ status, label }: StatusBadgeProps) {
    const displayLabel = label || defaultLabels[status];

    return (
        <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${statusStyles[status]}`}>
            {displayLabel}
        </span>
    );
}
