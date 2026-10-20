# Flaky tests — quarantine and CI retry policy (QA-001)

This document defines how we identify flaky tests, quarantine them without
hiding systemic failures, and how CI applies **bounded** retries so signal
stays trustworthy as test volume grows.

---

## 1. Goals

- **Preserve CI signal**: A failing job should mean something is wrong, not "maybe the network blinked."
- **Time-bound relief**: Quarantine is temporary and owned.
- **Explicit automation**: Retry behavior in GitHub Actions is documented and capped.
- **Automated detection**: The flake reporter (`scripts/flake-reporter.mjs`) emits
  candidates on every CI run; a weekly aggregation report surfaces the ranked flake list.

---

## 2. Definitions

| Term                   | Meaning                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flaky test**         | A test that sometimes passes and sometimes fails **without** a deterministic code change (ordering, timing, async races, external services).                                                       |
| **Flake candidate**    | A test whose Jest JSON result shows `failureMessages` on a `passed` run (pass-after-retry), detected automatically by `scripts/flake-reporter.mjs`.                                                |
| **Quarantine**         | The test is still in tree but tracked in `.github/flaky-tests-quarantine.json` with **owner**, **expiry**, and **reason**, addressed via an approved mitigation (retryTimes, skip + ticket, etc.). |
| **Bounded retry (CI)** | Jest `retryTimes(1)` inside the test, not at the CI step level. Total attempts ≤ 2.                                                                                                                |

---

## 3. Identifying flaky tests

### 3a. Automated (primary)

The **flake reporter** (`scripts/flake-reporter.mjs`) runs after every frontend
and backend test step in `.github/workflows/ci.yml`. It:

1. Parses the Jest `--json` output (`jest-results.json`).
2. Identifies pass-after-retry candidates (passed run with non-empty `failureMessages`).
3. Cross-references against the quarantine registry.
4. Writes a per-run JSON report to `reports/flake/<scope>-<run>.json` (artifact retained 30 days).
5. Prints a summary to the GitHub Actions step summary.

The **weekly flake report** (`.github/workflows/flaky-report.yml`, Sundays 06:00 UTC)
aggregates the last 7 days of per-run reports into a ranked table and posts it to
the job summary. The report artifact is retained for 90 days.

### 3b. Manual

1. **Evidence**: At least two failures on `main`/`develop` or repeated PR flakes
   where the diff cannot explain the failure (check artifacts/logs).
2. **Reproduce**: Prefer reproducing locally with `jest --repeat` or stress runs before quarantining.
3. **Ticket**: File or link a GitHub issue for the root cause.

Do **not** use quarantine for genuine product regressions.

---

## 4. Quarantine process

1. Add an entry to **`.github/flaky-tests-quarantine.json`**:

```json
{
  "owner": "github-username",
  "expires_on": "YYYY-MM-DD",
  "scope": "frontend",
  "pattern": "src/components/ui/__tests__/MyComponent.test.tsx",
  "reason": "Async race in useEffect teardown — #123",
  "mitigation": "Jest retryTimes(1) added at test level"
}
```

Required fields: `owner`, `expires_on`, `scope`, `pattern`, `reason`, `mitigation`.
Allowed scopes: `frontend` | `backend` | `contracts` | `e2e` | `other`.

2. Open a PR; reviewers confirm:
   - Expiry is **≤ 30 days** in the future (extend only with justification).
   - A linked issue exists for the root cause.
3. Before `expires_on`, either fix and remove the entry, or extend with a new PR
   updating `expires_on` and `owner`.

**Expired entries block CI.** `validate-flaky-quarantine.mjs` is a required gate
on every push and PR (`validate-quarantine` job in `ci.yml`).

The validator itself is covered by
`scripts/__tests__/validate-flaky-quarantine.test.mjs`, which runs the real
script against fixture registries and asserts both the passing and the failing
branches (expired entries, missing fields, invalid scope/date, unreadable
registry). The `Scripts Unit Tests` job in `ci.yml` runs that suite, so a bug
in the validator cannot silently turn the gate into a no-op.

---

## 5. CI retry policy (bounded)

Retries are applied **inside tests** via `jest.retryTimes(1)` (or equivalent),
not via CI step-level retries. This is intentional: step-level retries hide
signal from the flake reporter.

| Jest `retryTimes` value | Meaning                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `0` (default)           | No retry. Test fails on first failure.                                       |
| `1`                     | One retry. Pass-after-retry is flagged as a flake candidate by the reporter. |

The maximum allowed value is **1**. Using `retryTimes(2)` or higher requires a
comment explaining why, and must be reviewed with extra scrutiny.

---

## 6. Tooling reference

| Tool                   | Location                                | Purpose                                                                        |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Quarantine registry    | `.github/flaky-tests-quarantine.json`   | Source of truth for all quarantined tests                                      |
| Registry validator     | `scripts/validate-flaky-quarantine.mjs` | Validates schema + expiry; run in every CI push/PR                             |
| Validator unit tests   | `scripts/__tests__/validate-flaky-quarantine.test.mjs` | Executes the validator against fixture registries, so a bug in the validator cannot silently disable the gate |
| Flake reporter         | `scripts/flake-reporter.mjs`            | Detects pass-after-retry candidates from Jest JSON; emits per-run reports      |
| Weekly report workflow | `.github/workflows/flaky-report.yml`    | Aggregates per-run reports; posts ranked table to job summary                  |
| CI integration         | `.github/workflows/ci.yml`              | `validate-quarantine` job; `--json` flag on test steps; flake candidate upload |

### Running locally

```bash
# Validate registry (no expired entries)
node scripts/validate-flaky-quarantine.mjs

# Analyse a local Jest JSON result
cd frontend && pnpm test -- --json --outputFile=jest-results.json
cd ..
node scripts/flake-reporter.mjs \
  --results frontend/jest-results.json \
  --scope frontend \
  --output /tmp/flake-report.json

# Unit tests for the gate scripts themselves (root of the repo)
pnpm test:scripts
```

---

## 7. Weekly report triage ritual

After each Sunday report is published (check Actions → `Flaky Test Weekly Report`):

1. Review the ranked table in the job summary.
2. For **new candidates** (not yet quarantined): open a GitHub issue and add an entry to the registry.
3. For **quarantined tests**: check whether the root cause is fixed; if so, remove the entry.
4. For **expired entries**: fix or extend before the next push to main/develop (they block CI).

---

## 8. Adoption

- New contributors: read this doc before marking tests skipped or adding `retryTimes`.
- Code review: challenge quarantines without owner/expiry or with past-dated expiry.
- On-call / release: run `node scripts/validate-flaky-quarantine.mjs` before cutting a release
  if a long time has passed since the last push.

---

## Related

- [`TESTING.md`](../frontend/TESTING.md) — overall testing strategy
- [`mutation-testing-baseline.md`](mutation-testing-baseline.md) — StrykerJS pilot policy
- [`migration-rollback-playbook.md`](migration-rollback-playbook.md) — DB migration policy
