import type express from "express";
import { onRequest } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";

/**
 * The consolidated service, deployed as a single Firebase Function.
 *
 * Functions v2 runs on Cloud Run, so one `onRequest` function holding two warm
 * instances is the same thing the migration brief describes as "one Cloud Run
 * service with min-instances=2" -- reached through the normal
 * `npm run deploy:sandbox` flow instead of gcloud.
 *
 * Every `onCall` function becomes a route on this one function, so a single warm
 * container serves all of them rather than one warm container per function.
 */

let cachedApp: express.Express | null = null;

const getApp = (): express.Express => {
  if (!cachedApp) {
    // Loaded lazily on first request: src/index.ts re-exports this function, so
    // importing the manifest at module scope would be a circular import. By the
    // time a request arrives, index.ts has finished evaluating.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { createApp } = require("./app.js") as typeof import("./app.js");
    const manifest = require("../index.js") as Record<string, unknown>;
    cachedApp = createApp(manifest);
  }
  return cachedApp;
};

/**
 * One warm instance in every environment. Cloud Run starts more automatically
 * when requests exceed what one container holds, and drops back to one when they
 * stop. Raise to 2 if a restart briefly leaving endpoints cold matters in prod.
 */
const WARM_INSTANCES = 1;

export const gameApi = onRequest(
  {
    region: REGION,
    minInstances: WARM_INSTANCES,
    memory: "512MiB",
    cpu: 1,
    concurrency: 80,
    invoker: "public",
  },
  (req, res) => {
    // Reached as `/gameApi/<callableName>` through cloudfunctions.net and as
    // `/<callableName>` through the function's own run.app host. Normalise so
    // both resolve to the same route.
    req.url = req.url.replace(/^\/gameApi(?=\/|$)/, "") || "/";
    getApp()(req, res);
  }
);
