import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test, { type TestContext } from "node:test";

import { Client, Pool, RFCClient, RFCError } from "../src/index.js";
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

function mockLocalIdentity(t: TestContext, identity: LocalIdentity) {
  const lookups = {
    userInfo: t.mock.method(os, "userInfo", (() => ({
      username: identity.username,
      uid: 1000,
      gid: 1000,
      shell: null,
      homedir: "/home/synthetic",
    })) as typeof os.userInfo),
    hostname: t.mock.method(os, "hostname", () => identity.hostname),
  };
  syncBuiltinESMExports();
  return lookups;
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
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
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

// Explicit caller-supplied local identity (open-rfc extension). Each field
// replaces its OS lookup unconditionally; an omitted field keeps the lookup
// and its fail-closed validation.

const nonAsciiIdentity = { username: "홍길동", hostname: "홍길동-PC" } as const;

function clientParameters(peer: ScriptedRfcPeer) {
  return {
    ashost: "application.example.test",
    gwhost: "127.0.0.1",
    gwserv: `${peer.port}`,
    sysnr: "00",
    client: "001",
    user: "RFCUSR",
    passwd: "synthetic-password",
  };
}

async function startClientPeer(t: TestContext): Promise<ScriptedRfcPeer> {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  return peer;
}

test("direct session sends explicit localIdentity values without OS lookups", async (t) => {
  const { peer, partnerHost } = await startPartnerHostPeer(t);
  const sent: Buffer[] = [];
  let session: DirectCpicSession | undefined;
  try {
    const lookups = mockLocalIdentity(t, nonAsciiIdentity);
    try {
      session = await DirectCpicSession.open({
        host: "127.0.0.1",
        port: peer.port,
        applicationServerService: "sapdp00",
        transportFactory: recordingTransportFactory(sent),
        localIdentity: {
          osUser: "svc-rfc",
          hostname: "rfc-host-01.example.test",
        },
      });
      await session.logonAndPing(logon);
      assert.equal(lookups.userInfo.mock.callCount(), 0);
      assert.equal(lookups.hostname.mock.callCount(), 0);
    } finally {
      restoreLocalIdentity(t);
    }
    // The gateway logical unit is the protocol's first-8-character field of
    // the explicit host name; the CPIC logon carries the full value.
    assert.equal(decodeGatewayNormalClient(sent[0]!).logicalUnit, "rfc-host");
    const initialize = sent[1]!;
    assert.equal(
      decodeAppcInitializeParameters(initialize.subarray(
        initialize.byteLength - APPC_INITIALIZE_PARAMETERS_LENGTH,
      )).options.operatingSystemUser,
      "svc-rfc",
    );
    assert.equal(partnerHost(), "rfc-host-01.example.test");
  } finally {
    await session?.close();
  }
});

test("Client localIdentity replaces both OS lookups through the logon", async (t) => {
  const { peer, partnerHost } = await startPartnerHostPeer(t);
  const lookups = mockLocalIdentity(t, nonAsciiIdentity);
  const client = new Client(clientParameters(peer), {
    localIdentity: { osUser: "hong", hostname: "hong-pc" },
  });
  try {
    await client.open();
    assert.equal(client.alive, true);
    assert.equal(peer.connectionCount, 1);
    assert.equal(partnerHost(), "hong-pc");
    assert.equal(lookups.userInfo.mock.callCount(), 0);
    assert.equal(lookups.hostname.mock.callCount(), 0);
  } finally {
    restoreLocalIdentity(t);
    if (client.alive) await client.close();
  }
});

test("Client localIdentity.osUser skips an unavailable OS account lookup", async (t) => {
  const peer = await startClientPeer(t);
  const lookup = t.mock.method(os, "userInfo", () => {
    throw new Error("private-os-lookup-detail");
  });
  t.mock.method(os, "hostname", () => "hong-pc");
  syncBuiltinESMExports();
  const client = new Client(clientParameters(peer), {
    localIdentity: { osUser: "svc-rfc" },
  });
  try {
    await client.open();
    assert.equal(client.alive, true);
    assert.equal(peer.connectionCount, 1);
    assert.equal(lookup.mock.callCount(), 0);
  } finally {
    restoreLocalIdentity(t);
    if (client.alive) await client.close();
  }
});

for (const partial of [
  {
    name: "only an OS-user override",
    localIdentity: { osUser: "hong" },
    key: "RFC_LOCAL_HOSTNAME_UNSUPPORTED",
  },
  {
    name: "only a host-name override",
    localIdentity: { hostname: "hong-pc" },
    key: "RFC_OS_USER_UNSUPPORTED",
  },
  {
    name: "an empty override",
    localIdentity: {},
    key: "RFC_OS_USER_UNSUPPORTED",
  },
  {
    name: "explicitly undefined override fields",
    localIdentity: { osUser: undefined, hostname: undefined },
    key: "RFC_OS_USER_UNSUPPORTED",
  },
] as const) {
  test(`Client with ${partial.name} still validates the remaining OS values`, async (t) => {
    const peer = await startClientPeer(t);
    mockLocalIdentity(t, nonAsciiIdentity);
    const client = new Client(clientParameters(peer), {
      localIdentity: partial.localIdentity,
    });
    try {
      await assert.rejects(client.open() as Promise<Client>, (error: unknown) => {
        assert.ok(error instanceof RFCError, String(error));
        assert.equal(error.codeString, "RFC_ILLEGAL_STATE");
        assert.equal(error.key, partial.key);
        return true;
      });
      assert.equal(client.alive, false);
      assert.equal(peer.connectionCount, 0);
    } finally {
      restoreLocalIdentity(t);
    }
  });
}

const invalidOverrideValues = [
  { name: "an OS user with a space", value: { osUser: "hong lee" }, field: "osUser" },
  { name: "a 13-character OS user", value: { osUser: "abcdefghijklm" }, field: "osUser" },
  { name: "an empty OS user", value: { osUser: "" }, field: "osUser" },
  { name: "a non-ASCII OS user", value: { osUser: "홍길동" }, field: "osUser" },
  { name: "a non-ASCII host name", value: { hostname: "홍길동-PC" }, field: "hostname" },
  { name: "a host name with a space", value: { hostname: "my host" }, field: "hostname" },
  { name: "an empty host name", value: { hostname: "" }, field: "hostname" },
  {
    name: "a 121-character host name",
    value: { hostname: `h${"x".repeat(120)}` },
    field: "hostname",
  },
] as const;

for (const invalid of invalidOverrideValues) {
  test(`Client construction rejects ${invalid.name} in localIdentity`, async (t) => {
    const peer = await startClientPeer(t);
    const raw = Object.values(invalid.value)[0]!;
    assert.throws(
      () => new Client(clientParameters(peer), { localIdentity: invalid.value }),
      (error: unknown) => {
        assert.ok(error instanceof RangeError, String(error));
        assert.match(
          error.message,
          new RegExp(`^clientOptions\\.localIdentity\\.${invalid.field} must contain `, "u"),
        );
        if (raw.length > 0) assert.equal(error.message.includes(raw), false);
        return true;
      },
    );
    assert.equal(peer.connectionCount, 0);
  });
}

test("localIdentity shape errors fail at construction without reading accessors", async (t) => {
  const peer = await startClientPeer(t);
  const parameters = clientParameters(peer);
  assert.throws(
    () => new Client(parameters, { localIdentity: "hong" as never }),
    /^TypeError: clientOptions\.localIdentity must be a plain object$/u,
  );
  assert.throws(
    () => new Client(parameters, { localIdentity: [] as never }),
    /^TypeError: clientOptions\.localIdentity must be a plain object$/u,
  );
  assert.throws(
    () => new Client(parameters, { localIdentity: { osUser: 7 } as never }),
    /^TypeError: clientOptions\.localIdentity\.osUser must be a string$/u,
  );
  assert.throws(
    () => new Client(parameters, { localIdentity: { user: "hong" } as never }),
    /^TypeError: unknown clientOptions\.localIdentity property user$/u,
  );
  let reads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "osUser", {
    enumerable: true,
    get() {
      reads += 1;
      return "hong";
    },
  });
  assert.throws(
    () => new Client(parameters, { localIdentity: accessor }),
    /^TypeError: clientOptions\.localIdentity\.osUser must be an own data property$/u,
  );
  assert.equal(reads, 0);
  assert.equal(peer.connectionCount, 0);
});

test("Pool clientOptions.localIdentity reaches pooled sessions", async (t) => {
  const peer = await startClientPeer(t);
  mockLocalIdentity(t, nonAsciiIdentity);
  const pool = new Pool({
    connectionParameters: clientParameters(peer),
    clientOptions: { localIdentity: { osUser: "hong", hostname: "hong-pc" } },
    poolOptions: { low: 0, high: 1 },
  });
  try {
    const client = await pool.acquire() as Client;
    assert.equal(client.alive, true);
    assert.equal(peer.connectionCount, 1);
  } finally {
    restoreLocalIdentity(t);
    await pool.closeAll();
  }
});

test("RFCClient configuration localIdentity reaches its sessions", async (t) => {
  // Both OS values are unsendable. Only the explicit OS user reaches the
  // session, so the rejection moves from the user to the host-name key
  // before any connection is made.
  const peer = await startClientPeer(t);
  mockLocalIdentity(t, nonAsciiIdentity);
  const client = new RFCClient(undefined, {
    localIdentity: { osUser: "hong" },
  });
  try {
    await assert.rejects(client.open(clientParameters(peer)), (error: unknown) => {
      assert.ok(error instanceof RFCError, String(error));
      assert.equal(error.codeString, "RFC_ILLEGAL_STATE");
      assert.equal(error.key, "RFC_LOCAL_HOSTNAME_UNSUPPORTED");
      return true;
    });
    assert.equal(peer.connectionCount, 0);
  } finally {
    restoreLocalIdentity(t);
  }
});

test("RFCClient configuration rejects an invalid localIdentity", () => {
  assert.throws(
    () => new RFCClient(undefined, { localIdentity: { osUser: "hong lee" } }),
    /^RangeError: RFCClient configuration localIdentity\.osUser must contain /u,
  );
  assert.throws(
    () => new RFCClient(undefined, { localIdentity: { user: "hong" } as never }),
    /^TypeError: unknown RFCClient configuration localIdentity property user$/u,
  );
});
