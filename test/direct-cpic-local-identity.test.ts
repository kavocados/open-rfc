import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test, { type TestContext } from "node:test";

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
  APPC_INITIALIZE_PARAMETERS_LENGTH,
  decodeAppcInitializeParameters,
} from "../src/protocol/appc.js";
import { CpicTag, decodeCpicFieldChainPrefix } from "../src/protocol/cpic.js";
import { decodeGatewayNormalClient } from "../src/protocol/gateway.js";
import { NiSocketTransport } from "../src/transport/ni-socket.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";

interface LocalIdentity {
  readonly username: string;
  readonly hostname: string;
}

function mockLocalIdentity(t: TestContext, identity: LocalIdentity): void {
  t.mock.method(os, "userInfo", (() => ({
    username: identity.username,
    uid: 1000,
    gid: 1000,
    shell: null,
    homedir: "/home/synthetic",
  })) as typeof os.userInfo);
  t.mock.method(os, "hostname", () => identity.hostname);
  syncBuiltinESMExports();
}

function restoreLocalIdentity(t: TestContext): void {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}

const rejectedIdentities = [
  {
    name: "Korean OS user name",
    identity: { username: "홍길동", hostname: "hong-pc" },
    raw: "홍길동",
    key: "RFC_OS_USER_UNSUPPORTED",
  },
  {
    name: "Latin-1 OS user name",
    identity: { username: "josé", hostname: "hong-pc" },
    raw: "josé",
    key: "RFC_OS_USER_UNSUPPORTED",
  },
  {
    name: "Korean host name",
    identity: { username: "hong", hostname: "홍길동-PC" },
    raw: "홍길동-PC",
    key: "RFC_LOCAL_HOSTNAME_UNSUPPORTED",
  },
  {
    // The gateway logical unit uses only the first eight characters, but the
    // CPIC logon sends the full host name after the transport is open.
    name: "host name with an ASCII gateway prefix and a non-ASCII tail",
    identity: { username: "hong", hostname: "server01-홍길동" },
    raw: "server01-홍길동",
    key: "RFC_LOCAL_HOSTNAME_UNSUPPORTED",
  },
  {
    name: "host name longer than the CPIC partner-host field",
    identity: { username: "hong", hostname: `h${"x".repeat(120)}` },
    raw: `h${"x".repeat(120)}`,
    key: "RFC_LOCAL_HOSTNAME_UNSUPPORTED",
  },
] as const;

for (const rejected of rejectedIdentities) {
  test(`direct session rejects a ${rejected.name} before transport creation`, async (t) => {
    let transportCalls = 0;
    mockLocalIdentity(t, rejected.identity);
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
        assert.ok(error instanceof RfcCoreError, String(error));
        assert.equal(error.failure.category, RfcFailureCategory.InvalidState);
        assert.equal(error.failure.origin, RfcFailureOrigin.Api);
        assert.equal(error.failure.phase, RfcOperationPhase.Connect);
        assert.equal(
          error.failure.transmission,
          RfcTransmissionState.NotStarted,
        );
        assert.equal(error.failure.recoveryAction, RfcRecoveryAction.None);
        assert.equal(error.failure.replayPolicy, RfcReplayPolicy.Never);
        assert.equal(error.failure.reasonCode, rejected.key);
        assert.equal(error.failure.key, rejected.key);
        assert.equal(error.failure.codeString, "RFC_ILLEGAL_STATE");
        assert.equal(error.failure.message.includes(rejected.raw), false);
        assert.equal(error.failure.cause, undefined);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(transportCalls, 0);
    } finally {
      restoreLocalIdentity(t);
    }
  });

  test(`Client open rejects a ${rejected.name} without connecting`, async (t) => {
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
    mockLocalIdentity(t, rejected.identity);
    try {
      await assert.rejects(client.open() as Promise<Client>, (error: unknown) => {
        assert.ok(error instanceof RFCError, String(error));
        assert.equal(error.name, "RfcLibError");
        assert.equal(error.codeString, "RFC_ILLEGAL_STATE");
        assert.equal(error.key, rejected.key);
        assert.equal(error.message.includes(rejected.raw), false);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(client.alive, false);
      assert.equal(client.connectionHandle, 0);
      assert.equal(peer.connectionCount, 0);
    } finally {
      restoreLocalIdentity(t);
    }

    await client.open();
    assert.equal(client.alive, true);
    assert.equal(peer.connectionCount, 1);
    await client.close();
    assert.equal(client.alive, false);
  });
}

test("host-name lookup failure is classified before transport creation without its raw cause", async (t) => {
  let transportCalls = 0;
  const privateDetail = "private-host-lookup-detail";
  t.mock.method(os, "hostname", () => {
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
      assert.ok(error instanceof RfcCoreError, String(error));
      assert.equal(error.failure.category, RfcFailureCategory.InvalidState);
      assert.equal(error.failure.transmission, RfcTransmissionState.NotStarted);
      assert.equal(error.failure.reasonCode, "RFC_LOCAL_HOSTNAME_UNAVAILABLE");
      assert.equal(error.failure.key, "RFC_LOCAL_HOSTNAME_UNAVAILABLE");
      assert.equal(error.failure.codeString, "RFC_ILLEGAL_STATE");
      assert.equal(error.failure.message.includes(privateDetail), false);
      assert.equal(error.failure.cause, undefined);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(transportCalls, 0);
  } finally {
    restoreLocalIdentity(t);
  }
});

const acceptedIdentities = [
  {
    name: "short ASCII names",
    identity: { username: "hong", hostname: "hong-pc" },
    operatingSystemUser: "hong",
    logicalUnit: "hong-pc",
    partnerHost: "hong-pc",
  },
  {
    // Only the first 12 user-name characters and the first 8 host-name
    // characters enter APPC/gateway records; that projection is unchanged.
    name: "long names whose wire projections are ASCII",
    identity: {
      username: "abcdefghijkl홍",
      hostname: "server-0001.example.test",
    },
    operatingSystemUser: "abcdefghijkl",
    logicalUnit: "server-0",
    partnerHost: "server-0001.example.test",
  },
] as const;

function recordingTransportFactory(sent: Buffer[]) {
  return async (
    options: Parameters<typeof NiSocketTransport.connect>[0],
    signal?: AbortSignal,
  ): Promise<NiSocketTransport> => {
    const transport = await NiSocketTransport.connect(options, signal);
    const send = transport.send.bind(transport);
    transport.send = async (payload, sendSignal) => {
      sent.push(Buffer.from(payload));
      return send(payload, sendSignal);
    };
    return transport;
  };
}

async function startPartnerHostPeer(t: TestContext): Promise<{
  readonly peer: ScriptedRfcPeer;
  readonly partnerHost: () => string | undefined;
}> {
  let partnerHost: string | undefined;
  const peer = await ScriptedRfcPeer.start([{
    inspectInitialLogon(request) {
      const field = decodeCpicFieldChainPrefix(
        request.subarray(18),
        CpicTag.Start,
        CpicTag.End,
      ).fields.find(({ tag }) => tag === CpicTag.PartnerHost);
      partnerHost = field?.value.toString("ascii");
    },
  }]);
  t.after(() => peer.close());
  return { peer, partnerHost: () => partnerHost };
}

const logon = {
  client: "001",
  user: "RFCUSR",
  password: "synthetic-password",
} as const;

for (const accepted of acceptedIdentities) {
  test(`direct session keeps wire identity values for ${accepted.name}`, async (t) => {
    const { peer, partnerHost } = await startPartnerHostPeer(t);
    const sent: Buffer[] = [];
    let session: DirectCpicSession | undefined;
    try {
      mockLocalIdentity(t, accepted.identity);
      try {
        session = await DirectCpicSession.open({
          host: "127.0.0.1",
          port: peer.port,
          applicationServerService: "sapdp00",
          transportFactory: recordingTransportFactory(sent),
        });
        await session.logonAndPing(logon);
      } finally {
        restoreLocalIdentity(t);
      }
      assert.equal(
        decodeGatewayNormalClient(sent[0]!).logicalUnit,
        accepted.logicalUnit,
      );
      const initialize = sent[1]!;
      assert.equal(
        decodeAppcInitializeParameters(initialize.subarray(
          initialize.byteLength - APPC_INITIALIZE_PARAMETERS_LENGTH,
        )).options.operatingSystemUser,
        accepted.operatingSystemUser,
      );
      assert.equal(partnerHost(), accepted.partnerHost);
    } finally {
      await session?.close();
    }
  });
}

test("CPIC logon reuses the host name validated before transport creation", async (t) => {
  const { peer, partnerHost } = await startPartnerHostPeer(t);
  let session: DirectCpicSession | undefined;
  try {
    mockLocalIdentity(t, { username: "hong", hostname: "hong-pc" });
    try {
      session = await DirectCpicSession.open({
        host: "127.0.0.1",
        port: peer.port,
        applicationServerService: "sapdp00",
      });
    } finally {
      restoreLocalIdentity(t);
    }
    // A later lookup would see an unsendable name; the logon must keep the
    // value that was validated before any byte reached the gateway.
    mockLocalIdentity(t, { username: "hong", hostname: "홍길동-PC" });
    try {
      await session.logonAndPing(logon);
    } finally {
      restoreLocalIdentity(t);
    }
    assert.equal(partnerHost(), "hong-pc");
  } finally {
    await session?.close();
  }
});
