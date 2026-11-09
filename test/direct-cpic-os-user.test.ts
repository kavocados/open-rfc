import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test from "node:test";

import { Client, RFCError } from "../src/index.js";
import { DirectCpicSession } from "../src/client/direct-cpic-session.js";
import {
  RfcCoreError,
  RfcFailureCategory,
  RfcFailureOrigin,
  RfcOperationPhase,
  RfcRecoveryAction,
  RfcReplayPolicy,
  RfcTransmissionState,
} from "../src/client/rfc-failure.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";

test("OS-user lookup failure is classified before transport creation without its raw cause", async (t) => {
  let transportCalls = 0;
  const privateDetail = "private-os-user private-host private-credential";
  const lookup = t.mock.method(os, "userInfo", () => {
    throw new Error(privateDetail);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerService: "sapdp00",
      transportFactory() {
        transportCalls += 1;
        throw new Error("transport must not be entered");
      },
    }), (error: unknown) => {
      assert.ok(error instanceof RfcCoreError);
      assert.equal(error.failure.category, RfcFailureCategory.InvalidState);
      assert.equal(error.failure.origin, RfcFailureOrigin.Api);
      assert.equal(error.failure.phase, RfcOperationPhase.Connect);
      assert.equal(error.failure.transmission, RfcTransmissionState.NotStarted);
      assert.equal(error.failure.recoveryAction, RfcRecoveryAction.None);
      assert.equal(error.failure.replayPolicy, RfcReplayPolicy.Never);
      assert.equal(error.failure.reasonCode, "RFC_OS_USER_UNAVAILABLE");
      assert.equal(error.failure.key, "RFC_OS_USER_UNAVAILABLE");
      assert.equal(error.failure.codeString, "RFC_ILLEGAL_STATE");
      assert.match(error.failure.message, /passwd\/NSS entry for the runtime UID/u);
      assert.equal(error.failure.cause, undefined);
      assert.equal(error.cause, undefined);
      assert.equal(error.failure.message.includes(privateDetail), false);
      return true;
    });
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal(transportCalls, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("Client open reports the local account error and can open after the environment is corrected", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const client = new Client({
    ashost: "application.example.test",
    gwhost: "127.0.0.1",
    gwserv: `${peer.port}`,
    sysnr: "00",
    client: "001",
    user: "RFCUSR",
    passwd: "synthetic-password",
  });
  t.after(async () => { if (client.alive) await client.close(); });
  t.mock.method(os, "userInfo", () => {
    throw new Error("private-os-lookup-detail");
  });
  syncBuiltinESMExports();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(client.open() as Promise<Client>, (error: unknown) => {
        assert.ok(error instanceof RFCError);
        assert.equal(error.name, "RfcLibError");
        assert.equal(error.codeString, "RFC_ILLEGAL_STATE");
        assert.equal(error.key, "RFC_OS_USER_UNAVAILABLE");
        assert.match(error.message, /local operating-system user/u);
        assert.equal(error.message.includes("private-os-lookup-detail"), false);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(client.alive, false);
      assert.equal(client.connectionHandle, 0);
      assert.equal(peer.connectionCount, 0);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  await client.open();
  assert.equal(client.alive, true);
  assert.equal(peer.connectionCount, 1);
  await client.close();
  assert.equal(client.alive, false);
  assert.equal(client.connectionHandle, 0);
});
