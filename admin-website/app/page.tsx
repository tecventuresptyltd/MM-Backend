"use client";

import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import AuthGuard from "@/components/AuthGuard";
import Link from "next/link";
import Image from "next/image";

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
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black">
        {/* Header */}
        <header className="border-b border-gray-700 bg-black/40 backdrop-blur-md">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Image
                src="/logo.png"
                alt="Mystic Motors"
                width={48}
                height={48}
                className="drop-shadow-lg"
              />
              <div>
                <h1 className="text-2xl font-bold text-white tracking-tight">
                  Mystic Motors
                </h1>
                <p className="text-sm text-gray-400">Admin Dashboard</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="px-6 py-2.5 bg-red-600/90 text-white rounded-lg hover:bg-red-700 transition font-medium shadow-lg hover:shadow-red-500/50"
            >
              Logout
            </button>
          </div>
        </header>

        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="mb-10">
            <h2 className="text-3xl font-bold text-white mb-3 tracking-tight">
              Dashboard
            </h2>
            <p className="text-gray-400 text-lg">
              Manage game configuration and player support
            </p>
          </div>

          {/* Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Maintenance Mode Card */}
            <Link href="/maintenance">
              <div className="h-full flex flex-col group bg-gradient-to-br from-blue-900/40 to-blue-800/20 backdrop-blur-sm rounded-2xl shadow-2xl hover:shadow-blue-500/20 transition-all duration-300 p-8 cursor-pointer border border-blue-700/30 hover:border-blue-500/50 hover:scale-105">
                <div className="flex items-center mb-6">
                  <div className="p-4 bg-blue-600/30 rounded-xl group-hover:bg-blue-600/50 transition">
                    <svg
                      className="w-10 h-10 text-blue-400 group-hover:text-blue-300 transition"
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
                <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-blue-300 transition">
                  Maintenance Mode
                </h3>
                <p className="text-gray-400 text-sm leading-relaxed">
                  Toggle maintenance mode, set messages, and configure rewards
                </p>
              </div>
            </Link>

            {/* Version Control Card */}
            <Link href="/version">
              <div className="h-full flex flex-col group bg-gradient-to-br from-green-900/40 to-green-800/20 backdrop-blur-sm rounded-2xl shadow-2xl hover:shadow-green-500/20 transition-all duration-300 p-8 cursor-pointer border border-green-700/30 hover:border-green-500/50 hover:scale-105">
                <div className="flex items-center mb-6">
                  <div className="p-4 bg-green-600/30 rounded-xl group-hover:bg-green-600/50 transition">
                    <svg
                      className="w-10 h-10 text-green-400 group-hover:text-green-300 transition"
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
                <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-green-300 transition">
                  Version Control
                </h3>
                <p className="text-gray-400 text-sm leading-relaxed">
                  Set minimum app version requirements for players
                </p>
              </div>
            </Link>

            {/* Game Admins Card */}
            <Link href="/game-admins">
              <div className="h-full flex flex-col group bg-gradient-to-br from-purple-900/40 to-purple-800/20 backdrop-blur-sm rounded-2xl shadow-2xl hover:shadow-purple-500/20 transition-all duration-300 p-8 cursor-pointer border border-purple-700/30 hover:border-purple-500/50 hover:scale-105">
                <div className="flex items-center mb-6">
                  <div className="p-4 bg-purple-600/30 rounded-xl group-hover:bg-purple-600/50 transition">
                    <svg
                      className="w-10 h-10 text-purple-400 group-hover:text-purple-300 transition"
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
                <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-purple-300 transition">
                  Game Admins
                </h3>
                <p className="text-gray-400 text-sm leading-relaxed">
                  Manage players who can bypass maintenance mode for testing
                </p>
              </div>
            </Link>

            {/* Analytics Card */}
            <Link href="/analytics">
              <div className="h-full flex flex-col group bg-gradient-to-br from-orange-900/40 to-orange-800/20 backdrop-blur-sm rounded-2xl shadow-2xl hover:shadow-orange-500/20 transition-all duration-300 p-8 cursor-pointer border border-orange-700/30 hover:border-orange-500/50 hover:scale-105">
                <div className="flex items-center mb-6">
                  <div className="p-4 bg-orange-600/30 rounded-xl group-hover:bg-orange-600/50 transition">
                    <svg
                      className="w-10 h-10 text-white"
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
                <h3 className="text-2xl font-bold text-white mb-3">
                  Analytics
                </h3>
                <p className="text-gray-300 leading-relaxed">
                  View user stats and game performance metrics from Firebase Analytics
                </p>
              </div>
            </Link>

            {/* Player Support Card (Coming Soon) */}
            <div className="bg-gradient-to-br from-gray-800/40 to-gray-700/20 backdrop-blur-sm rounded-2xl shadow-xl p-8 opacity-50 cursor-not-allowed border border-gray-600/30">
              <div className="flex items-center mb-6">
                <div className="p-4 bg-gray-600/30 rounded-xl">
                  <svg
                    className="w-10 h-10 text-gray-400"
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
              <h3 className="text-2xl font-bold text-white mb-3 flex items-center gap-2">
                Player Support
                <span className="text-xs bg-gray-700 px-2 py-1 rounded font-normal">
                  Coming Soon
                </span>
              </h3>
              <p className="text-gray-400 text-sm leading-relaxed">
                Award items, gems, coins, and manage player issues
              </p>
            </div>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
