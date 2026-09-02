import express from "express";
import * as logger from "firebase-functions/logger";
import type { Request as FunctionsRequest } from "firebase-functions/v2/https";
import { discoverCallables } from "./registry.js";

/**
 * Builds the consolidated HTTP service.
 *
 * Every `onCall` function becomes a route on one Express app, so a single warm
 * container serves all of them instead of one warm container per function.
 *
 * The handlers themselves are untouched. Each route delegates straight to the
 * function object that `onCall` returned, which is already an Express handler —
 * so App Check enforcement, ID-token verification, the `{data}`/`{result}`
 * envelopes and the `HttpsError` to HTTP status mapping all run exactly as they
 * do inside Cloud Functions today.
 */
export const createApp = (mod: Record<string, unknown>): express.Express => {
  const app = express();
  const routes = discoverCallables(mod);

  app.disable("x-powered-by");

  // Callable handlers read the parsed `req.body`; `rawBody` is preserved because
  // the firebase-functions Request type carries it and some paths expect it.
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", routes: routes.size });
  });

  app.all("/:name", (req, res, next) => {
    const route = routes.get(req.params.name);
    if (!route) return next();

    // Logs from every function now land in one Cloud Run service, so tag each
    // line with the handler name to keep per-function filtering in Cloud Logging.
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info("callable handled", {
        handler: route.name,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    // `rawBody` is the only field the firebase-functions Request type adds to
    // Express's, and the `verify` hook above populates it on every JSON body.
    return route.handler(req as unknown as FunctionsRequest, res);
  });

  app.use((_req, res) => {
    res
      .status(404)
      .json({ error: { status: "NOT_FOUND", message: "No such function." } });
  });

  return app;
};
