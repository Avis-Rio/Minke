import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  auditRepositorySourceTextAssertions,
  auditSourceTextAssertions,
  compareSourceAssertionBaseline,
  portableRepositoryPath,
} from "../scripts/tests/source-assertions.mjs";

test("source assertion audit follows file reads through derived values", () => {
  const findings = auditSourceTextAssertions(`
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const source = readFileSync("module.ts", "utf8");
    const derived = source.replaceAll("\\r\\n", "\\n");
    assert.match(source, /implementation/u);
    assert.doesNotMatch(derived, /legacy/u);
    assert.match(error.message, /public failure/u);
  `);
  assert.deepEqual(
    findings.map(({ line, method }) => ({ line, method })),
    [
      { line: 6, method: "match" },
      { line: 7, method: "doesNotMatch" },
    ],
  );
});

test("source assertion audit uses portable repository paths", () => {
  assert.equal(
    portableRepositoryPath(
      "tests\\nested\\source-assertion.test.mjs",
    ),
    "tests/nested/source-assertion.test.mjs",
  );
});

test("source assertion audit separates bindings in sibling fixtures", () => {
  const findings = auditSourceTextAssertions(`
    function sourceFixture() {
      const entry = readFileSync("adapter.ts", "utf8");
      const adapter = entry;
      return adapter;
    }
    function runtimeFixture() {
      const entry = { warning: "route collision" };
      const adapter = entry;
      return { warnings: [adapter.warning] };
    }
    assert.match(runtimeFixture().warnings[0], /route collision/);
    assert.match(sourceFixture(), /implementation/);
  `);
  assert.deepEqual(findings.map(({ line }) => line), [13]);
});

test("source assertion audit follows closures without crossing shadowed bindings", () => {
  const findings = auditSourceTextAssertions(`
    const source = readFileSync("module.ts", "utf8");
    function inspect(source) {
      assert.match(source, /public output/);
    }
    {
      const source = "public output";
      assert.match(source, /public output/);
    }
    function inspectCaptured() {
      const derived = source.trim();
      assert.match(derived, /implementation/);
    }
    let assigned;
    assigned = source;
    assert.match(assigned, /implementation/);
  `);
  assert.deepEqual(findings.map(({ line }) => line), [12, 16]);
});

test("source assertion audit distinguishes property names from source values", () => {
  const findings = auditSourceTextAssertions(`
    const source = readFileSync("module.ts", "utf8");
    const response = { source: "public output" };
    assert.match(response.source, /public output/);
    assert.match({ source }.source, /implementation/);
    assert.match(response[source], /implementation/);
  `);
  assert.deepEqual(findings.map(({ line }) => line), [5, 6]);
});

test("source assertion audit follows file contents through helper arguments", () => {
  const findings = auditSourceTextAssertions(`
    const source = readFileSync("module.ts", "utf8");
    function inspect(content) {
      assert.match(content, /implementation/);
    }
    const inspectArrow = ({ text }) => assert.doesNotMatch(text, /legacy/);
    inspect(source);
    inspectArrow({ text: source });
  `);
  assert.deepEqual(findings.map(({ line }) => line), [4, 6]);
});

test("source assertion audit treats parsed JSON as data", () => {
  const findings = auditSourceTextAssertions(`
    const source = readFileSync("settings.json", "utf8");
    const settings = JSON.parse(source);
    function inspect(settings) {
      assert.match(settings.label, /^m-/);
    }
    inspect(settings);
    assert.match(source, /label/);
  `);
  assert.deepEqual(findings.map(({ line }) => line), [8]);
});

test("source-text assertion debt matches the ratcheted baseline", async () => {
  const baseline = JSON.parse(
    await readFile(
      new URL(
        "../config/source-assertion-baseline.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const audit = await auditRepositorySourceTextAssertions();
  assert.deepEqual(
    compareSourceAssertionBaseline(audit.counts, baseline),
    [],
    [
      "Source-text assertion debt must not grow.",
      "Replace them with behavior, rendered output, parsed data, or an applied-artifact contract.",
      "When debt is removed, lower config/source-assertion-baseline.json in the same change.",
    ].join(" "),
  );
});
