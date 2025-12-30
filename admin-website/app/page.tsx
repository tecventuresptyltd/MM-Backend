"use client";

import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import AuthGuard from "@/components/AuthGuard";
import Link from "next/link";

export default function DashboardPage() {
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await signOut(auth);
      router.push("/login");
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

  return (
    <AuthGuard>
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="bg-white shadow-md">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex justify-between items-center">
            <h1 className="text-3xl font-bold text-gray-900">
              Mystic Motors Admin
            </h1>
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition font-medium"
            >
              Logout
            </button>
          </div>
        </header>

        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="mb-8">
            <h2 className="text-2xl font-semibold text-gray-800 mb-2">
              Dashboard
            </h2>
            <p className="text-gray-600">
              Manage game configuration and player support
            </p>
          </div>

          {/* Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Maintenance Mode Card */}
            <Link href="/maintenance">
              <div className="bg-white rounded-xl shadow-lg hover:shadow-xl transition p-6 cursor-pointer border-2 border-transparent hover:border-blue-500">
                <div className="flex items-center mb-4">
                  <div className="p-3 bg-blue-100 rounded-lg">
                    <svg
                      className="w-8 h-8 text-blue-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                  </div>
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  Maintenance Mode
                </h3>
                <p className="text-gray-600 text-sm">
                  Toggle maintenance mode, set messages, and configure rewards
                </p>
              </div>
            </Link>

            {/* Version Control Card */}
            <Link href="/version">
              <div className="bg-white rounded-xl shadow-lg hover:shadow-xl transition p-6 cursor-pointer border-2 border-transparent hover:border-green-500">
                <div className="flex items-center mb-4">
                  <div className="p-3 bg-green-100 rounded-lg">
                    <svg
                      className="w-8 h-8 text-green-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  </div>
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  Version Control
                </h3>
                <p className="text-gray-600 text-sm">
                  Set minimum app version requirements for players
                </p>
              </div>
            </Link>

            {/* Game Admins Card */}
            <Link href="/game-admins">
              <div className="bg-white rounded-xl shadow-lg hover:shadow-xl transition p-6 cursor-pointer border-2 border-transparent hover:border-purple-500">
                <div className="flex items-center mb-4">
                  <div className="p-3 bg-purple-100 rounded-lg">
                    <svg
                      className="w-8 h-8 text-purple-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                      />
                    </svg>
                  </div>
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  Game Admins
                </h3>
                <p className="text-gray-600 text-sm">
                  Manage players who can bypass maintenance mode for testing
                </p>
              </div>
            </Link>

            {/* Analytics Card (Coming Soon) */}
            <div className="bg-gray-100 rounded-xl shadow-lg p-6 opacity-60 cursor-not-allowed">
              <div className="flex items-center mb-4">
                <div className="p-3 bg-purple-100 rounded-lg">
                  <svg
                    className="w-8 h-8 text-purple-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                Analytics
                <span className="ml-2 text-xs bg-gray-200 px-2 py-1 rounded">
                  Coming Soon
                </span>
              </h3>
              <p className="text-gray-600 text-sm">
                View user stats and game performance metrics
              </p>
            </div>

            {/* Player Support Card (Coming Soon) */}
            <div className="bg-gray-100 rounded-xl shadow-lg p-6 opacity-60 cursor-not-allowed">
              <div className="flex items-center mb-4">
                <div className="p-3 bg-orange-100 rounded-lg">
                  <svg
                    className="w-8 h-8 text-orange-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
                    />
                  </svg>
                </div>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                Player Support
                <span className="ml-2 text-xs bg-gray-200 px-2 py-1 rounded">
                  Coming Soon
                </span>
              </h3>
              <p className="text-gray-600 text-sm">
                Award items, gems, coins, and manage player issues
              </p>
            </div>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
