# open-rfc fork 개선 작업지시서

작성일: 2026-11-08 KST  
대상: `kavocados/open-rfc`  
상태: 2026-11-09 로컬 구현·synthetic 검증 완료.
[결과와 제한](fork-improvement-results.md)을 함께 읽는다. GitHub 이슈 상태와
실제 SAP·배포·운영 준비도는 별도다.

## 목적과 읽는 순서

기존 여섯 이슈를 **다섯 작업 단계**로 수행한다. 단계는 실행 순서이고, 이슈 번호는
생성 순서다. 마지막 단계의 Identity와 IMPORT echo는 구현 대상과 완료 기준이 달라
각각 독립 이슈로 등록했다. 여섯 번째 작업 단계가 추가된 것은 아니다.

```text
1단계          2단계        3단계       4단계          5단계
#1 Session  →  #2 UID  →  #3 TABLES  →  #5 Metrics  →  #4 Identity
                                                    #6 IMPORT echo
                                                    (두 작업 병행 가능)
```

| 단계 | 작업 이슈 | 목적 | 기본 산출물 |
| --- | --- | --- | --- |
| 1 | [#1 Session replacement](https://github.com/kavocados/open-rfc/issues/1) | 실패 후 generation·후속 호출 안전 계약 확정 | 실패 matrix, consumer regression, 최소 수정 또는 계약 문서 |
| 2 | [#2 Numeric UID](https://github.com/kavocados/open-rfc/issues/2) | OS-user 조회 실패의 환경 분류와 진단 개선 | network-disabled 재현, 최소 오류 처리, container 지침 |
| 3 | [#3 TABLES EXID h](https://github.com/kavocados/open-rfc/issues/3) | 지원 제한과 실행 후 실패 의미 검증 | serializer applicability·실패 matrix, no-replay regression |
| 4 | [#5 연결 예산·telemetry](https://github.com/kavocados/open-rfc/issues/5) | 기존 관측값과 실제 resource 수 대조 | Client/Pool별 측정, 종료 수렴, 필요한 telemetry 보완 |
| 5-A | [#4 Identity 출처](https://github.com/kavocados/open-rfc/issues/4) | 설정값과 실제 관측값의 구분 | provenance 계약, generation 무효화 예제, 문서 |
| 5-B | [#6 IMPORT echo](https://github.com/kavocados/open-rfc/issues/6) | node-rfc 전환 시 입력 echo·출력 구분 | I/E/C/T 비교 fixture, migration 문서 |

처음 착수하는 구현자는 1단계의 재현부터 시작한다. 이 문서는 fork 작업의 흐름을
설명하고, 각 링크된 이슈는 해당 작업의 세부 acceptance criteria를 제공한다.
둘이 충돌하면 작업 범위를 임의로 넓히지 말고 차이와 제안한 해석을 기록한다.
이 문서는 upstream의 공식 roadmap이나 지원 범위를 변경하지 않는다.

## 공통 수행 원칙

1. [AGENTS.md](../../AGENTS.md)와 [CONTRIBUTING.md](../../CONTRIBUTING.md)를 먼저 읽는다.
2. `0.2.5`는 최초 관측 기준이다. 시작할 때 fork와 upstream의 현재 source·이슈·PR을
   확인해 이미 해결된 항목을 구분하고, 테스트한 revision과 환경을 결과에 기록한다.
3. 가장 작은 synthetic regression으로 현재 동작을 확인한 뒤 owning layer에서 수정한다.
   Consumer의 가정을 고쳐야 하는 경우와 SDK 결함을 구분한다.
4. 기존 API로 충분하면 문서·regression으로 완료할 수 있다. 여섯 이슈 모두에 새 API나
   production code 변경을 넣어야 하는 것은 아니다.
5. Pure TypeScript/JavaScript, zero runtime dependencies, package-root 공개 API 경계를
   유지한다. SAP NW RFC SDK·native addon·비공개 capture를 저장소에 넣지 않는다.
6. 불확실한 쓰기를 자동 replay하지 않는다. 전송 전 거절과 실행 후 응답 처리 실패를
   구분하며, late reply나 새 connection이 이전 호출의 성공 증거가 되지 않게 한다.
7. 첫 검증은 synthetic data·scripted peer·격리 container로 수행한다. 과거 SAP 쓰기
   승인은 재사용하지 않는다. Live 검증이 필요해지면 대상·effect·상한을 별도로 정한다.

### 병행 작업과 실제 선행 조건

- 위 순서는 기본 우선순위다. 단계 사이에 일괄적인 완료 대기나 GitHub dependency를
  추가하지 않는다. 코드 탐색과 독립 synthetic fixture 작성은 병행할 수 있다.
- 2단계 UID는 1단계와 독립적이므로 별도 branch에서 재현·수정할 수 있다.
- 3단계의 오류 처리, 4단계의 retirement 계수, 5-A의 identity 무효화가 1단계에서
  변경한 generation/lifecycle 계약을 사용한다면 해당 계약 확정과 회귀를 선행한다.
- 4단계 resource 측정은 실제 채택한 lifecycle·serializer 구현으로 수행한다.
  관련 경로가 뒤에 바뀌면 영향을 받는 측정만 다시 확인한다.
- 5-A와 5-B는 서로의 완료가 필요하지 않다. 공통 source 파일을 동시에 수정한다면
  파일 소유자를 나누거나 변경을 순서대로 통합한다.
- 다른 branch의 API 변경을 필요로 할 때만 dependency를 명시한다. 독립 패치를
  불필요한 stacked branch나 단일 대형 PR로 묶지 않는다.

## 1단계 — Classic Client session 실패 계약 (#1)

**작업:** Classic Client의 fatal error 후 replacement와 modern transaction의
terminal 상태를 분리해서 재현한다. 현재 classic consumer가 공개 handle·error 계약만으로
이전 LUW/XMI의 후속 작업을 차단할 수 있는지 먼저 확인한다.

**진입점:** [node-rfc-client.ts](../../src/compat/node-rfc-client.ts)의
`#replaceFatalLease`, [transaction-runtime.ts](../../src/lifecycle/transaction-runtime.ts).
기존 회귀는 [node-rfc-error-recovery](../../test/node-rfc-error-recovery.test.ts),
[client-boundary](../../test/node-rfc-client-boundary.test.ts),
[modern-transaction-contract](../../test/modern-transaction-contract.test.ts)에서 확인한다.

**수행 순서:**

1. Normal reply, fatal response, timeout, cancellation, queued invocation, late reply,
   replacement, close를 구분한 matrix를 작성한다.
2. 각 case의 request 수, physical generation 전이, callback/promise 결과, resource
   정리를 deterministic peer에서 관찰한다.
3. Classic consumer의 generation-bound 후속 호출 예제를 추가한다. Modern API의
   기존 pinned transaction으로 해결되는 사용 사례도 별도로 설명한다.
4. 충족되지 않는 요구가 실제로 남을 때만 `reconnect:false` 등 최소 API 변경을
   검토한다. 옵션 이름이나 구현 형태를 미리 확정하지 않는다.

**완료 기준:** 실패한 호출의 자동 replay 0회, late reply의 다른 invocation 귀속 0회,
old generation 폐기·cleanup, replacement 후 이전 session 후속 호출 차단을 확인한다.
기존 구현으로 충분하면 재현 결과와 문서만으로 종료한다.

**인계:** 채택한 generation/error 계약, consumer가 차단할 시점, 검증된 regression을
3·4·5-A 담당자에게 전달한다. Application의 business reconciliation을 SDK에 옮기지 않는다.

**주의:** Adopter의 SDK 호출 전 58초 대기 사례는 application wrapper의 deadline
통합 결함이었다. 이를 open-rfc 자체 timeout 버그로 재분류하지 않는다.

## 2단계 — Container numeric UID 진단 (#2)

**작업:** passwd entry 없는 UID의 OS-user 조회 실패를 재현하고 환경 오류를 명확히 한다.
이전 Linux/Node 26 관측과 공식 지원 환경의 재현 결과를 구분한다.

**진입점:** [direct-cpic-session.ts](../../src/client/direct-cpic-session.ts)의
`userInfo()` 사용부. [session](../../test/direct-cpic-session.test.ts)과
[session-errors](../../test/direct-cpic-session-errors.test.ts) 회귀를 활용한다.

**수행 순서:**

1. 외부 network가 차단된 container에서 정상 계정 UID와 passwd entry 없는 UID를 비교한다.
2. Scripted transport로 client open의 실패 위치와 cleanup을 재현한다.
3. 명확한 local environment 오류와 실행 조건을 제공하는 최소 변경을 구현한다.
4. 정상 OS 계정의 logon metadata가 바뀌지 않는지 검증한다.

**완료 기준:** business RFC 전송 전 환경 오류를 식별하고, 진단에 실제 사용자·host·
credential을 노출하지 않으며 pending operation과 resource가 정리된다.

**인계:** 지원되는 container 조건, 재현 명령, 정상·실패 regression, 운영 문서 변경.
`root`·`nobody` 또는 SAP logon user를 조용한 OS-user fallback으로 사용하지 않는다.
새 username 설정 API나 모든 임의 UID 지원은 이 단계의 기본 요구가 아니다.

## 3단계 — TABLES EXID h 제한 계약 (#3)

**작업:** unsupported input의 전송 전 거절과 nonempty output의 실행 후 decoding
실패를 구분하고, consumer가 이를 안전한 재시도로 오인하지 않게 한다.

**진입점:** [classic-invocation.ts](../../src/client/classic-invocation.ts),
[direct-cpic-session.ts](../../src/client/direct-cpic-session.ts),
[recursive serializer classification](../../src/values/recursive-serializer-classification.ts),
[recursive invocation 회귀](../../test/recursive-classic-xrfc-invocation.test.ts).

**수행 순서:**

1. Synthetic metadata·response로 empty/nonempty output, supplied/mandatory/activated
   input, `notRequested`, malformed reply를 구분한다.
2. 실패 시점, application request 수, connection disposition을 기록한다.
3. 기존 metadata·serializer·오류 계약으로 지원 제한을 충분히 설명하는지 확인한다.
4. 사전 거절이나 진단을 바꿀 필요가 있으면 기존 호출의 호환성 영향을 함께 검토한다.

**완료 기준:** 실행 후 decoding 실패가 SAP effect 부재나 retry-safe를 의미하지 않고,
connection retirement·no-replay가 유지된다. 필요한 output의 생략이나 partial success가 없다.

**범위 제한:** Metadata만으로 실제 output이 empty인지 예측할 수 없다.
`notRequested`는 업무상 불필요한 output에만 사용하며 backend `IS REQUESTED` 의미를
유지한다. [upstream #41](https://github.com/marianfoo/open-rfc/issues/41)과
[#44](https://github.com/marianfoo/open-rfc/pull/44)의 이미 해결된 optional omission,
empty TABLES, input guard는 재개발하지 않는다. Full decoder·basXML·범용 capability
registry는 별도 scope 결정이다.

**인계:** 지원/제한 matrix, 전송 전·후 오류의 구분, 공개 문서와 regression을 전달한다.

## 4단계 — 연결 예산과 telemetry (#5)

**작업:** 기존 `Pool.monitor()`·bounded diagnostics를 독립 socket 관측과 대조한다.
연결 누수가 존재한다고 가정하거나 새 monitoring framework를 먼저 만들지 않는다.

**진입점:** [destination owner](../../src/destination/direct-destination-owner.ts),
[pool runtime](../../src/pool/connection-pool-runtime.ts),
[classic Pool](../../src/compat/node-rfc-pool.ts),
[structured diagnostics](../../src/diagnostics/structured-diagnostics.ts).
기존 [owner](../../test/direct-destination-owner.test.ts),
[pool](../../test/connection-pool-runtime.test.ts),
[diagnostics integration](../../test/runtime-diagnostics-integration.test.ts) 회귀를 활용한다.

**수행 순서:**

1. Standalone Client와 shared Pool의 application·metadata topology를 각각 기록한다.
2. Cold/warm metadata, contention, queue timeout, reset failure, replacement,
   cancellation, shutdown을 재현한다.
3. 실제 socket·waiter 수와 기존 monitor 값을 비교해 설명되지 않는 차이를 찾는다.
4. 필요한 경우에만 기존 계수·fixed diagnostic schema 또는 운영 예제를 보강한다.

**완료 기준:** application cap과 총 physical connection 예산을 구분하고, 정해진
상한과 종료 후 resource 수렴을 확인한다. 관측에 credential·endpoint·principal·
payload를 추가하지 않는다.

**인계:** topology별 예산·측정 결과·운영 예제를 제공한다. Client당 최대 2연결이라는
관측을 모든 Pool 구성에 일반화하지 않는다. Metadata pool 공유·상한 증가는 별도 설계다.

## 5단계 — Identity·IMPORT echo 계약 (#4, #6)

두 하위 작업을 독립적으로 구현하고 검토한다. 5단계는 둘의 완료 또는 명시적인
보류 사유를 모두 확인한 뒤 정리한다.

### 5-A. connectionInfo 출처 (#4)

**진입점:** [node-rfc-client.ts](../../src/compat/node-rfc-client.ts)의
`applicationConnectionInfo`, [client-boundary 회귀](../../test/node-rfc-client-boundary.test.ts),
[API 문서](../../docs_page/api.md), [운영 문서](../../docs_page/operations.md).

1. 각 필드가 configured·transport-observed·backend-verified 중 무엇인지, 미제공과
   closed 상태가 무엇인지 표로 정리한다.
2. 공개 API와 문서의 표현을 일치시키고, 1단계의 generation 교체 시 이전 검증 결과를
   재사용하지 않는 consumer regression을 작성한다.
3. 기존 계약으로 해결되지 않는 경우에만 명시적인 identity 조회 API를 검토한다.

**완료 기준:** 설정값·빈 값을 backend 확인 결과로 표현하지 않으며, 검증 결과는
physical generation에 귀속되고 교체·close 시 무효화된다. Identity가 diagnostics에
노출되지 않는다. 모든 `open()`에 특정 RFM을 추가하거나 조회 실패를 설정값으로
대체하지 않는다. 새 API가 필요 없다면 문서·contract test로 완료한다.

### 5-B. IMPORT echo 호환성 (#6)

**진입점:** [classic-invocation.ts](../../src/client/classic-invocation.ts)의
`requestsOutput`, [node-rfc compatibility 회귀](../../test/node-rfc-compat.test.ts),
[migration 문서](../../docs_page/node-rfc.md).

1. 동일한 synthetic metadata·request의 I/E/C/T 반환 계약을 비교한다.
2. 명시/생략 input, initial CHAR·numeric 0, CHANGING·TABLES를 별도 case로 검증한다.
3. I echo를 사용하는 consumer의 migration 예제를 추가한다. 실제 consumer가 기존
   계약으로 해결할 수 없는 경우에만 opt-in projection을 별도로 설계한다.

**완료 기준:** 입력 echo와 실제 E/C/T output이 구분되고, explicit echo의 충돌과
필수 output 누락은 실패한다. Raw response를 합성·수정하지 않으며 unknown field를
무시하지 않는다. `notRequested`를 local filter로 사용하지 않고 기본 응답 shape를
묵시적으로 바꾸지 않는다.

## 검증과 인계 방식

### 환경과 실행 명령

현재 package의 기본 지원 matrix는 Ubuntu 24.04 x64 및 Node `^22.14.0 || ^24.0.0`이다.
실행할 때 [package.json](../../package.json), [status](../../docs_page/status.md),
upstream 변경을 확인한다. Node 26은 추가 호환성 결과로 기록하며 기본 matrix의
성공을 대체하거나 지원 확대를 암시하지 않는다. npm은 package의 `packageManager`를 따른다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build

# 1단계 focused test 예시. 다른 단계는 위의 실제 test 파일을 선택한다.
node --test dist/test/node-rfc-error-recovery.test.js

# Code 변경의 최종 검증
npm test
npm run lint

# API·declarations·package·loader·build output 변경 시
npm run test:surface

# 문서 변경 시
npm run docs:build
```

- 코드가 바뀐 뒤에는 다시 build해 compiled test를 실행한다. 같은 후보에 대해 이미
  통과한 검사를 이유 없이 반복하지 않고, 변경·실패·미해결 우려가 있는 범위를 재검증한다.
- 필요한 경우 `npm pack`으로 만든 후보를 격리 consumer에 설치해 ESM/CommonJS와
  package-root 공개 API를 검증한다. HiERP 운영 dependency를 바꾸지 않는다.
- `npm run docs:build`는 `docs_page/` 사이트를 검사한다. 이 작업지시서가 있는
  `docs/plans/`의 상대 링크·이슈 대응표·Markdown은 별도로 확인한다.
- 구현자가 관측한 source/fixture 성공, 실제 SAP 결과, 배포·지원 범위는 구분한다.
  실패한 과거 결과를 새 패치의 성공으로 다시 표시하지 않는다.

### 각 작업의 완료 보고

아래 항목을 PR 본문 또는 로컬 결과 문서에 남긴다. 별도 manager·registry는 만들지 않는다.

1. 단계와 이슈 번호, 검토한 source와 테스트 환경.
2. 기존 동작과 기대 계약, 최소 재현 및 변경 전후 결과.
3. 판단: 코드 수정 / 기존 계약으로 충족하여 문서·regression 보완 / 재현되지 않음 /
   별도 scope 결정 필요. 재현되지 않음을 수정 완료로 표시하지 않는다.
4. 변경 파일과 호환성·기본값·오류·resource 영향.
5. 실행한 검증 명령·결과·skip·미실행 이유. 필요한 검증이 남으면 완료로 표시하지 않는다.
6. 후속 담당자가 사용할 계약과 영향받는 테스트, 남은 제한.

새 API·기본값·지원 범위가 필요하면 작은 설계안을 먼저 기록한다. 일반적인 구현 선택까지
승인 단계로 만들지는 않는다. Commit을 만들 경우 `CONTRIBUTING.md`의 DCO sign-off를 따른다.
Upstream 이슈·PR 제출이나 release는 이 로컬 작업지시서만으로 실행하지 않는다.

## 진행 현황

2026-11-08 작성 시점에는 여섯 이슈가 모두 Open이다. 이 표는 계획의 시작 상태이며,
2026-11-09 로컬 결과를 마지막 열에 추가했다. 여섯 GitHub 이슈는 변경하지 않았다.

| 단계 | 이슈 | 시작 상태 | 완료 결과 |
| --- | --- | --- | --- |
| 1 | #1 | 착수 전 | [기존 계약·독점 stateful consumer 회귀](fork-improvement-results.md#단계별-판정) |
| 2 | #2 | 착수 전 | [OS-user 사전 확인·local 오류 수정](fork-improvement-results.md#product-및-호환성-영향) |
| 3 | #3 | 착수 전 | [전송 전/후 실패·no-replay 회귀](fork-improvement-results.md#단계별-판정) |
| 4 | #5 | 착수 전 | [연결 예산·monitor/socket 대조](fork-improvement-results.md#resource-관측) |
| 5-A | #4 | 착수 전 | [필드 출처·generation 무효화 회귀](fork-improvement-results.md#단계별-판정) |
| 5-B | #6 | 착수 전 | [IMPORT echo 비교·loader 회귀](fork-improvement-results.md#단계별-판정) |

최종 검토에서는 여섯 작업의 판정과 증거, 통합 후보의 관련 회귀, 공개 API/문서의
일치를 확인한다. 이 작업의 완료는 upstream 1.0 gate 통과나 production 활성화가 아니다.

## Roadmap 연결

| 단계 | 관련 roadmap ID |
| --- | --- |
| 1 | `roadmap.v1-02.failure-disposition-recovery`, `roadmap.v1-02.semantic-transactions`, `roadmap.v1-03.defaults-freeze` |
| 2 | `roadmap.v1-04.linux-node-consumer-matrix`, `roadmap.v1-05.operations-readiness` |
| 3 | `roadmap.v1-02.value-applicability`, `roadmap.v1-02.failure-disposition-recovery`, `roadmap.v1-02.semantic-transactions` |
| 4 | `roadmap.v1-02.pool-contention`, `roadmap.v1-04.performance-budgets`, `roadmap.v1-05.operations-readiness` |
| 5-A | `roadmap.v1-03.api-snapshot-freeze`, `roadmap.v1-03.defaults-freeze`, `roadmap.v1-04.node-rfc-adopter` |
| 5-B | `roadmap.v1-03.migration-guide`, `roadmap.v1-04.node-rfc-adopter` |

이 표는 [공식 roadmap](../../docs_page/roadmap.md)에 대한 제안의 연결이다.
새 decoder·serializer 지원은 `roadmap.v1-01.stable-support-boundary`에서 별도로 정하고,
새 projection API를 채택하는 경우에만 API freeze 범위를 추가한다.
