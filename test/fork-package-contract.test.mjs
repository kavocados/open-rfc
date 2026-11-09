import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import * as esm from "open-rfc";
import * as esmOwner from "../dist/src/compat/node-rfc-client.js";
import * as esmCodec from "../dist/src/client/classic-invocation.js";
import {
  metadata, response, compareImportEchoEnvelope,
} from "../dist/test/support/import-echo-fixture.js";

const require = createRequire(import.meta.url);
const cjs = require("open-rfc");
const cjsOwner = require("../dist/cjs/compat/node-rfc-client.js");
const cjsCodec = require("../dist/cjs/client/classic-invocation.js");

// Public consumers load only the package root. Internal seams supply identical
// synthetic metadata/results without installing the SAP SDK or contacting SAP.
for (const [loader, api, ownerModule, codec] of [
  ["ESM", esm, esmOwner, esmCodec],
  ["CommonJS", cjs, cjsOwner, cjsCodec],
]) {
  test(`${loader} package consumer keeps I echoes separate from E/C/T output`, async () => {
    const lease = Object.freeze({});
    let requests = 0;
    const owner = {
      async acquireApplication() { return lease; },
      async applicationInfo() {
        return { localAddress: "127.0.0.1", peerCodePage: "4103", peerAcceptInfo: 0,
          generationHandle: 1, connectionIndex: 1 };
      },
      async invoke(_lease, request) {
        assert.equal(request.functionName, metadata.name);
        const captured = codec.captureClassicRfcInvocation(metadata, request.parameters, request);
        codec.buildClassicRfcInvocationRequest(metadata, captured.input, new Map(), captured.options);
        requests += 1;
        return codec.decodeClassicRfcInvocationResult(metadata, response(true), new Map(), captured.options);
      },
      async releaseApplication() {},
      async retire() {},
    };
    const restore = ownerModule.bindClientDestinationOwnerFactory({ create: () => owner });
    const client = new api.Client({ ashost: "synthetic.example.test", sysnr: "00",
      client: "001", user: "SYNTHETIC", passwd: "synthetic" });
    try {
      await client.open();
      const input = { TEXT: "", NUMBER: 0, COUNT: 0, ROWS: ["one"] };
      const output = await client.call(metadata.name, input);
      assert.deepEqual(output, { RESULT: "OK", COUNT: 5, ROWS: ["row"] });
      const syntheticLegacy = { TEXT: "", NUMBER: 0, RESULT: "OK", COUNT: 5, ROWS: ["row"] };
      compareImportEchoEnvelope(input, syntheticLegacy, output);
      assert.throws(() => compareImportEchoEnvelope(input, { ...syntheticLegacy, NUMBER: 1 }, output),
        /input echo conflicts with request NUMBER/u);
      assert.equal(requests, 1);
    } finally {
      await client.close();
      restore();
    }
  });
}
