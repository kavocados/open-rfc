import type { Client, RfcCallOptions, RfcObject } from "../../src/index.js";

/** Application example: this workflow must exclusively own an already-open Client. */
export function generationBoundConsumer(client: Client): {
  readonly active: boolean;
  call(name: string, input: RfcObject, options?: RfcCallOptions): Promise<RfcObject>;
} {
  if (client.config.clientOptions?.stateless === true) {
    throw new Error("session workflow requires a stateful client");
  }
  if (!client.alive || client.connectionHandle === 0) {
    throw new Error("session workflow requires an open client");
  }
  const generation = client.connectionHandle;
  let stopped = false;
  let tail = Promise.resolve();
  const active = (): boolean =>
    !stopped && client.alive && client.connectionHandle === generation;

  return {
    get active() { return active(); },
    call(name, input, options) {
      const pending = tail.then(async () => {
        if (!active()) {
          stopped = true;
          throw new Error("session workflow is no longer active");
        }
        try {
          return await client.call(name, input, options);
        } catch (error) {
          // Conservative application policy, including reusable/local failures.
          stopped = true;
          throw error;
        }
      });
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
}
