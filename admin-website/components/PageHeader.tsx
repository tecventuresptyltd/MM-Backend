"use client";

import React from "react";
import { useRouter } from "next/navigation";
import EnvironmentSwitcher from "./EnvironmentSwitcher";

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    showBackButton?: boolean;
}

export default function PageHeader({ title, subtitle, showBackButton = true }: PageHeaderProps) {
    const router = useRouter();

    return (
        <header className="border-b border-gray-700/30 bg-black/40 backdrop-blur-md shadow-2xl">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
                <div className="flex items-center justify-between">
                    <div className="flex items-center">
                        {showBackButton && (
                            <button
                                onClick={() => router.push("/")}
                                className="mr-3 sm:mr-4 p-2 hover:bg-gray-800/50 rounded-lg transition"
                                aria-label="Go back"
                            >
                                <svg
                                    className="w-5 h-5 sm:w-6 sm:h-6 text-gray-400"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M15 19l-7-7 7-7"
                                    />
                                </svg>
                            </button>
                        )}
                        <div>
                            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                                {title}
                            </h1>
                            {subtitle && (
                                <p className="text-sm text-gray-400 mt-1">{subtitle}</p>
                            )}
                        </div>
                    </div>
                    <EnvironmentSwitcher />
                </div>
            </div>
        </header>
    );
}

