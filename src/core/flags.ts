/**
 * Legacy feature flags have been deprecated now that the v3 catalogs without
 * fallbacks are the only supported configuration. The helpers remain exported
 * so existing call sites continue to compile while always reflecting the new
 * canonical behaviour.
 */
export function isUnifiedSkusEnabled(): boolean {
  return true;
}

export function useItemIdV2(): boolean {
  return false;
}

/**
 * Test-only helper retained for API compatibility. No-op in the new model.
 */
export function __resetCachedFlagsForTests(): void {
  // no-op
}
