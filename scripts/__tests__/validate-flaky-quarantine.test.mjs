/**
 * Tests for scripts/validate-flaky-quarantine.mjs
 *
 * The validation logic is imported from the script itself, so the tests cover
 * the rules that actually run in CI. The CLI is exercised through the
 * `--registry` override.
 */

import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  MAX_EXPIRY_DAYS,
  parseArgs,
  validateRegistry,
} from "../validate-flaky-quarantine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../scripts/validate-flaky-quarantine.mjs");
const TMP = mkdtempSync(join(tmpdir(), "flaky-quarantine-test-"));

function registryPath() {
  return join(TMP, "flaky-tests-quarantine.json");
}

function writeRegistry(entries) {
  writeFileSync(
    registryPath(),
    JSON.stringify({ version: "1", entries }),
    "utf8",
  );
}

function runValidator(entries, extraArgs = []) {
  writeRegistry(entries);
  try {
    execFileSync("node", [SCRIPT, "--registry", registryPath(), ...extraArgs], {
      stdio: "pipe",
    });
    return { status: 0 };
  } catch (err) {
    return { status: err.status ?? 1, stderr: err.stderr?.toString() ?? "" };
  }
}

const REQUIRED_FIELDS = [
  "owner",
  "expires_on",
  "scope",
  "pattern",
  "reason",
  "mitigation",
];

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const VALID_ENTRY = {
  owner: "test-user",
  expires_on: daysFromNow(14),
  scope: "frontend",
  pattern: "src/components/Foo.test.tsx",
  reason: "Async race — #42",
  mitigation: "retryTimes(1)",
};

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

// ─── Pure validation logic tests ───────────────────────────────────────────

describe("validate-flaky-quarantine logic", () => {
  describe("empty registry", () => {
    it("passes with zero entries", () => {
      expect(validateRegistry({ entries: [] }).errors).toHaveLength(0);
    });

    it("fails when entries is not an array", () => {
      expect(validateRegistry({ entries: "nope" }).errors).toHaveLength(1);
    });
  });

  describe("valid entry", () => {
    it("passes for a fully populated valid entry", () => {
      expect(validateRegistry({ entries: [VALID_ENTRY] }).errors).toHaveLength(0);
    });

    it("passes for all allowed scopes", () => {
      for (const scope of ["frontend", "backend", "contracts", "e2e", "other"]) {
        const entry = { ...VALID_ENTRY, scope };
        expect(validateRegistry({ entries: [entry] }).errors).toHaveLength(0);
      }
    });
  });

  describe("missing required fields", () => {
    for (const field of REQUIRED_FIELDS) {
      it(`fails when "${field}" is missing`, () => {
        const entry = { ...VALID_ENTRY };
        delete entry[field];
        const { errors } = validateRegistry({ entries: [entry] });
        expect(errors.some((e) => e.includes(field))).toBe(true);
      });
    }
  });

  describe("expires_on format", () => {
    it("fails for invalid date format MM/DD/YYYY", () => {
      const entry = { ...VALID_ENTRY, expires_on: "12/31/2099" };
      expect(
        validateRegistry({ entries: [entry] }).errors.some((e) =>
          e.includes("expires_on"),
        ),
      ).toBe(true);
    });

    it("fails for ISO datetime instead of date", () => {
      const entry = { ...VALID_ENTRY, expires_on: "2099-12-31T00:00:00Z" };
      expect(
        validateRegistry({ entries: [entry] }).errors.some((e) =>
          e.includes("expires_on"),
        ),
      ).toBe(true);
    });

    it("passes for YYYY-MM-DD in future", () => {
      expect(
        validateRegistry({ entries: [{ ...VALID_ENTRY, expires_on: daysFromNow(3) }] })
          .errors,
      ).toHaveLength(0);
    });
  });

  describe("expired entries", () => {
    it("fails when expires_on is yesterday", () => {
      const entry = { ...VALID_ENTRY, expires_on: daysFromNow(-1) };
      const { errors } = validateRegistry({ entries: [entry] });
      expect(errors.some((e) => e.includes("past"))).toBe(true);
    });

    it("does not fail when allowExpired=true", () => {
      const entry = { ...VALID_ENTRY, expires_on: daysFromNow(-1) };
      const { errors, warnings } = validateRegistry(
        { entries: [entry] },
        { allowExpired: true },
      );
      expect(errors).toHaveLength(0);
      expect(warnings.some((w) => w.includes("past"))).toBe(true);
    });
  });

  describe("expiry window (policy §4)", () => {
    it("fails when the quarantine expires further out than the allowed window", () => {
      const entry = {
        ...VALID_ENTRY,
        expires_on: daysFromNow(MAX_EXPIRY_DAYS + 5),
      };
      const { errors } = validateRegistry({ entries: [entry] });
      expect(errors.some((e) => e.includes("justification"))).toBe(true);
    });

    it("accepts a longer quarantine when a justification is recorded", () => {
      const entry = {
        ...VALID_ENTRY,
        expires_on: daysFromNow(MAX_EXPIRY_DAYS + 5),
        justification: "Vendor fix lands in the next release train",
      };
      const { errors, warnings } = validateRegistry({ entries: [entry] });
      expect(errors).toHaveLength(0);
      expect(warnings.some((w) => w.includes("justification"))).toBe(true);
    });

    it("accepts an expiry exactly on the window limit", () => {
      const entry = { ...VALID_ENTRY, expires_on: daysFromNow(MAX_EXPIRY_DAYS) };
      expect(validateRegistry({ entries: [entry] }).errors).toHaveLength(0);
    });
  });

  describe("invalid scope", () => {
    it("fails for unknown scope value", () => {
      const entry = { ...VALID_ENTRY, scope: "mobile" };
      expect(
        validateRegistry({ entries: [entry] }).errors.some((e) =>
          e.includes("scope"),
        ),
      ).toBe(true);
    });
  });

  describe("duplicate entries", () => {
    it("fails when the same scope and pattern is quarantined twice", () => {
      const entries = [VALID_ENTRY, { ...VALID_ENTRY, owner: "other" }];
      expect(
        validateRegistry({ entries }).errors.some((e) =>
          e.includes("duplicate"),
        ),
      ).toBe(true);
    });

    it("allows the same pattern in a different scope", () => {
      const entries = [VALID_ENTRY, { ...VALID_ENTRY, scope: "backend" }];
      expect(validateRegistry({ entries }).errors).toHaveLength(0);
    });
  });

  describe("owner", () => {
    it("warns when the owner does not look like a GitHub username", () => {
      const entry = { ...VALID_ENTRY, owner: "platform team" };
      const { errors, warnings } = validateRegistry({ entries: [entry] });
      expect(errors).toHaveLength(0);
      expect(warnings.some((w) => w.includes("owner"))).toBe(true);
    });
  });

  describe("multiple entries", () => {
    it("collects errors from all entries independently", () => {
      const bad1 = { ...VALID_ENTRY, expires_on: daysFromNow(-1) };
      const bad2 = { ...VALID_ENTRY, scope: "unknown" };
      const { errors } = validateRegistry({ entries: [bad1, bad2] });
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });

    it("passes when all entries are valid", () => {
      const entries = Array.from({ length: 5 }, (_, i) => ({
        ...VALID_ENTRY,
        pattern: `src/test-${i}.test.ts`,
      }));
      expect(validateRegistry({ entries }).errors).toHaveLength(0);
    });
  });
});

// ─── Script smoke test (exit codes) ────────────────────────────────────────

describe("validate-flaky-quarantine.mjs — CLI", () => {
  it("exits 0 for an empty registry file", () => {
    expect(runValidator([]).status).toBe(0);
  });

  it("exits 1 for an expired entry", () => {
    const result = runValidator([{ ...VALID_ENTRY, expires_on: daysFromNow(-1) }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expired");
  });

  it("exits 0 for an expired entry with --allow-expired", () => {
    const result = runValidator(
      [{ ...VALID_ENTRY, expires_on: daysFromNow(-1) }],
      ["--allow-expired"],
    );
    expect(result.status).toBe(0);
  });

  it("parses the --registry override", () => {
    const args = parseArgs([
      "node",
      "script.mjs",
      "--registry",
      "/tmp/registry.json",
      "--allow-expired",
    ]);
    expect(args.registry).toBe("/tmp/registry.json");
    expect(args.allowExpired).toBe(true);
  });
});
