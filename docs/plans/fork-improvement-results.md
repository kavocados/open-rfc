# Fork 개선 로컬 구현·검증 결과

검증일: 2026-11-09 KST  
기준 revision: `23bdaa851af1bec6662f70a1636848aa8ea5cd82` (`0.2.5`)  
로컬 branch: `codex/fork-contract-validation`  
대상: [작업지시서](fork-improvement-work-order.md)의 다섯 단계·여섯 이슈

## 설계 검토와 범위

현재 owning source와 여섯 이슈를 대조한 결과, 구현을 막는 설계 결함은 발견하지
못했다. 새 API를 먼저 만들지 않고 기존 계약의 회귀를 보강한다는 설계를 채택했다.
실제 product 수정은 numeric UID 환경 오류 처리 한 곳이다. 다른 단계는 기존
동작을 유지하고 테스트·문서를 보완했다.

검토 시 다음 조건을 구체화했다.

- Classic handle의 admission-time 확인은 dispatch fence가 아니다. Consumer가
  **stateful Client를 독점 소유**하고 외부 직렬 큐 안에서 검사해야 한다.
  `stateless: true`는 handle을 유지하면서 context를 reset하므로 예제에서 거절한다.
  모든 오류 뒤 해당 workflow를 끝내는 보수적인 consumer 정책을 예제에 명시했다.
- `connectionInfo`는 configured/selected route, gateway negotiation, 파생값,
  상수와 미제공 값을 구분한다. 이 객체에는 backend-verified identity가 없다.
- Pool `connections`에는 creating/closing 슬롯이 포함된다. 원격 accept/close
  이벤트와 비교할 때 phase barrier가 필요하다. Destroy가 불확실하면 기존 closing
  계수를 유지하며 shutdown 실패를 보고한다. 성공한 shutdown에서만 0 수렴을 요구한다.
- IMPORT echo 충돌 검사는 consumer의 의미 비교 규칙이다. Wire에서 I echo를
  허용하거나 기본 SDK response를 합성하는 기능을 추가하지 않는다.

조회 시 local/fork/upstream `main`은 모두 위 revision이었다. Fork
[#1](https://github.com/kavocados/open-rfc/issues/1),
[#2](https://github.com/kavocados/open-rfc/issues/2),
[#3](https://github.com/kavocados/open-rfc/issues/3),
[#4](https://github.com/kavocados/open-rfc/issues/4),
[#5](https://github.com/kavocados/open-rfc/issues/5),
[#6](https://github.com/kavocados/open-rfc/issues/6)는 Open이었다.
Upstream [#41](https://github.com/marianfoo/open-rfc/issues/41)은 완료되었고
[#44](https://github.com/marianfoo/open-rfc/pull/44)는 merge되어 현재 source에 포함되어
있다. 열린 upstream [#47](https://github.com/marianfoo/open-rfc/pull/47)과
[#49](https://github.com/marianfoo/open-rfc/pull/49)는 이 작업에 포함하지 않았다.

## 단계별 판정

| 단계 | 판정과 관측 | 주요 회귀·문서 |
|---|---|---|
| 1 / #1 | 기존 계약으로 충족. Raw queued call이 replacement로 넘어가는 반례와, 독점 consumer가 old-session 후속 요청을 전송 전에 차단하는 예제를 모두 검증했다. Fatal/timeout/cancel에서 replay 0, 원래 결과 한 번 settlement, old socket 폐기 및 close 수렴을 확인했다. | `node-rfc-error-recovery.test.ts`, `support/generation-bound-consumer.ts`, `api.md` |
| 2 / #2 | 최소 product 수정. OS user 조회를 direct transport 생성 전으로 이동하고 고정 local 오류로 분류했다. 정상 username의 12-character projection은 유지했다. | `direct-cpic-session.ts`, `direct-cpic-os-user.test.ts`, `direct-cpic-session.test.ts`, `operations.md` |
| 3 / #3 | 기존 제한 계약으로 충족. Supplied empty/nonempty, activated optional, omitted mandatory input의 request 0회와 output 처리의 request 1회를 구분했다. Nonempty/malformed output은 terminal이며 후속 ping도 거절한다. | `recursive-classic-xrfc-invocation.test.ts`, `node-rfc.md` |
| 4 / #5 | 기존 monitor로 설명 가능. 별도 telemetry API 없이 direct Client/Pool의 application/repository socket 예산, cold/warm cache, contention/overload/timeout, cancel/replacement, reset 실패와 shutdown을 검증했다. | `compat-resource-budget.test.ts`, `support/scripted-rfc-peer.ts`, `operations.md` |
| 5-A / #4 | 기존 API로 충족. 전체 connectionInfo 필드 provenance와 closed snapshot을 고정했다. Consumer identity evidence는 workflow/generation 교체·close에서 무효화한다. | `node-rfc-client-boundary.test.ts`, `node-rfc-error-recovery.test.ts`, `api.md` |
| 5-B / #6 | 기존 response shape 유지. I/E/C/T, 생략 input, empty CHAR, numeric 0, C/T 변경, notRequested를 구분했다. 명시한 I echo 불일치, unknown/duplicate/missing E/C/T를 실패시킨다. | `node-rfc-import-echo.test.ts`, `fork-package-contract.test.mjs`, `support/import-echo-fixture.ts`, `node-rfc.md` |

여기서 완료는 **로컬 source·synthetic regression 범위**다. GitHub issue의 상태나
체크박스는 변경하지 않았다. 기존 modern pinned transaction의 terminal/concurrency
계약과 pool destroy 실패의 retained-resource 회귀는 전체 suite에서 함께 검증했다.

## Product 및 호환성 영향

OS 조회 실패는 `RfcCoreError`의 `InvalidState / Api / Connect / NotStarted`로
분류되며, 공개 `RFC_ILLEGAL_STATE`, key `RFC_OS_USER_UNAVAILABLE`로 투영된다.
오류는 passwd/NSS account 조건을 설명하는 고정 문자열이며 raw cause를 저장하지
않는다. Silent username fallback, 새 username 설정, retry 또는 replay는 없다.
환경을 수정한 뒤 사용자가 명시적으로 같은 Client를 다시 open하는 경우는 검증했다.

기존 source는 gateway handshake 뒤 OS user를 조회했다. 이번 direct route는 조회
실패 시 transport factory 호출과 socket 수가 모두 0이다. Message Server 등 preview
route의 discovery가 이미 수행되었을 수 있으므로 모든 route의 zero-network 보장은 아니다.

원래 `direct-cpic-session.ts`만 복원한 격리 사본에서 새 UID 테스트 2개는 모두
실패했다(0/2, macOS arm64 Node 26 추가 환경). 수정 후보에서는 두 테스트 및 정상
logon metadata 검증이 지원 Node 22/24에서 통과했다. 초기 fixture의 CHAR 폭,
pool waiter 수, reset 뒤 full session-refresh 응답 오류는 테스트 fixture에서 수정했다.

Public export/declaration snapshot, response 기본값, package runtime dependency와
serializer 지원 범위는 유지했다. CommonJS/ESM IMPORT 계약 회귀가 빠지지 않도록
기존 `test:surface`에 새 loader test를 연결했다. 최신 지원 Node의 surface 검증에서
기존 permission fixture가 `package.json`을 일반 텍스트로 덮어쓰는 문제도 발견하여,
permission 검증을 유지하면서 유효한 JSON manifest를 쓰도록 수정했다.

## Resource 관측

| Direct topology·상태 | 관측 |
|---|---|
| Standalone open | application socket 1 |
| 첫 metadata 조회·warm 재호출 | 총 socket 2; 같은 metadata request는 1회 유지 |
| Standalone cancel/replacement | old generation request 1회, replacement replay 0; settled socket 2, close 뒤 0 |
| Pool application cap 2 | application 2 + repository 2 = settled socket/monitor 4 |
| Pool contention | waiter 2 유지, 추가 acquire 거절; timeout 뒤 waiter 0 |
| Pool warm cache | 두 function의 metadata request 합계 2회 유지 |
| Pool reset 실패 | old socket 0, resetFailures 1; 다음 명시적 acquire가 새 generation 사용 |
| Pool cap 1 / cap 3 | repository cap 각각 1 / 2; 일반식 `N + min(2, N)` |
| 성공한 shutdown | 두 pool의 connection/waiter 및 관측 socket 0 |

단일 replacement case는 원격 close-event 지연을 포함해 peer peak가 3 이하임을
검사한다. 이는 standalone의 SDK 슬롯 예산을 3으로 늘린다는 뜻이 아니다.
Pool cap 2 case의 관측 peak는 4다. 이 측정은 성능 SLA나 모든 route topology의
물리 연결 상한을 증명하지 않는다.

## 검증 환경과 결과

지원 환경은 Ubuntu 24.04 `linux/amd64` container를 Docker Desktop의 arm64 host에서
실행했다. x64 emulation 환경이며 native x64 성능 측정은 아니다. 의존성 설치와
image 준비 뒤 실제 테스트 container는 `--network none`으로 실행했다. Synthetic
peer는 container loopback만 사용한다. 지원 Node는 npm 11.19.0을 사용했다.

| 환경 | 전체 code | lint | surface | 동일 failure matrix의 CommonJS 실행 |
|---|---:|---|---:|---:|
| Ubuntu 24.04 x64, Node 22.23.4 | 1,039 pass / 0 fail / 0 skip | 통과 | 22 pass | 65 pass |
| Ubuntu 24.04 x64, Node 24.22.2 | 1,039 pass / 0 fail / 0 skip | 통과 | 22 pass | 65 pass |
| macOS arm64, Node 26.11.1, npm 11.20.0 — 추가 환경 | 1,039 pass / 0 fail / 0 skip | 통과 | 22 pass | 별도 미실행 |

CommonJS matrix는 같은 여섯 test source를 별도 임시 폴더로 CommonJS 컴파일한 뒤,
테스트의 `src` 경로를 후보의 실제 `dist/cjs`에 연결하여 실행했다. Product를 다른
내용으로 재컴파일해 대체하지 않았다. Session replacement, identity, TABLES, UID,
resources와 IMPORT 회귀가 포함된다. 추가 package-root import/require consumer
테스트는 surface suite에 포함된다.

실제 numeric UID 재현은 각 지원 Node에서 정상 account와 passwd entry 없는
UID `65532:65532`를 비교했다. `--network none`에서 정상 account의 OS lookup은
성공하고, 없는 account는 실패했다. 후자는 ESM/CommonJS public Client open에서
모두 `RFC_OS_USER_UNAVAILABLE`, handle 0, alive false를 확인했다. 실제 username,
host, credential은 출력하지 않았다.

`npm run docs:build`는 Python 3.13.14 Linux x64와 `requirements-docs.txt`의
`--require-hashes --only-binary=:all:` 설치로 strict build를 통과했다. 처음 선택한
Python 3.12는 wheel hash가 맞지 않아 설치가 거절되었고, hash를 변경하지 않고
명시된 Python 버전으로 전환했다. `docs/plans/` 링크와 Markdown은 별도 검사한다.

기본 재실행 명령:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run lint
npm run test:surface
npm run docs:build
```

환경 구성, CommonJS 재실행 script와 최종 log는 저장소 밖의 로컬 검증 기록으로
보관하며 이 문서나 공개 artifact에 포함하지 않는다.

## 남은 제한과 인계

- 실제 SAP 호출·쓰기·배포·운영 dependency 교체는 수행하지 않았다. Synthetic
  성공은 특정 SAP release, production readiness 또는 upstream 1.0 gate의 증거가 아니다.
- Native node-rfc/SDK는 설치·실행하지 않았다. Legacy envelope는 명시적인 synthetic
  비교 fixture이며 native 구현의 모든 값 projection을 비교한 결과가 아니다.
- EXID h nonempty decoder, basXML, 새 identity 조회, 일반 shared-Client dispatch fence,
  metadata pool 공유 설계와 capacity 증가는 구현하지 않았다.
- Consumer wrapper는 독점 stateful 사용 예제다. 외부 queue bound, input 소유권과
  end-to-end deadline은 application 책임이며 business reconciliation을 대체하지 않는다.
- Destroy 실패 시 closing resource를 지우거나 불확실한 call을 자동 재실행하지 않는다.
- 기존 두 계획 문서는 작업 시작 시 untracked 상태였고 이를 보존한 채 결과 링크와
  진행 표만 보완했다. Commit, push, PR 생성, issue 완료 처리와 release는 수행하지 않았다.

새 third-party code를 재사용하지 않았다. 모든 추가 fixture는 project-owned source와
synthetic protocol data를 사용했다.
