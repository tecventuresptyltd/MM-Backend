import type { HttpsFunction } from "firebase-functions/v2/https";

/**
 * firebase-functions attaches `__endpoint` to every deployable it creates. The
 * trigger key tells us how the function is invoked; `callableTrigger` is present
 * only on functions built with `onCall`.
 */
type Deployable = HttpsFunction & {
  __endpoint?: {
    callableTrigger?: unknown;
    minInstances?: unknown;
  };
};

export type CallableRoute = {
  name: string;
  handler: HttpsFunction;
  /** True when this function currently reserves a warm instance in production. */
  warmInProd: boolean;
};

/**
 * Collects every `onCall` function exported from the deploy manifest so the
 * router can serve it as a route.
 *
 * Only callables are registered. `onRequest`, `onSchedule` and
 * `onTaskDispatched` functions keep their own deployments: they rely on Cloud
 * Run IAM or a Cloud Scheduler/Tasks OIDC identity rather than on App Check, so
 * exposing them on this shared service would drop that protection.
 */
export const discoverCallables = (
  mod: Record<string, unknown>
): Map<string, CallableRoute> => {
  const routes = new Map<string, CallableRoute>();

  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;

    const endpoint = (value as Deployable).__endpoint;
    if (!endpoint?.callableTrigger) continue;

    routes.set(name, {
      name,
      handler: value as HttpsFunction,
      warmInProd:
        typeof endpoint.minInstances === "number" && endpoint.minInstances > 0,
    });
  }

  return routes;
};
