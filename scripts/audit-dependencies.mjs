import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const developmentAdvisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const severe = severity => severity === "high" || severity === "critical";

function scopedDevelopmentIssue(issues, packages, name, seen = new Set()) {
  const issue = issues[name];
  if (!issue || seen.has(name)) return false;
  if (!severe(issue.severity)) return true;
  // This advisory has no patched release. The affected glob parser is used by development tooling.
  if (issue.severity !== "high" || !issue.nodes?.length || !issue.nodes.every(path => packages[path]?.dev === true)) return false;
  const chain = new Set([...seen, name]);
  return !!issue.via?.length && issue.via.every(cause => typeof cause === "string"
    ? scopedDevelopmentIssue(issues, packages, cause, chain)
    : !severe(cause.severity) || (name === "picomatch" && cause.severity === "high" && cause.url === developmentAdvisory));
}

const npm = process.env.npm_execpath;
if (!npm) throw Error("Run this check with npm run security:audit.");
const run = spawnSync(process.execPath, [npm, "audit", "--json", "--audit-level=high"], { encoding: "utf8" });
if (run.error || ![0, 1].includes(run.status) || !run.stdout) throw Error("The npm dependency audit did not complete.");
const report = JSON.parse(run.stdout);
const summary = report.metadata?.vulnerabilities;
const issues = report.vulnerabilities;
if (report.error || !summary || !issues) throw Error("npm did not return a complete dependency audit.");
const findings = Object.values(issues).filter(issue => severe(issue.severity));
if (findings.length !== summary.high + summary.critical) throw Error("The npm audit summary and findings differ.");

const { packages } = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const blockers = findings.filter(issue => !scopedDevelopmentIssue(issues, packages, issue.name));
if (blockers.length) {
  for (const issue of blockers) console.error("Blocking dependency advisory", issue.name, issue.severity);
  process.exitCode = 1;
}
if (findings.length > blockers.length) console.warn("Known development tool advisory", developmentAdvisory);
console.log("Dependency audit", summary);
