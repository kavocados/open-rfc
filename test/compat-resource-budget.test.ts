import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import { Client, Pool } from "../src/index.js";
import { CpicTag, encodeCpicFieldChain, type CpicField } from "../src/protocol/cpic.js";
import { ScriptedRfcPeer, successfulRegularFields } from "./support/scripted-rfc-peer.js";

function emptyMetadata(): readonly CpicField[] {
  return [
    ...successfulRegularFields().slice(0, -1),
    ...[
      ["REMOTE_BASXML_SUPPORTED", " "], ["REMOTE_CALL", "R"], ["UPDATE_TASK", " "],
    ].flatMap(([name, value]) => [
      { tag: CpicTag.ParameterName, value: Buffer.from(name!, "utf16le") },
      { tag: CpicTag.ParameterValue, value: Buffer.from(value!, "utf16le") },
    ]),
    { tag: CpicTag.TableName, value: Buffer.from("PARAMS", "utf16le") },
    { tag: CpicTag.TableHeader, value: Buffer.from("0000019400000000", "hex") },
    { tag: CpicTag.TableName, value: Buffer.from("RESUMABLE_EXCEPTIONS", "utf16le") },
    { tag: CpicTag.TableHeader, value: Buffer.from("0000003e00000000", "hex") },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
}

const success = { kind: "fields", fields: successfulRegularFields() } as const;
const metadata = { kind: "fields", fields: emptyMetadata() } as const;
const reset = { kind: "fields", fields: [
  ...successfulRegularFields().slice(0, -1),
  { tag: CpicTag.RfcServerResetDone, value: Buffer.alloc(0) },
  { tag: CpicTag.End, value: Buffer.alloc(0) },
] } as const;
const refresh = { kind: "raw", data: Buffer.concat([
  Buffer.from("010100080101010504010003", "hex"),
  encodeCpicFieldChain(CpicTag.Start, [
    { tag: CpicTag.ProtocolVersion, value: Buffer.alloc(4) },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
    ...successfulRegularFields(),
  ]),
  Buffer.from("ffff", "hex"),
]) } as const;

function parameters(peer: ScriptedRfcPeer) {
  return {
    ashost: "application.example.test", gwhost: "127.0.0.1", gwserv: `${peer.port}`,
    sysnr: "00", client: "001", user: "SYNTHETIC", passwd: "synthetic-only",
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "peer and monitor must converge");
    await nextTurn();
  }
}

function assertPoolSockets(pool: Pool, peer: ScriptedRfcPeer, expected: number): void {
  const { applicationPool: app, repositoryPool: repository } = pool.monitor();
  assert.equal(app.connections + repository.connections, expected);
  assert.equal(peer.activeConnectionCount, expected);
  assert.ok(app.connections <= app.maxConnections);
  assert.ok(repository.connections <= repository.maxConnections);
}

test("standalone Client keeps one application and one warm metadata socket", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    { replies: [success, success, { kind: "held", reply: success }] },
    { replies: [metadata] },
    { replies: [success] },
  ]);
  t.after(() => peer.close());
  const client = new Client(parameters(peer));
  t.after(async () => { if (client.alive) await client.close(); });
  await client.open();
  assert.equal(peer.activeConnectionCount, 1);
  await client.call("Z_RESOURCE", {});
  assert.equal(peer.activeConnectionCount, 2);
  await client.call("Z_RESOURCE", {});
  assert.equal(peer.regularRequestCount(1), 1, "warm lookup uses the repository cache");
  const oldHandle = client.connectionHandle;
  const pending = client.call("Z_RESOURCE", {});
  const rejected = assert.rejects(pending);
  await until(() => peer.regularRequestCount(0) === 3);
  await client.cancel();
  await rejected;
  assert.notEqual(client.connectionHandle, oldHandle);
  await until(() => peer.activeConnectionCount === 2);
  assert.equal(peer.regularRequestCount(2), 0, "canceled call is never replayed");
  assert.equal(peer.releaseHeldReply(0), false);
  await client.call("Z_RESOURCE", {});
  assert.equal(peer.regularRequestCount(1), 1);
  assert.equal(peer.regularRequestCount(2), 1);
  await client.close();
  await until(() => peer.activeConnectionCount === 0);
  // Peer acceptance/close events may lag local slot retirement during replacement.
  assert.ok(peer.peakConnectionCount <= 3);
});

test("shared Pool exposes both bounded lanes and converges after contention", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    // Two calls, then reset and the required full session-refresh ping.
    { replies: [success, success, reset, refresh] },
    { replies: [success, success, reset, refresh] },
    { replies: [{ kind: "held", reply: metadata }] },
    { replies: [{ kind: "held", reply: metadata }] },
  ]);
  t.after(() => peer.close());
  const pool = new Pool({
    connectionParameters: parameters(peer),
    poolOptions: { low: 0, high: 2 },
    resourceOptions: { maxConnections: 2, maxWaiters: 2, acquireTimeoutMs: 2_000 },
  });
  t.after(() => pool.closeAll());
  const first = await pool.acquire() as Client;
  const second = await pool.acquire() as Client;
  assertPoolSockets(pool, peer, 2);
  assert.equal(pool.monitor().repositoryPool.maxConnections, 2);
  const waiting = Promise.all([
    assert.rejects(pool.acquire() as Promise<Client>, /timed out/u),
    assert.rejects(pool.acquire() as Promise<Client>, /timed out/u),
  ]);
  await until(() => pool.monitor().applicationPool.waiting === 2);
  await assert.rejects(pool.acquire() as Promise<Client>, /waiter limit/u);
  await waiting;
  assert.equal(pool.monitor().applicationPool.waiting, 0);
  assertPoolSockets(pool, peer, 2);

  const calls = Promise.all([first.call("Z_FIRST", {}), second.call("Z_SECOND", {})]);
  await until(() => peer.regularRequestCount(2) === 1 && peer.regularRequestCount(3) === 1);
  assertPoolSockets(pool, peer, 4);
  assert.equal(pool.monitor().repositoryPool.leased, 2);
  assert.equal(peer.releaseHeldReply(2), true);
  assert.equal(peer.releaseHeldReply(3), true);
  await calls;
  await Promise.all([first.call("Z_FIRST", {}), second.call("Z_SECOND", {})]);
  assert.equal(peer.regularRequestCount(2) + peer.regularRequestCount(3), 2);
  assert.equal(pool.monitor().metadata.cacheHits >= 2, true);
  assertPoolSockets(pool, peer, 4);
  await pool.release([first, second]);
  assert.equal(pool.monitor().applicationPool.idle, 2);
  assertPoolSockets(pool, peer, 4);
  await pool.closeAll();
  await until(() => peer.activeConnectionCount === 0);
  assertPoolSockets(pool, peer, 0);
  assert.equal(pool.monitor().applicationPool.waiting, 0);
  assert.equal(pool.monitor().repositoryPool.waiting, 0);
  assert.equal(peer.peakConnectionCount, 4);
});

test("shared Pool repository capacity stops at two when application capacity grows", async () => {
  const pool = new Pool({
    connectionParameters: { ashost: "synthetic.example.test", sysnr: "00",
      client: "001", user: "SYNTHETIC", passwd: "synthetic-only" },
    poolOptions: { low: 0, high: 1 }, resourceOptions: { maxConnections: 3 },
  });
  try {
    assert.equal(pool.monitor().applicationPool.maxConnections, 3);
    assert.equal(pool.monitor().repositoryPool.maxConnections, 2);
    assert.equal(pool.monitor().applicationPool.connections, 0);
    assert.equal(pool.monitor().repositoryPool.connections, 0);
  } finally {
    await pool.closeAll();
  }
});

test("Pool reset failure retires the socket and preserves its failure counter", async (t) => {
  const peer = await ScriptedRfcPeer.start([
    { replies: [{ kind: "close" }] },
    { replies: [] },
  ]);
  t.after(() => peer.close());
  const pool = new Pool({
    connectionParameters: parameters(peer), poolOptions: { low: 0, high: 1 },
    resourceOptions: { maxConnections: 1 },
  });
  t.after(() => pool.closeAll());
  const first = await pool.acquire() as Client;
  await assert.rejects(pool.release(first) as Promise<void>);
  await until(() => peer.activeConnectionCount === 0);
  assertPoolSockets(pool, peer, 0);
  assert.equal(pool.monitor().applicationPool.resetFailures, 1);
  assert.equal(pool.monitor().repositoryPool.maxConnections, 1);
  const second = await pool.acquire() as Client;
  assert.equal(first.alive, false);
  assert.equal(second.alive, true);
  assertPoolSockets(pool, peer, 1);
  await pool.closeAll();
  await until(() => peer.activeConnectionCount === 0);
  assertPoolSockets(pool, peer, 0);
});
