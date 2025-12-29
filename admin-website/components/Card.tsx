import React from "react";

interface CardProps {
    children: React.ReactNode;
    className?: string;
}

export function Card({ children, className = "" }: CardProps) {
    return (
        <div className={`bg-white rounded-lg shadow-lg ${className}`}>
            {children}
        </div>
    );
}

interface CardHeaderProps {
    title: string;
    subtitle?: string;
}

export function CardHeader({ title, subtitle }: CardHeaderProps) {
    return (
        <div className="border-b border-gray-200 px-6 py-4 sm:px-8 sm:py-6">
            <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
            {subtitle && (
                <p className="text-sm text-gray-600 mt-1">{subtitle}</p>
            )}
        </div>
    );
}

interface CardContentProps {
    children: React.ReactNode;
    className?: string;
}

export function CardContent({ children, className = "" }: CardContentProps) {
    return (
        <div className={`px-6 py-4 sm:px-8 sm:py-6 ${className}`}>
            {children}
        </div>
    );
}
