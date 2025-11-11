// functions/test/helpers/callable.ts
import fft from "firebase-functions-test";
import { PROJECT_ID } from "../setup";

const testEnv = fft({ projectId: PROJECT_ID }); // no SA when using emulators

export function wrapCallable(fn: any) {
  const wrapped = testEnv.wrap(fn);
  const isV2Callable =
    Boolean(fn && typeof fn === "function" && fn.__endpoint?.platform === "gcfv2");

  return (input?: unknown, context?: unknown) => {
    if (isV2Callable) {
      if (context !== undefined) {
        const request =
          input && typeof input === "object" && "data" in (input as Record<string, unknown>)
            ? { ...(input as Record<string, unknown>), ...(context as Record<string, unknown>) }
            : { data: input, ...(context as Record<string, unknown>) };
        return wrapped(request);
      }
      if (input && typeof input === "object" && "data" in (input as Record<string, unknown>)) {
        return wrapped(input);
      }
      return wrapped({ data: input });
    }

    if (context !== undefined) {
      return wrapped(input, context);
    }
    if (input && typeof input === "object" && "data" in (input as Record<string, unknown>)) {
      const { data, ...ctx } = input as Record<string, unknown>;
      return wrapped(data, ctx);
    }
    return wrapped(input);
  };
}
