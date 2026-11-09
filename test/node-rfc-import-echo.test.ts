import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "../src/index.js";
import { bindClientDestinationOwnerFactory } from "../src/compat/node-rfc-client.js";
import type {
  DirectDestinationApplicationLease,
  DirectDestinationInvocation,
  DirectDestinationOwner,
} from "../src/destination/direct-destination-owner.js";
import { encodeAbapChar } from "../src/protocol/classic-rfc.js";
import { CpicTag } from "../src/protocol/cpic.js";
import {
  metadata, end, scalar, integer, response, invocation, compareImportEchoEnvelope,
} from "./support/import-echo-fixture.js";

// Consumer projection only: an explicit IMPORT-only snapshot plus RFC output.
// This never fabricates a wire response or overwrites an E/C/T result.
function withInputEcho(
  inputEcho: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  for (const name of Object.keys(inputEcho)) {
    if (Object.hasOwn(output, name)) throw new Error(`input echo collides with output ${name}`);
  }
  return { ...inputEcho, ...output };
}

test("I/E/C/T request and result distinguish explicit inputs from output", () => {
  const call = invocation({ TEXT: "", NUMBER: 0, OPTIONAL: "", COUNT: 0, ROWS: ["one"] });
  assert.deepEqual(call.requested, ["RESULT", "COUNT", "ROWS"]);
  const inputNames = call.fields.filter(field => field.tag === CpicTag.ParameterName)
    .map(field => Buffer.from(field.value).toString("utf16le"));
  assert.deepEqual(inputNames, ["TEXT", "NUMBER", "OPTIONAL", "COUNT"]);
  const values = call.fields.filter(field => field.tag === CpicTag.ParameterValue)
    .map(field => Buffer.from(field.value));
  assert.deepEqual(values, [encodeAbapChar("", 4), integer(0), encodeAbapChar("", 4), integer(0)]);
  assert.deepEqual(call.decode(response(true)), { RESULT: "OK", COUNT: 5, ROWS: ["row"] });
});

test("omitted I defaults are transmitted without invented echoes or optional C output", () => {
  const call = invocation({});
  assert.deepEqual(call.requested, ["RESULT", "ROWS"]);
  const inputNames = call.fields.filter(field => field.tag === CpicTag.ParameterName)
    .map(field => Buffer.from(field.value).toString("utf16le"));
  assert.deepEqual(inputNames, ["TEXT", "NUMBER"]);
  assert.deepEqual(call.fields.filter(field => field.tag === CpicTag.ParameterValue)
    .map(field => Buffer.from(field.value)), [encodeAbapChar("", 4), integer(0)]);
  assert.equal(call.fields.some(field => field.tag === CpicTag.TableName), false);
  assert.deepEqual(call.decode(response(false)), { RESULT: "OK", ROWS: ["row"] });
});

test("notRequested changes backend request activation and returns initial output values", () => {
  const call = invocation({ ROWS: ["one"] }, { notRequested: new Set(["RESULT", "ROWS"]) });
  assert.deepEqual(call.requested, []);
  assert.equal(call.fields.some(field => field.tag === CpicTag.TableName), false);
  assert.deepEqual(call.decode([end]), { RESULT: "", ROWS: [] });
});

test("wire input echoes, unknown fields, duplicate fields and missing outputs fail closed", () => {
  const call = invocation({ COUNT: 0 });
  for (const name of ["TEXT", "NUMBER", "OPTIONAL"]) {
    const value = name === "NUMBER" ? integer(0) : encodeAbapChar("", 4);
    assert.throws(() => call.decode([...scalar(name, value), ...response(true)]), /non-output parameter/u);
  }
  assert.throws(() => call.decode([...scalar("UNKNOWN", integer(0)), ...response(true)]), /unknown parameter/u);
  assert.throws(() => call.decode([...scalar("RESULT", encodeAbapChar("OK", 4)), ...response(true)]), /duplicate parameter/u);
  assert.throws(() => call.decode(response(false)), /lacks requested output COUNT/u);
  assert.throws(() => call.decode([end]), /lacks requested output RESULT/u);
  assert.throws(() => invocation({ UNKNOWN: 0 }), /unknown parameter/u);
});

test("synthetic legacy comparison verifies I echoes before comparing every E/C/T output", () => {
  const input = { TEXT: "", NUMBER: 0, COUNT: 0, ROWS: ["one"] };
  const output = invocation(input).decode(response(true));
  const legacyEnvelope = { TEXT: "", NUMBER: 0, RESULT: "OK", COUNT: 5, ROWS: ["row"] };
  compareImportEchoEnvelope(input, legacyEnvelope, output);
  compareImportEchoEnvelope(input, output, output);
  assert.throws(() => compareImportEchoEnvelope(input, { ...legacyEnvelope, NUMBER: 1 }, output),
    /input echo conflicts with request NUMBER/u);
  assert.throws(() => compareImportEchoEnvelope(input, { ...legacyEnvelope, TEXT: "other" }, output),
    /input echo conflicts with request TEXT/u);
  assert.throws(() => compareImportEchoEnvelope(input, { ...legacyEnvelope, OPTIONAL: "" }, output),
    /cannot verify omitted input echo OPTIONAL/u);
  assert.throws(() => compareImportEchoEnvelope(input, { ...legacyEnvelope, UNKNOWN: 0 }, output));
  assert.throws(() => compareImportEchoEnvelope(input, { ...legacyEnvelope, COUNT: 0 }, output));
  for (const name of ["RESULT", "COUNT", "ROWS"]) {
    const missing: Record<string, unknown> = { ...legacyEnvelope };
    delete missing[name];
    assert.throws(() => compareImportEchoEnvelope(input, missing, output));
  }
});

test("public Client returns E/C/T only; consumer echo preserves zero and rejects collisions", async () => {
  const lease = Object.freeze({}) as DirectDestinationApplicationLease;
  const owner = {
    async acquireApplication() { return lease; },
    async applicationInfo() {
      return { localAddress: "127.0.0.1", peerCodePage: "4103", peerAcceptInfo: 0,
        generationHandle: 1, connectionIndex: 1 };
    },
    async invoke(_lease: DirectDestinationApplicationLease, request: DirectDestinationInvocation) {
      assert.equal(request.functionName, metadata.name);
      return invocation(request.parameters, { notRequested: request.notRequested }).decode(response(true));
    },
    async releaseApplication() {},
    async retire() {},
  } as unknown as DirectDestinationOwner;
  const restore = bindClientDestinationOwnerFactory({ create: () => owner });
  const client = new Client({ ashost: "synthetic.example.test", sysnr: "00",
    client: "001", user: "SYNTHETIC", passwd: "synthetic" });
  try {
    await client.open();
    const input = { TEXT: "", NUMBER: 0, COUNT: 0, ROWS: ["one"] };
    const output = await client.call(metadata.name, input);
    assert.deepEqual(output, { RESULT: "OK", COUNT: 5, ROWS: ["row"] });
    assert.deepEqual(withInputEcho({ TEXT: input.TEXT, NUMBER: input.NUMBER }, output), {
      TEXT: "", NUMBER: 0, RESULT: "OK", COUNT: 5, ROWS: ["row"],
    });
    assert.throws(() => withInputEcho(input, output), /input echo collides with output COUNT/u);
    assert.deepEqual(input, { TEXT: "", NUMBER: 0, COUNT: 0, ROWS: ["one"] });
  } finally {
    await client.close();
    restore();
  }
});
