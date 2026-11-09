import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import { ABAPError, RFCError } from "../src/client/rfc-errors.js";
import { Client } from "../src/compat/node-rfc-client.js";
import { CpicTag, type CpicField } from "../src/protocol/cpic.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";
import { generationBoundConsumer } from "./support/generation-bound-consumer.js";

function text(tag: number, value: string): CpicField {
  return { tag, value: Buffer.from(value, "utf16le") };
}

function end(): CpicField {
  return { tag: CpicTag.End, value: Buffer.alloc(0) };
}

function emptyFunctionMetadata(): readonly CpicField[] {
  return [
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
    {
      tag: CpicTag.ParameterName,
      value: Buffer.from("REMOTE_BASXML_SUPPORTED", "utf16le"),
    },
    { tag: CpicTag.ParameterValue, value: Buffer.from(" ", "utf16le") },
    {
      tag: CpicTag.ParameterName,
      value: Buffer.from("REMOTE_CALL", "utf16le"),
    },
    { tag: CpicTag.ParameterValue, value: Buffer.from("R", "utf16le") },
    {
      tag: CpicTag.ParameterName,
      value: Buffer.from("UPDATE_TASK", "utf16le"),
    },
    { tag: CpicTag.ParameterValue, value: Buffer.from(" ", "utf16le") },
    { tag: CpicTag.TableName, value: Buffer.from("PARAMS", "utf16le") },
    {
      tag: CpicTag.TableHeader,
      value: Buffer.from("0000019400000000", "hex"),
    },
    {
      tag: CpicTag.TableName,
      value: Buffer.from("RESUMABLE_EXCEPTIONS", "utf16le"),
    },
    {
      tag: CpicTag.TableHeader,
      value: Buffer.from("0000003e00000000", "hex"),
    },
    end(),
  ];
}

function clientFor(
  peer: ScriptedRfcPeer,
  diagnostics?: { readonly emit: (input: unknown) => boolean },
): Client {
  return new Client({
    ashost: "application.example.test",
    gwhost: "127.0.0.1",
    gwserv: `${peer.port}`,
    sysnr: "00",
    client: "001",
    user: "RFCUSR",
    passwd: ["not-a-real", "password"].join("-"),
  }, diagnostics === undefined ? undefined : { diagnostics });
}

async function rejectedCall(client: Client): Promise<RFCError> {
  try {
    await client.call("Z_ERROR_CASE", {});
  } catch (error) {
    assert.equal(error instanceof RFCError, true);
    return error as RFCError;
  }
  assert.fail("expected the RFC call to reject");
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

test("compat Client maps rejected and malformed initial logon exactly", async (t) => {
  const cases = [
    {
      name: "rejected",
      script: { logonStatus: 7 },
      group: 3,
      code: 2,
      codeString: "RFC_LOGON_FAILURE",
      key: "RFC_LOGON_FAILURE",
      message: "SAP rejected the initial CPIC logon with status 7",
    },
    {
      name: "malformed",
      script: { logonResponse: Buffer.from("00", "hex") },
      group: 5,
      code: 11,
      codeString: "RFC_INVALID_PROTOCOL",
      key: "RFC_INVALID_PROTOCOL",
      message: "CPIC RFC logon response is malformed",
    },
  ] as const;

  for (const current of cases) {
    const peer = await ScriptedRfcPeer.start([current.script]);
    t.after(() => peer.close());
    const client = clientFor(peer);
    await assert.rejects(
      client.open() as Promise<Client>,
      (error: unknown) =>
        error instanceof RFCError &&
        error.name === "RfcLibError" &&
        error.group === current.group &&
        error.code === current.code &&
        error.codeString === current.codeString &&
        error.key === current.key &&
        error.message === current.message,
      current.name,
    );
    assert.equal(client.alive, false, current.name);
    assert.equal(client.connectionHandle, 0, current.name);
  }
});

test("compat Client keeps a declared exception on the same generation", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [
      {
        kind: "fields",
        fields: [
          text(CpicTag.AbapMessageClass, "SR"),
          text(CpicTag.AbapMessageType, "E"),
          text(CpicTag.AbapMessageNumber, "006"),
          text(CpicTag.AbapMessageV1, "Method = 1"),
          text(CpicTag.AbapExceptionKey, "RAISE_EXCEPTION"),
          end(),
        ],
      },
      {
        kind: "fields",
        fields: [
          { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
          { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
          { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
          { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
          end(),
        ],
      },
    ],
  }]);
  t.after(() => peer.close());
  const client = clientFor(peer);
  await client.open() as Client;
  const handle = client.connectionHandle;

  await assert.rejects(
    client.ping() as Promise<boolean>,
    (error: unknown) =>
      error instanceof ABAPError &&
      error.code === 5 &&
      error.key === "RAISE_EXCEPTION" &&
      error.abapMsgV1 === "Method = 1",
  );
  assert.equal(client.alive, true);
  assert.equal(client.connectionHandle, handle);
  assert.equal(await client.ping() as boolean, true);
  assert.equal(peer.connectionCount, 1);
  await client.close() as void;
});

test("compat Client replaces fatal runtime, MESSAGE, and malformed generations", async (t) => {
  const cases = [
    {
      name: "runtime",
      fields: [
        text(CpicTag.AbapErrorMessage, "Runtime text"),
        text(CpicTag.AbapT100Text, "Runtime &1"),
        text(CpicTag.AbapRuntimeId, "RUNTIME_ID"),
        text(CpicTag.AbapMessageClass, "ZM"),
        text(CpicTag.AbapMessageType, "X"),
        text(CpicTag.AbapMessageNumber, "042"),
        text(CpicTag.AbapMessageV1, "one"),
        text(CpicTag.AbapMessageV2, "two"),
        text(CpicTag.AbapMessageV3, "three"),
        text(CpicTag.AbapMessageV4, "four"),
        text(CpicTag.AbapCallStack, "PRIVATE_RUNTIME_STACK"),
        end(),
      ],
      code: 3,
      key: "RUNTIME_ID",
      message: "Runtime text",
      abap: true,
      expectedAbap: ["ZM", "X", "042", "one", "two", "three", "four"],
      disposition: "close",
    },
    {
      name: "MESSAGE E",
      fields: [
        text(CpicTag.AbapErrorMessage, "Rendered E"),
        text(CpicTag.AbapT100Text, "Message E &1"),
        text(CpicTag.AbapMessageClass, "ZZ"),
        text(CpicTag.AbapMessageType, "E"),
        text(CpicTag.AbapMessageNumber, "123"),
        text(CpicTag.AbapMessageV1, "one-E"),
        text(CpicTag.AbapMessageV2, "two-E"),
        text(CpicTag.AbapMessageV3, "three-E"),
        text(CpicTag.AbapMessageV4, "four-E"),
        text(CpicTag.AbapCallStack, "PRIVATE_MESSAGE_E_STACK"),
        end(),
      ],
      code: 4,
      key: "Message E &1",
      message: "Rendered E",
      abap: true,
      expectedAbap: [
        "ZZ", "E", "123", "one-E", "two-E", "three-E", "four-E",
      ],
      disposition: "close",
    },
    {
      name: "MESSAGE A",
      fields: [
        text(CpicTag.AbapErrorMessage, "Rendered A"),
        text(CpicTag.AbapT100Text, "Message A &1"),
        text(CpicTag.AbapMessageClass, "ZZ"),
        text(CpicTag.AbapMessageType, "A"),
        text(CpicTag.AbapMessageNumber, "123"),
        text(CpicTag.AbapMessageV1, "one-A"),
        text(CpicTag.AbapMessageV2, "two-A"),
        text(CpicTag.AbapMessageV3, "three-A"),
        text(CpicTag.AbapMessageV4, "four-A"),
        text(CpicTag.AbapCallStack, "PRIVATE_MESSAGE_A_STACK"),
        end(),
      ],
      code: 4,
      key: "Message A &1",
      message: "Rendered A",
      abap: true,
      expectedAbap: [
        "ZZ", "A", "123", "one-A", "two-A", "three-A", "four-A",
      ],
      disposition: "close",
    },
    {
      name: "MESSAGE X",
      fields: [
        text(CpicTag.AbapErrorMessage, "Rendered X"),
        text(CpicTag.AbapT100Text, "Message X &1"),
        text(CpicTag.AbapMessageClass, "ZZ"),
        text(CpicTag.AbapMessageType, "X"),
        text(CpicTag.AbapMessageNumber, "123"),
        text(CpicTag.AbapMessageV1, "one-X"),
        text(CpicTag.AbapMessageV2, "two-X"),
        text(CpicTag.AbapMessageV3, "three-X"),
        text(CpicTag.AbapMessageV4, "four-X"),
        text(CpicTag.AbapCallStack, "PRIVATE_MESSAGE_X_STACK"),
        end(),
      ],
      code: 4,
      key: "Message X &1",
      message: "Rendered X",
      abap: true,
      expectedAbap: [
        "ZZ", "X", "123", "one-X", "two-X", "three-X", "four-X",
      ],
      disposition: "close",
    },
    {
      name: "malformed",
      fields: [
        { tag: 0x7777, value: Buffer.alloc(0) },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        end(),
      ],
      code: 11,
      key: "RFC_INVALID_PROTOCOL",
      message: "CPIC RFC response is malformed",
      abap: false,
      expectedAbap: undefined,
      disposition: "unknownClose",
    },
  ] as const;

  for (const current of cases) {
    const peer = await ScriptedRfcPeer.start([
      {
        connectionIndex: 7,
        replies: [{
          kind: "fields",
          fields: current.fields,
          ...(current.name === "malformed"
            ? {}
            : { appcReturnCode: 18, isFinal: false }),
        }],
      },
      {
        connectionIndex: 7,
        replies: [{ kind: "fields", fields: emptyFunctionMetadata() }],
      },
      { connectionIndex: 7, replies: [] },
    ]);
    t.after(() => peer.close());
    const diagnosticEvents: unknown[] = [];
    const client = clientFor(peer, {
      emit(input) {
        diagnosticEvents.push(input);
        return true;
      },
    });
    await client.open() as Client;
    const oldHandle = client.connectionHandle;
    const error = await rejectedCall(client);
    assert.equal(error.code, current.code, current.name);
    assert.equal(error.key, current.key, current.name);
    assert.equal(error.message, current.message, current.name);
    assert.equal(error instanceof ABAPError, current.abap, current.name);
    if (current.expectedAbap !== undefined) {
      const abap = error as ABAPError;
      assert.deepEqual(
        [abap.abapMsgClass, abap.abapMsgType, abap.abapMsgNumber,
          abap.abapMsgV1, abap.abapMsgV2, abap.abapMsgV3, abap.abapMsgV4],
        current.expectedAbap,
        current.name,
      );
    }
    assert.equal(client.alive, true, current.name);
    assert.notEqual(client.connectionHandle, oldHandle, current.name);
    assert.equal(peer.connectionCount, 3, current.name);
    assert.equal(peer.regularRequestCount(2), 0, `${current.name} replay`);
    await nextTurn();
    assert.deepEqual(
      diagnosticEvents
        .filter((event) =>
          (event as { readonly code?: unknown }).code === "lifecycle.replaced")
        .map((event) => (event as { readonly disposition?: unknown }).disposition),
      [current.disposition],
      `${current.name} diagnostic disposition`,
    );
    await client.close() as void;
  }
});

test("compat Client replaces a terminal declared-exception generation", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    {
      connectionIndex: 7,
      replies: [{
        kind: "fields",
        fields: [
          text(CpicTag.AbapMessageClass, "SR"),
          text(CpicTag.AbapMessageType, "E"),
          text(CpicTag.AbapMessageNumber, "006"),
          text(CpicTag.AbapExceptionKey, "RAISE_EXCEPTION"),
          end(),
        ],
        appcReturnCode: 18,
        isFinal: false,
      }],
    },
    {
      connectionIndex: 7,
      replies: [{ kind: "fields", fields: successfulRegularFields() }],
    },
  ]);
  t.after(() => peer.close());
  const client = clientFor(peer);
  await client.open() as Client;
  const terminalHandle = client.connectionHandle;

  await assert.rejects(
    client.ping() as Promise<boolean>,
    (error: unknown) =>
      error instanceof ABAPError &&
      error.code === 5 &&
      error.key === "RAISE_EXCEPTION",
  );
  assert.equal(client.alive, true);
  assert.notEqual(client.connectionHandle, terminalHandle);
  assert.equal(await client.ping() as boolean, true);
  assert.equal(peer.connectionCount, 2);
  await client.close() as void;
});

test("replacement authentication failure preserves the original call error and settles once", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    {
      replies: [{
        kind: "fields",
        fields: [
          text(CpicTag.AbapErrorMessage, "Original runtime text"),
          text(CpicTag.AbapRuntimeId, "ORIGINAL_RUNTIME"),
          end(),
        ],
      }],
    },
    {
      replies: [{ kind: "fields", fields: emptyFunctionMetadata() }],
    },
    { logonStatus: 7 },
  ]);
  t.after(() => peer.close());
  const client = clientFor(peer);
  await client.open() as Client;

  let callbackCount = 0;
  const error = await new Promise<unknown>((resolve) => {
    client.invoke("Z_ORIGINAL_FAILURE", {}, (received) => {
      callbackCount += 1;
      resolve(received);
    });
  });
  await nextTurn();

  assert.equal(callbackCount, 1);
  assert.equal(error instanceof ABAPError, true);
  assert.deepEqual(
    {
      code: (error as ABAPError).code,
      codeString: (error as ABAPError).codeString,
      group: (error as ABAPError).group,
      key: (error as ABAPError).key,
      message: (error as ABAPError).message,
    },
    {
      code: 3,
      codeString: "RFC_ABAP_RUNTIME_FAILURE",
      group: 2,
      key: "ORIGINAL_RUNTIME",
      message: "Original runtime text",
    },
  );
  assert.equal(client.alive, false);
  assert.equal(client.connectionHandle, 0);
  assert.equal(peer.connectionCount, 3);
});

test("a session workflow refuses stateless clients before opening a connection", () => {
  const client = new Client({
    ashost: "application.example.invalid", sysnr: "00", client: "001",
    user: "SYNTHETIC", passwd: "synthetic-only",
  }, { stateless: true });
  assert.throws(
    () => generationBoundConsumer(client), /session workflow requires a stateful client/u,
  );
  assert.equal(client.alive, false);
  assert.equal(client.connectionHandle, 0);
});

test("a raw queued call follows replacement despite an admission-time handle check", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    { replies: [{ kind: "fields", fields: [
      text(CpicTag.AbapErrorMessage, "Workflow failure"),
      text(CpicTag.AbapRuntimeId, "WORKFLOW_FAILED"), end(),
    ] }] },
    { replies: [{ kind: "fields", fields: emptyFunctionMetadata() }] },
    { replies: [{ kind: "fields", fields: successfulRegularFields() }] },
  ]);
  t.after(() => peer.close());
  const client = clientFor(peer);
  await client.open() as Client;
  const oldHandle = client.connectionHandle;
  const first = assert.rejects(client.call("Z_SAME_SESSION", {}), ABAPError);
  assert.equal(client.connectionHandle, oldHandle);
  // This check is before dispatch: the previous call still owns the queue.
  const queued = client.call("Z_SAME_SESSION", {});
  await Promise.all([first, queued]);
  assert.notEqual(client.connectionHandle, oldHandle);
  assert.equal(peer.regularRequestCount(0), 1);
  assert.equal(peer.regularRequestCount(2), 1);
  await client.close() as void;
  await until(() => peer.activeConnectionCount === 0, "client sockets did not close");
});

test("an exclusive consumer blocks queued old-session work and invalidates verified identity", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    { connectionIndex: 7, replies: [
      { kind: "fields", fields: successfulRegularFields() },
      { kind: "fields", fields: [
        text(CpicTag.AbapErrorMessage, "Workflow failure"),
        text(CpicTag.AbapRuntimeId, "WORKFLOW_FAILED"), end(),
      ] },
    ] },
    { replies: [{ kind: "fields", fields: emptyFunctionMetadata() }] },
    { connectionIndex: 7, replies: [] },
  ]);
  t.after(() => peer.close());
  const client = clientFor(peer);
  await client.open() as Client;
  const workflow = generationBoundConsumer(client);
  const oldHandle = client.connectionHandle;
  // Stands in for an application-specific readback, not connectionInfo data.
  let verifiedIdentity: { generation: number; value: string } | undefined = {
    generation: oldHandle, value: "synthetic verified identity",
  };
  const currentIdentity = (): string | undefined => {
    if (!workflow.active || verifiedIdentity?.generation !== client.connectionHandle) {
      verifiedIdentity = undefined;
    }
    return verifiedIdentity?.value;
  };
  await workflow.call("Z_SAME_SESSION", {});
  assert.equal(client.connectionHandle, oldHandle);
  assert.equal(currentIdentity(), "synthetic verified identity");
  const failure = assert.rejects(workflow.call("Z_SAME_SESSION", {}), ABAPError);
  const followup = assert.rejects(
    workflow.call("Z_SAME_SESSION", {}), /session workflow is no longer active/u,
  );
  await Promise.all([failure, followup]);
  assert.equal(client.alive, true);
  assert.notEqual(client.connectionHandle, oldHandle);
  assert.equal(workflow.active, false);
  assert.equal(currentIdentity(), undefined);
  assert.equal(verifiedIdentity, undefined);
  assert.equal(peer.regularRequestCount(0), 2);
  assert.equal(peer.regularRequestCount(2), 0);

  const freshWorkflow = generationBoundConsumer(client);
  assert.equal(freshWorkflow.active, true);
  await client.close() as void;
  assert.equal(freshWorkflow.active, false);
  assert.equal(client.connectionHandle, 0);
  assert.equal(client.connectionInfo instanceof Error, true);
  await assert.rejects(freshWorkflow.call("Z_SAME_SESSION", {}), /no longer active/u);
  await until(() => peer.activeConnectionCount === 0, "client sockets did not close");
});

test("timeout and cancellation settle once, discard held replies, and never replay", async (t) => {
  for (const mode of ["timeout", "cancel"] as const) {
    await t.test(mode, async () => {
      const peer = await ScriptedRfcPeer.start([
        { replies: [{ kind: "held", reply: {
          kind: "fields", fields: successfulRegularFields(),
        } }] },
        { replies: [{ kind: "fields", fields: emptyFunctionMetadata() }] },
        { replies: [{ kind: "fields", fields: successfulRegularFields() }] },
      ]);
      t.after(() => peer.close());
      const client = clientFor(peer);
      await client.open() as Client;
      // Warm metadata before the deliberately short business-call deadline.
      await client.getFunctionInterface("Z_HELD_REPLY");
      const oldHandle = client.connectionHandle;
      let settlements = 0;
      const outcome = mode === "timeout"
        ? client.call("Z_HELD_REPLY", {}, { timeout: 0.5 }).then(
            () => { settlements += 1; return undefined; },
            (error: unknown) => { settlements += 1; return error; },
          )
        : new Promise<unknown>((resolve) => {
            client.invoke("Z_HELD_REPLY", {}, (error) => {
              settlements += 1;
              resolve(error);
            });
          });
      await until(() => peer.regularRequestCount(0) === 1, "business request did not arrive");
      if (mode === "cancel") await client.cancel() as void;
      assert.equal(await outcome instanceof RFCError, true);
      assert.equal(settlements, 1);
      assert.equal(client.alive, true);
      assert.notEqual(client.connectionHandle, oldHandle);
      assert.equal(peer.regularRequestCount(2), 0);
      await until(() => peer.activeConnectionCount === 2, "old socket was not retired");
      assert.equal(peer.releaseHeldReply(0), false);
      await client.call("Z_HELD_REPLY", {});
      await nextTurn();
      assert.equal(settlements, 1);
      assert.equal(peer.regularRequestCount(0), 1);
      assert.equal(peer.regularRequestCount(2), 1);
      await client.close() as void;
      await until(() => peer.activeConnectionCount === 0, "client sockets did not close");
    });
  }
});

test("close cancels an admitted call and rejects queued work without replacement", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    { replies: [{ kind: "held", reply: {
      kind: "fields", fields: successfulRegularFields(),
    } }] },
    { replies: [{ kind: "fields", fields: emptyFunctionMetadata() }] },
  ]);
  t.after(() => peer.close());
  const client = clientFor(peer);
  await client.open() as Client;
  await client.getFunctionInterface("Z_HELD_CLOSE");
  const active = assert.rejects(client.call("Z_HELD_CLOSE", {}), RFCError);
  await until(() => peer.regularRequestCount(0) === 1, "business request did not arrive");
  const queued = assert.rejects(client.call("Z_HELD_CLOSE", {}), /closed connection/u);
  await Promise.all([active, queued, client.close()]);
  assert.equal(client.alive, false);
  assert.equal(client.connectionHandle, 0);
  assert.equal(peer.connectionCount, 2);
  assert.equal(peer.regularRequestCount(0), 1);
  await until(() => peer.activeConnectionCount === 0, "client sockets did not close");
  assert.equal(peer.releaseHeldReply(0), false);
});
