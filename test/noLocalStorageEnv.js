// Custom Jest environment that removes Node's experimental localStorage getter,
// which throws unless started with --localstorage-file. We replace it with
// an undefined placeholder so setup files can polyfill safely.
const { TestEnvironment: BaseEnvironment } = require("jest-environment-node");

class NoLocalStorageEnv extends BaseEnvironment {
  constructor(config, context) {
    // Remove the throwing getter if present.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    if (descriptor?.configurable) {
      try {
        delete globalThis.localStorage;
      } catch {
        // ignore
      }
    }
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    super(config, context);
  }
}

module.exports = NoLocalStorageEnv;
