"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface UserLocation {
    city: string;
    country: string;
    users: number;
}

interface InteractiveWorldMapProps {
    usersByCity: UserLocation[];
    activeUsers?: number;
}

// City coordinates database (lat, lng) for major world cities
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
    // Australia & Oceania
    'Sydney': { lat: -33.87, lng: 151.21 },
    'Melbourne': { lat: -37.81, lng: 144.96 },
    'Brisbane': { lat: -27.47, lng: 153.03 },
    'Perth': { lat: -31.95, lng: 115.86 },
    'Auckland': { lat: -36.85, lng: 174.76 },
    'Wellington': { lat: -41.29, lng: 174.78 },
    // North America
    'New York': { lat: 40.71, lng: -74.01 },
    'Los Angeles': { lat: 34.05, lng: -118.24 },
    'Chicago': { lat: 41.88, lng: -87.63 },
    'Houston': { lat: 29.76, lng: -95.37 },
    'Phoenix': { lat: 33.45, lng: -112.07 },
    'San Francisco': { lat: 37.77, lng: -122.42 },
    'Seattle': { lat: 47.61, lng: -122.33 },
    'Toronto': { lat: 43.65, lng: -79.38 },
    'Vancouver': { lat: 49.28, lng: -123.12 },
    'Mexico City': { lat: 19.43, lng: -99.13 },
    'Miami': { lat: 25.76, lng: -80.19 },
    'Boston': { lat: 42.36, lng: -71.06 },
    'Denver': { lat: 39.74, lng: -104.99 },
    'Atlanta': { lat: 33.75, lng: -84.39 },
    'Dallas': { lat: 32.78, lng: -96.80 },
    // Cloud/Data center cities
    'Boardman': { lat: 45.84, lng: -119.70 },
    'Ashburn': { lat: 39.04, lng: -77.49 },
    'San Jose': { lat: 37.34, lng: -121.89 },
    'Portland': { lat: 45.52, lng: -122.68 },
    'Las Vegas': { lat: 36.17, lng: -115.14 },
    'Salt Lake City': { lat: 40.76, lng: -111.89 },
    'Columbus': { lat: 39.96, lng: -83.00 },
    'Charlotte': { lat: 35.23, lng: -80.84 },
    'Minneapolis': { lat: 44.98, lng: -93.27 },
    'Detroit': { lat: 42.33, lng: -83.05 },
    'Philadelphia': { lat: 39.95, lng: -75.17 },
    'San Diego': { lat: 32.72, lng: -117.16 },
    'Austin': { lat: 30.27, lng: -97.74 },
    'Nashville': { lat: 36.16, lng: -86.78 },
    'Raleigh': { lat: 35.78, lng: -78.64 },
    'Orlando': { lat: 28.54, lng: -81.38 },
    'Pittsburgh': { lat: 40.44, lng: -79.99 },
    'Cleveland': { lat: 41.50, lng: -81.69 },
    'Kansas City': { lat: 39.10, lng: -94.58 },
    'St. Louis': { lat: 38.63, lng: -90.20 },
    'Indianapolis': { lat: 39.77, lng: -86.16 },
    'Cincinnati': { lat: 39.10, lng: -84.51 },
    'Milwaukee': { lat: 43.04, lng: -87.91 },
    'Tampa': { lat: 27.95, lng: -82.46 },
    'Sacramento': { lat: 38.58, lng: -121.49 },
    'Omaha': { lat: 41.26, lng: -95.94 },
    // Europe
    'London': { lat: 51.51, lng: -0.13 },
    'Paris': { lat: 48.86, lng: 2.35 },
    'Berlin': { lat: 52.52, lng: 13.41 },
    'Madrid': { lat: 40.42, lng: -3.70 },
    'Rome': { lat: 41.90, lng: 12.50 },
    'Amsterdam': { lat: 52.37, lng: 4.89 },
    'Stockholm': { lat: 59.33, lng: 18.07 },
    'Oslo': { lat: 59.91, lng: 10.75 },
    'Helsinki': { lat: 60.17, lng: 24.94 },
    'Copenhagen': { lat: 55.68, lng: 12.57 },
    'Warsaw': { lat: 52.23, lng: 21.01 },
    'Prague': { lat: 50.08, lng: 14.44 },
    'Vienna': { lat: 48.21, lng: 16.37 },
    'Munich': { lat: 48.14, lng: 11.58 },
    'Dublin': { lat: 53.35, lng: -6.26 },
    'Barcelona': { lat: 41.39, lng: 2.17 },
    'Milan': { lat: 45.46, lng: 9.19 },
    'Zurich': { lat: 47.37, lng: 8.54 },
    'Brussels': { lat: 50.85, lng: 4.35 },
    'Lisbon': { lat: 38.72, lng: -9.14 },
    'Frankfurt': { lat: 50.11, lng: 8.68 },
    'Manchester': { lat: 53.48, lng: -2.24 },
    'Birmingham': { lat: 52.49, lng: -1.90 },
    'Leeds': { lat: 53.80, lng: -1.55 },
    'Glasgow': { lat: 55.86, lng: -4.25 },
    'Edinburgh': { lat: 55.95, lng: -3.19 },
    'Lyon': { lat: 45.76, lng: 4.84 },
    'Marseille': { lat: 43.30, lng: 5.37 },
    'Hamburg': { lat: 53.55, lng: 9.99 },
    // Asia
    'Tokyo': { lat: 35.68, lng: 139.69 },
    'Seoul': { lat: 37.57, lng: 126.98 },
    'Beijing': { lat: 39.90, lng: 116.41 },
    'Shanghai': { lat: 31.23, lng: 121.47 },
    'Hong Kong': { lat: 22.32, lng: 114.17 },
    'Singapore': { lat: 1.35, lng: 103.82 },
    'Bangkok': { lat: 13.76, lng: 100.50 },
    'Mumbai': { lat: 19.08, lng: 72.88 },
    'Delhi': { lat: 28.61, lng: 77.21 },
    'Noida': { lat: 28.53, lng: 77.39 },
    'Bangalore': { lat: 12.97, lng: 77.59 },
    'Jakarta': { lat: -6.20, lng: 106.85 },
    'Manila': { lat: 14.60, lng: 120.98 },
    'Taipei': { lat: 25.03, lng: 121.57 },
    'Kuala Lumpur': { lat: 3.14, lng: 101.69 },
    'Ho Chi Minh City': { lat: 10.82, lng: 106.63 },
    'Hanoi': { lat: 21.03, lng: 105.85 },
    'Dubai': { lat: 25.20, lng: 55.27 },
    'Tel Aviv': { lat: 32.09, lng: 34.78 },
    'Osaka': { lat: 34.69, lng: 135.50 },
    'Nagoya': { lat: 35.18, lng: 136.91 },
    'Fukuoka': { lat: 33.59, lng: 130.40 },
    'Busan': { lat: 35.18, lng: 129.08 },
    'Guangzhou': { lat: 23.13, lng: 113.26 },
    'Shenzhen': { lat: 22.54, lng: 114.06 },
    'Chengdu': { lat: 30.57, lng: 104.07 },
    'Hyderabad': { lat: 17.39, lng: 78.49 },
    'Chennai': { lat: 13.08, lng: 80.27 },
    'Kolkata': { lat: 22.57, lng: 88.36 },
    'Pune': { lat: 18.52, lng: 73.86 },
    'Ahmedabad': { lat: 23.02, lng: 72.57 },
    // South America
    'São Paulo': { lat: -23.55, lng: -46.63 },
    'Rio de Janeiro': { lat: -22.91, lng: -43.17 },
    'Buenos Aires': { lat: -34.60, lng: -58.38 },
    'Santiago': { lat: -33.45, lng: -70.67 },
    'Lima': { lat: -12.05, lng: -77.04 },
    'Bogotá': { lat: 4.71, lng: -74.07 },
    'Medellín': { lat: 6.25, lng: -75.56 },
    // Africa
    'Cairo': { lat: 30.04, lng: 31.24 },
    'Lagos': { lat: 6.52, lng: 3.38 },
    'Johannesburg': { lat: -26.20, lng: 28.04 },
    'Cape Town': { lat: -33.93, lng: 18.42 },
    'Nairobi': { lat: -1.29, lng: 36.82 },
    // Middle East
    'Istanbul': { lat: 41.01, lng: 28.98 },
    'Moscow': { lat: 55.76, lng: 37.62 },
    'St. Petersburg': { lat: 59.93, lng: 30.34 },
    // Canadian cities
    'Montreal': { lat: 45.50, lng: -73.57 },
    'Calgary': { lat: 51.05, lng: -114.07 },
    'Edmonton': { lat: 53.55, lng: -113.49 },
    'Ottawa': { lat: 45.42, lng: -75.70 },
};

// Country centroid coordinates for fallback
const COUNTRY_COORDS: Record<string, { lat: number; lng: number }> = {
    'United States': { lat: 37.09, lng: -95.71 },
    'Australia': { lat: -25.27, lng: 133.78 },
    'United Kingdom': { lat: 55.38, lng: -3.44 },
    'Canada': { lat: 56.13, lng: -106.35 },
    'Germany': { lat: 51.17, lng: 10.45 },
    'France': { lat: 46.23, lng: 2.21 },
    'Japan': { lat: 36.20, lng: 138.25 },
    'South Korea': { lat: 35.91, lng: 127.77 },
    'China': { lat: 35.86, lng: 104.20 },
    'India': { lat: 20.59, lng: 78.96 },
    'Brazil': { lat: -14.24, lng: -51.93 },
    'Mexico': { lat: 23.63, lng: -102.55 },
    'Russia': { lat: 61.52, lng: 105.32 },
    'Spain': { lat: 40.46, lng: -3.75 },
    'Italy': { lat: 41.87, lng: 12.57 },
    'Netherlands': { lat: 52.13, lng: 5.29 },
    'Sweden': { lat: 60.13, lng: 18.64 },
    'Norway': { lat: 60.47, lng: 8.47 },
    'Finland': { lat: 61.92, lng: 25.75 },
    'Denmark': { lat: 56.26, lng: 9.50 },
    'Poland': { lat: 51.92, lng: 19.15 },
    'Turkey': { lat: 38.96, lng: 35.24 },
    'Indonesia': { lat: -0.79, lng: 113.92 },
    'Philippines': { lat: 12.88, lng: 121.77 },
    'Thailand': { lat: 15.87, lng: 100.99 },
    'Vietnam': { lat: 14.06, lng: 108.28 },
    'Malaysia': { lat: 4.21, lng: 101.98 },
    'Singapore': { lat: 1.35, lng: 103.82 },
    'New Zealand': { lat: -40.90, lng: 174.89 },
    'Argentina': { lat: -38.42, lng: -63.62 },
    'Chile': { lat: -35.68, lng: -71.54 },
    'Colombia': { lat: 4.57, lng: -74.30 },
    'Peru': { lat: -9.19, lng: -75.02 },
    'South Africa': { lat: -30.56, lng: 22.94 },
    'Egypt': { lat: 26.82, lng: 30.80 },
    'Nigeria': { lat: 9.08, lng: 8.68 },
    'Kenya': { lat: -0.02, lng: 37.91 },
    'Saudi Arabia': { lat: 23.89, lng: 45.08 },
    'United Arab Emirates': { lat: 23.42, lng: 53.85 },
    'Israel': { lat: 31.05, lng: 34.85 },
    'Ireland': { lat: 53.14, lng: -7.69 },
    'Switzerland': { lat: 46.82, lng: 8.23 },
    'Austria': { lat: 47.52, lng: 14.55 },
    'Belgium': { lat: 50.50, lng: 4.47 },
    'Portugal': { lat: 39.40, lng: -8.22 },
    'Greece': { lat: 39.07, lng: 21.82 },
    'Czech Republic': { lat: 49.82, lng: 15.47 },
    'Romania': { lat: 45.94, lng: 24.97 },
    'Ukraine': { lat: 48.38, lng: 31.17 },
    'Pakistan': { lat: 30.38, lng: 69.35 },
    'Bangladesh': { lat: 23.68, lng: 90.36 },
    'Taiwan': { lat: 23.70, lng: 120.96 },
    'Hong Kong': { lat: 22.32, lng: 114.17 },
};

// Custom CSS for pulsing animation
const pulseAnimation = `
    @keyframes pulse-ring {
        0% {
            transform: scale(0.8);
            opacity: 1;
        }
        100% {
            transform: scale(2.5);
            opacity: 0;
        }
    }
    .pulse-marker {
        position: relative;
    }
    .pulse-marker::before {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: rgba(59, 130, 246, 0.5);
        animation: pulse-ring 2s cubic-bezier(0.455, 0.03, 0.515, 0.955) infinite;
    }
`;

// Pulsing dot marker component
function PulsingMarker({ position, users, maxUsers, city, country }: {
    position: [number, number];
    users: number;
    maxUsers: number;
    city: string;
    country: string;
}) {
    const map = useMap();
    const [zoom, setZoom] = useState(map.getZoom());

    useEffect(() => {
        const handleZoom = () => setZoom(map.getZoom());
        map.on('zoomend', handleZoom);
        return () => { map.off('zoomend', handleZoom); };
    }, [map]);

    // Scale dot size based on zoom level - smaller when zoomed out
    const baseSize = Math.max(4, (users / maxUsers) * 8 + 4);
    const zoomFactor = Math.max(0.5, (zoom - 2) / 8);
    const size = Math.min(baseSize * zoomFactor, 12);

    // Create custom div icon with pulsing effect
    const icon = L.divIcon({
        className: 'custom-pulse-marker',
        html: `
            <div style="position: relative; width: ${size * 2}px; height: ${size * 2}px; display: flex; align-items: center; justify-content: center;">
                <!-- Outer pulse ring -->
                <div style="
                    position: absolute;
                    width: ${size * 2}px;
                    height: ${size * 2}px;
                    border-radius: 50%;
                    background: rgba(139, 92, 246, 0.4);
                    animation: pulse-ring 2s cubic-bezier(0.455, 0.03, 0.515, 0.955) infinite;
                "></div>
                <!-- Glow ring -->
                <div style="
                    position: absolute;
                    width: ${size * 1.6}px;
                    height: ${size * 1.6}px;
                    border-radius: 50%;
                    background: rgba(139, 92, 246, 0.3);
                    box-shadow: 0 0 ${size}px rgba(139, 92, 246, 0.6);
                "></div>
                <!-- Main dot -->
                <div style="
                    width: ${size}px;
                    height: ${size}px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #8B5CF6, #3B82F6);
                    box-shadow: 0 0 ${size * 0.8}px rgba(139, 92, 246, 0.8), inset 0 0 ${size * 0.3}px rgba(255,255,255,0.3);
                    border: 1px solid rgba(255,255,255,0.3);
                "></div>
            </div>
        `,
        iconSize: [size * 2, size * 2],
        iconAnchor: [size, size],
    });

    return (
        <Marker position={position} icon={icon}>
            <Popup>
                <div className="text-gray-900 font-medium min-w-[140px]">
                    <div className="text-base font-bold text-purple-700">{city}</div>
                    <div className="text-sm text-gray-500">{country}</div>
                    <div className="flex items-center gap-1 mt-2 text-blue-600 font-bold">
                        <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                        {users} active user{users !== 1 ? 's' : ''}
                    </div>
                </div>
            </Popup>
        </Marker>
    );
}

export default function InteractiveWorldMap({ usersByCity, activeUsers }: InteractiveWorldMapProps) {
    const [isMounted, setIsMounted] = useState(false);

    // Only render map on client side
    useEffect(() => {
        setIsMounted(true);

        // Inject pulse animation CSS
        const style = document.createElement('style');
        style.textContent = pulseAnimation;
        document.head.appendChild(style);

        return () => {
            document.head.removeChild(style);
        };
    }, []);

    // Get coordinates for all users
    const userLocations = usersByCity.map(userData => {
        let coords = CITY_COORDS[userData.city];
        if (!coords) {
            coords = COUNTRY_COORDS[userData.country];
        }
        if (!coords) {
            return null;
        }
        return {
            ...userData,
            lat: coords.lat,
            lng: coords.lng,
        };
    }).filter((loc): loc is NonNullable<typeof loc> => loc !== null);

    const maxUsers = Math.max(...userLocations.map(u => u.users), 1);

    if (!isMounted) {
        return (
            <div className="w-full h-[450px] bg-gray-900 rounded-lg flex items-center justify-center border border-gray-700/50">
                <div className="text-gray-400 flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-purple-500/50 animate-pulse"></div>
                    Loading map...
                </div>
            </div>
        );
    }

    return (
        <div className="relative w-full h-[450px] rounded-lg overflow-hidden border border-gray-700/30">
            <MapContainer
                center={[20, 0]}
                zoom={2}
                minZoom={2}
                maxZoom={18}
                style={{ height: "100%", width: "100%", background: "#1a1a2e" }}
                className="rounded-lg"
                scrollWheelZoom={true}
                doubleClickZoom={true}
                dragging={true}
            >
                {/* Dark theme tile layer - darker variant for better contrast */}
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                />

                {/* Pulsing user location markers */}
                {userLocations.map((userData, index) => (
                    <PulsingMarker
                        key={`${userData.city}-${userData.country}-${index}`}
                        position={[userData.lat, userData.lng]}
                        users={userData.users}
                        maxUsers={maxUsers}
                        city={userData.city}
                        country={userData.country}
                    />
                ))}
            </MapContainer>

            {/* Active Users Overlay - Purple/Blue gradient to match theme */}
            {activeUsers !== undefined && (
                <div className="absolute bottom-4 left-4 z-[1000] bg-gradient-to-br from-purple-900/90 to-blue-900/80 backdrop-blur-sm border border-purple-500/40 rounded-xl px-5 py-3 shadow-xl pointer-events-none">
                    <p className="text-xs font-medium text-purple-300 mb-0.5 tracking-wide">USERS RIGHT NOW</p>
                    <p className="text-4xl font-bold bg-gradient-to-r from-purple-300 to-blue-300 bg-clip-text text-transparent">{activeUsers}</p>
                    <p className="text-[10px] text-purple-400 mt-0.5">Active in the last 30 min</p>
                </div>
            )}

            {/* Zoom hint */}
            <div className="absolute bottom-4 right-4 z-[1000] text-xs text-gray-400 opacity-60 pointer-events-none bg-gray-900/70 px-2 py-1 rounded border border-gray-700/50">
                🔍 Scroll to zoom
            </div>

            {/* No users message */}
            {userLocations.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center z-[1000] pointer-events-none">
                    <div className="bg-gray-900/90 backdrop-blur-sm rounded-xl px-6 py-4 text-gray-400 border border-gray-700/50">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-gray-600"></div>
                            No active users right now
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
