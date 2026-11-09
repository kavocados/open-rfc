# Replace node-rfc

<p class="open-rfc-lead">Keep the `node-rfc` module ID at install time while moving supported client and pool calls to the SDK-free implementation.</p>

## Install under the existing module ID

For a published release, use npm's alias syntax under the dependency key your
application already imports:

```json
{
  "dependencies": {
    "node-rfc": "npm:open-rfc@{{OPEN_RFC_PACKAGE_VERSION}}"
  }
}
```

`import { Client, Pool } from "node-rfc"` and
`require("node-rfc")` can then remain unchanged. Commit the resulting lockfile
and confirm that it resolves this exact aliased artifact, not the native addon.

Application source remains unchanged:

```js
import { Client, Pool } from "node-rfc";
```

For an exact tarball received through a trusted channel, point the same
dependency key at that tarball instead:

```json
{
  "dependencies": {
    "node-rfc": "file:../artifacts/open-rfc-{{OPEN_RFC_PACKAGE_VERSION}}.tgz"
  }
}
```

Project releases use only the project-controlled `open-rfc` name; this project
cannot publish into SAP-controlled npm scopes. In either installation mode,
use the exact version and integrity from the published release record, or the
trusted digest supplied with the tarball, rather than a range or custom
dist-tag.

Verify the resolved package before testing the application:

```sh
npm explain node-rfc
npm ls node-rfc --all
node -e 'const { environment } = require("node-rfc"); if (environment.noderfc.implementation !== "open-rfc-sdk-free") process.exit(1); console.log("open-rfc-sdk-free")'
```

The dependency tree must contain one `node-rfc` installation resolved from the
exact `open-rfc` version, and the loader check must print
`open-rfc-sdk-free`. The lock entry must bind that version and its matching
integrity and must not contain the native SAP addon or an SDK installation
step. `open-rfc` is not expected as a second top-level dependency in this
alias-only installation.

## Migration checklist

Before replacing an existing installation:

1. Inventory every imported `node-rfc` export and every connection option.
2. Keep `Client` and `Pool` imports, but remove or redesign uses of `Server`,
   `Throughput`, `noderfc_binding`, `reloadIniFile`, SDK-global/INI
   configuration, SNC, SSO modes other than the documented MYSAPSSO2 preview,
   X.509, registered server mode, tRFC, qRFC, and bgRFC. They are not supplied
   by this beta. Client-side callbacks from ABAP are available only through the
   raw, synchronous `clientOptions.callbacks` preview; they are not a drop-in
   replacement for native callback handlers.
3. Use only the supported direct application-server route; message-server and
   SAProuter code is an unsupported preview, not a migration target.
4. Treat `call()` and the metadata methods as Promise-only, `invoke()` as the
   callback call form, and lifecycle/pool methods as Promise-or-callback.
5. Run the exact value, timeout, cancellation, reset, pool, and error shapes
   used by the application before deployment.

## Promise calls

`Client` accepts the familiar connection object and returns Promises when no
callback is supplied. `Client` and per-call `timeout` values are in **seconds**.
The executable examples use the preserved `node-rfc` module ID and are tested
against the exact packed artifact installed under that alias. If you chose a
source-level migration instead, change only the import to `open-rfc`.

Save the Promise and pool examples as `.mjs`, save the callback example as
`.cjs`, and run the selected file with `node <file>`.
With no connection configuration it exits non-zero and names only the missing
environment variables. Successful Promise, callback, and pool examples print
one fixed completion line and never print returned SAP values or connection
details.

<!-- open-rfc-doc-example id="pages-node-rfc-promise" runtime="esm" outcome="missing-connection" sha256="a312d6bc4f5f8c7d73524dc9ca820c07e997dba28b77540f3adc1f1054145022" -->
```js
import { Client } from "node-rfc";

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const client = new Client(
    {
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    },
    { timeout: 15 },
  );

  let opened = false;
  let failure;
  try {
    await client.open();
    opened = true;
    await client.call(
      "STFC_CONNECTION",
      { REQUTEXT: "promise call" },
      { timeout: 10 },
    );
  } catch (error) {
    failure = error;
  }

  if (opened) {
    try {
      await client.close();
    } catch (closeError) {
      failure = failure
        ? new AggregateError(
            [failure, closeError],
            "RFC operation and close both failed",
            { cause: failure },
          )
        : closeError;
    }
  }
  if (failure) {
    console.error("RFC operation failed; consult private, redacted diagnostics.");
    process.exitCode = 1;
  } else {
    console.log("RFC call completed");
  }
}
```

The Promise cleanup preserves both the operation and cleanup failures when
`close()` also rejects, but reports only a fixed public failure line.

## Callback calls

Callbacks follow the node-rfc error-first shape. `call()` is Promise-only;
`invoke()` is its callback counterpart.

<!-- open-rfc-doc-example id="pages-node-rfc-callback" runtime="cjs" outcome="missing-connection" sha256="a02f371e03767ac1381d2c4bd1fb0a69291ebc7263005332e0e11b84b4616073" -->
```js
const { Client } = require("node-rfc");

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const client = new Client(
    {
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    },
    { timeout: 15 },
  );

  const finish = (error) => {
    if (error) {
      console.error("RFC operation failed; consult private, redacted diagnostics.");
      process.exitCode = 1;
    }
  };

  client.open((openError) => {
    if (openError) return finish(openError);
    client.invoke(
      "STFC_CONNECTION",
      { REQUTEXT: "callback call" },
      (callError) => {
        client.close((closeError) => {
          const failure =
            callError && closeError
              ? new AggregateError(
                  [callError, closeError],
                  "RFC call and close both failed",
                  { cause: callError },
                )
              : callError ?? closeError;
          if (!failure) console.log("RFC callback completed");
          finish(failure);
        });
      },
      { timeout: 10 },
    );
  });
}
```

## Bounded pool

Set the application-session capacity and waiter limit explicitly.
`poolOptions.high` is the number of idle application sessions the compatibility
pool may retain; it is not the hard application capacity. Metadata lookup uses
a separate bounded repository lane, so `resourceOptions.maxConnections` is not
a total physical-session cap. That lane may add at most
`min(2, maxConnections)` physical sessions, so budget the target for up to
`maxConnections + min(2, maxConnections)` sessions per pool. Explicit
`ready(n)` can retain more application sessions than `poolOptions.high`; the
hard `maxConnections` value still applies. Resource deadlines use milliseconds,
while the client call timeout remains seconds. See the [API reference](api.md#pool)
for defaults and lifecycle details.

<!-- open-rfc-doc-example id="pages-node-rfc-pool" runtime="esm" outcome="missing-connection" sha256="b9f80d5b1ea556c5922001fe1089e60c175648c4dd648110008c8c82e4845f82" -->
```js
import { Pool } from "node-rfc";

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionParameters: {
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    },
    clientOptions: { timeout: 15 },
    poolOptions: { low: 0, high: 2 },
    resourceOptions: {
      maxConnections: 4,
      maxWaiters: 16,
      acquireTimeoutMs: 5_000,
      lifecycleTimeoutMs: 20_000,
      shutdownTimeoutMs: 30_000,
      validateOnCheckout: true,
    },
  });

  let client;
  let failure;
  try {
    client = await pool.acquire();
    await client.call("STFC_CONNECTION", { REQUTEXT: "pooled call" });
  } catch (error) {
    failure = error;
  }

  if (client) {
    try {
      await pool.release(client);
    } catch (releaseError) {
      failure = failure
        ? new AggregateError(
            [failure, releaseError],
            "RFC operation and pool release both failed",
            { cause: failure },
          )
        : releaseError;
    }
  }
  try {
    await pool.closeAll();
  } catch (closeError) {
    failure = failure
      ? new AggregateError(
          [failure, closeError],
          "RFC operation and pool shutdown both failed",
          { cause: failure },
        )
      : closeError;
  }
  if (failure) {
    console.error("RFC operation failed; consult private, redacted diagnostics.");
    process.exitCode = 1;
  } else {
    console.log("RFC pool call completed");
  }
}
```

Do not call `open()` or `close()` on a leased client. Return it with
`pool.release(client)`, and call `pool.closeAll()` during application shutdown.
If release fails, still attempt `closeAll()` and preserve both failures.

## Compatibility boundary

| Area | Current behavior |
|---|---|
| `Client` / `Pool` | Promise and callback lifecycle, invoke/call, ping, cancellation, timeout, reset, and bounded pooling are part of the supported direct-route boundary. |
| Values | Classic scalar, flat structure, structured table, STRING/XSTRING, exact decimal strings, and configurable INT8 output are supported within documented limits. Project tests exercise representative values; they do not cover every value on both selected SAP releases. |
| RFC callbacks | Client-side `DESTINATION 'BACK'` is a raw synchronous preview, bounded to 64 callbacks per outer call and not yet live-qualified by this TypeScript implementation. Registered server mode remains unsupported. |
| Unsupported options | Must fail before I/O; an option is never intentionally ignored merely to appear compatible. |
| Native SDK globals | `Server`, `Throughput`, `noderfc_binding`, INI reload, and SDK-specific global configuration are not supplied. |

## Differences to test in your application

- INT8 can project as a safe `number`, `bigint`, or `string`; select the mode
  explicitly when values can exceed JavaScript's safe integer range.
- BCD and DECF values default to precision-preserving decimal strings.
- Initial DATE/TIME values remain empty instead of becoming invented dates.
- Metadata parameter keys retain exact casing, normally uppercase.
- A timeout, cancellation, malformed reply, or uncertain send retires the
  physical connection and is never replayed automatically.

### IMPORT inputs and returned values

Parameter directions below use the function module's ABAP perspective. An
IMPORTING (`I`) value is input to the backend. open-rfc does not include an
IMPORTING echo in the call result. If your previous adapter returned that input,
keep an explicit input snapshot in your application instead of treating it as
backend output. The default result contains requested EXPORTING (`E`), active
CHANGING (`C`), and TABLES (`T`) values.

| Direction | Input behavior | Returned value |
| --- | --- | --- |
| `I` | Explicit input is sent, including `""` and numeric `0`. An omitted mandatory input gets its initial value; an omitted optional input retains the backend default. | No input echo, including for omitted or initial inputs. |
| `E` | Cannot be supplied as input. | Requested by default; a missing requested value fails the call. |
| `C` | Supplied or mandatory input is active; an omitted optional input is inactive. | The backend's value when active, which may differ from the input. |
| `T` | Input rows are sent when supplied or mandatory, within serializer limits. | Output is requested even when optional input is omitted. |

For a function whose IMPORTING parameters are `TEXT` and `NUMBER`, an existing
consumer that needs a combined view can explicitly project those inputs after a
successful call:

```ts
const input = { TEXT: "", NUMBER: 0, COUNT: 0, ROWS: ["one"] };
// COUNT and ROWS are C/T values; only the I parameters belong in this echo.
const inputEcho = { TEXT: input.TEXT, NUMBER: input.NUMBER };
const output = await client.call("Z_DIRECTION_FIXTURE", input);
for (const name of Object.keys(inputEcho)) {
  if (Object.hasOwn(output, name)) {
    throw new Error(`input echo collides with output ${name}`);
  }
}
const applicationView = { ...inputEcho, ...output };
```

This is an application view; it does not change the RFC response or prove that
the backend accepted an echoed value. Copy only explicitly supplied `I` fields
using the function's known metadata, and snapshot mutable structures or binary
values before starting the call. Do not merge all inputs: doing so can overwrite
or conceal CHANGING/TABLES outputs. Do not invent echoed values for omitted
optional inputs, whose backend defaults are not observed by this call. Avoid
truthiness checks when copying input because empty CHAR and numeric zero are
valid values.

For migration parity comparisons, keep the previous adapter's observed result
separate from this display projection. Identify `I` keys from metadata; before
removing an echoed `I` key from the comparison, require that it was explicitly
supplied and equals the original input snapshot, including `""` and `0`.
A conflicting echo fails the comparison. An echo for an omitted input needs a
separate, justified default-value contract. Then compare all remaining keys and
values exactly, preserving unknown fields and required E/C/T outputs so neither
extra fields nor missing or changed outputs can disappear during normalization.
The repository's synthetic legacy envelopes exercise this comparator rule; they
are not results from running the native node-rfc package.

An unexpected `I` field on the wire, unknown output, duplicate output, or missing
requested output fails response validation. `notRequested` changes the outgoing
request and therefore the backend's `IS REQUESTED` behavior; it is not a local
filter for constructing an echo. Suppressed E/C/T outputs have their documented
initial values, and suppressing a TABLES parameter also suppresses its input.

### TABLES parameters described by `EXID h`

The table-container descriptor `EXID h` has a narrower classic TABLES boundary
than ordinary flat table rows. Omission does not establish that the backend will
return an empty table. Serializer applicability and metadata authorization must
also succeed before the following cases apply.

| Case | Business request | Result and connection |
| --- | --- | --- |
| Supplied input, including `[]`; omitted mandatory input; explicitly activated input | Rejected before sending | Local preparation error; authenticated session remains usable. |
| Omitted optional input, empty binary output | Sent once | Returns `[]`; session remains usable. |
| Omitted optional input, nonempty binary output | Sent once | Value decoding fails after the response; physical session is retired. |
| Malformed binary output envelope | Sent once | Value decoding rejects the envelope after the response; physical session is retired. |
| Output deliberately suppressed with `notRequested` | Sent once without requesting that output | Returns the initial `[]`; input is also inactive. |

The post-send failures do not establish that SAP had no effect, and a new
connection does not make replay safe. Use `notRequested` only when the output is
unnecessary for the business operation. Do not hide a required output to turn an
unsupported call into apparent success. These contracts are covered by synthetic
direction and session tests; they do not expand the published live support matrix.

Before deploying, exercise every decimal, INT8, binary, initial temporal,
structure, table, error, cancellation, and requested-output shape used by the
application. Start with an approved read-only function on a non-production
target and keep the previous lockfile as the rollback boundary.

!!! warning "Compatibility is a boundary, not SDK parity"
    The supported client and pool surface is intentionally fail-closed. Server
    mode, SNC, SSO modes other than the documented MYSAPSSO2 preview, X.509,
    SDK globals, and other unsupported capabilities do not become available
    merely because the package is installed as `node-rfc`.
