/**
 * Environment detection for production-specific security settings.
 */

/**
 * Returns true if running in production environment.
 * Used to enable stricter security settings (e.g., App Check) only in prod.
 */
export const isProduction = (): boolean => {
    return process.env.GCLOUD_PROJECT === "mystic-motors-prod";
};

/**
 * Returns true if running in sandbox environment.
 */
export const isSandbox = (): boolean => {
    return process.env.GCLOUD_PROJECT === "mystic-motors-sandbox";
};
