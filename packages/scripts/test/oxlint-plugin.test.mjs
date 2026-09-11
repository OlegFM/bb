import { describe, expect, it } from "vitest";
import { rules } from "../../../scripts/oxlint-plugin.mjs";

function runRule(rule, nodes) {
  const reports = [];
  const visitor = rule.create({
    report(report) {
      reports.push(report);
    },
  });
  for (const node of nodes) {
    visitor[node.type]?.(node);
  }
  return reports;
}

function literal(value) {
  return { type: "Literal", value };
}

function templateElement(cooked) {
  return { type: "TemplateElement", value: { cooked, raw: cooked } };
}

describe("bb/no-tmp-path-literal", () => {
  const rule = rules["no-tmp-path-literal"];

  it("reports string literals under /tmp", () => {
    const reports = runRule(rule, [literal("/tmp/bb-server-test"), literal("/tmp")]);

    expect(reports).toHaveLength(2);
    expect(reports[0].message).toContain("os.tmpdir()");
  });

  it("reports template literal quasis under /tmp", () => {
    const reports = runRule(rule, [templateElement("/tmp/bb-")]);

    expect(reports).toHaveLength(1);
  });

  it("ignores other paths and non-string literals", () => {
    const reports = runRule(rule, [
      literal("/tmpfoo/bar"),
      literal("/var/tmp/x"),
      literal("tmp/relative"),
      literal(42),
      templateElement("/home/"),
    ]);

    expect(reports).toEqual([]);
  });
});
