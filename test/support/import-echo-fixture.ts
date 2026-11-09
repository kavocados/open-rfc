import assert from "node:assert/strict";

import {
  buildClassicRfcInvocationRequest,
  captureClassicRfcInvocation,
  decodeClassicRfcInvocationResult,
  type ClassicRfcInput,
  type ClassicRfcInvocationOptions,
} from "../../src/client/classic-invocation.js";
import type { RfcFunctionInterface } from "../../src/metadata/rfc-function-interface.js";
import { encodeAbapChar } from "../../src/protocol/classic-rfc.js";
import {
  CpicTag, decodeCpicFieldChainPrefix, type CpicField,
} from "../../src/protocol/cpic.js";

export const metadata: RfcFunctionInterface = {
  name: "Z_DIRECTION_FIXTURE", remoteBasxmlSupported: false, remoteCall: "R",
  updateTask: false, exceptions: [], resumableExceptionRowCount: 0,
  parameters: [
    ["I", "TEXT", "C", false], ["I", "NUMBER", "I", false],
    ["I", "OPTIONAL", "C", true], ["E", "RESULT", "C", false],
    ["C", "COUNT", "I", true], ["T", "ROWS", "C", true],
  ].map(([parameterClass, parameterName, exid, optional], index) => ({
    parameterClass: String(parameterClass), parameterName: String(parameterName),
    exid: String(exid), optional: Boolean(optional), tableName: "", fieldName: "",
    position: index + 1, offset: 0, internalLength: 4,
    decimals: 0, defaultValue: "", parameterText: "",
  })),
};

export const end: CpicField = { tag: CpicTag.End, value: Buffer.alloc(0) };

export function scalar(name: string, value: Buffer): CpicField[] {
  return [
    { tag: CpicTag.ParameterName, value: Buffer.from(name, "utf16le") },
    { tag: CpicTag.ParameterValue, value },
  ];
}

export function integer(value: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded.writeInt32LE(value);
  return encoded;
}

export function response(includeCount: boolean): CpicField[] {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(1, 4);
  return [
    ...scalar("RESULT", encodeAbapChar("OK", 4)),
    ...(includeCount ? scalar("COUNT", integer(5)) : []),
    { tag: CpicTag.TableName, value: Buffer.from("ROWS", "utf16le") },
    { tag: CpicTag.TableHeader, value: header },
    { tag: CpicTag.TableContent, value: encodeAbapChar("row", 4) }, end,
  ];
}

export function invocation(
  input: ClassicRfcInput,
  options: ClassicRfcInvocationOptions = {},
): {
  readonly fields: readonly CpicField[];
  readonly requested: readonly string[];
  readonly decode: (reply: readonly CpicField[]) => ReturnType<typeof decodeClassicRfcInvocationResult>;
} {
  const captured = captureClassicRfcInvocation(metadata, input, options);
  const bytes = buildClassicRfcInvocationRequest(
    metadata, captured.input, new Map(), captured.options,
  );
  const fields = decodeCpicFieldChainPrefix(
    bytes.subarray(4), CpicTag.ContextEnd, CpicTag.End,
  ).fields;
  return {
    fields,
    requested: fields.filter(field => field.tag === CpicTag.RequestedOutput)
      .map(field => Buffer.from(field.value).toString("utf16le")),
    decode: (reply: readonly CpicField[]) => decodeClassicRfcInvocationResult(
      metadata, reply, new Map(), captured.options,
    ),
  };
}

/** Compare a synthetic legacy envelope; this is not evidence of a node-rfc run. */
export function compareImportEchoEnvelope(
  explicitInput: Readonly<Record<string, unknown>>,
  legacyEnvelope: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): void {
  const projected = { ...legacyEnvelope };
  for (const parameter of metadata.parameters) {
    if (parameter.parameterClass !== "I") continue;
    const name = parameter.parameterName;
    if (!Object.hasOwn(projected, name)) continue;
    assert.ok(Object.hasOwn(explicitInput, name), `cannot verify omitted input echo ${name}`);
    assert.deepEqual(projected[name], explicitInput[name], `input echo conflicts with request ${name}`);
    delete projected[name];
  }
  // Unknown keys, missing E/C/T and changed E/C/T values remain observable.
  assert.deepEqual(projected, output);
}
