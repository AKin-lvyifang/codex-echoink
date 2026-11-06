import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { parseDocument } from "yaml";
import { validateManifestSource } from "./manifest-contract.mjs";
import { runManifestContractTests } from "./manifest-contract-tests.mjs";
import { compileReleaseNotes, isTrackedReleaseHero } from "./release-notes.mjs";
import { runReleaseNotesTests } from "./release-notes-tests.mjs";
import { local as localTestSuites, modes as testModes } from "./test-suites.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const failures = [];
const expectedAssets = ["main.js", "manifest.json", "styles.css"];
const manifest = readManifest();
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const versions = readJson("versions.json");
const workflowPath = path.join(rootDir, ".github", "workflows", "release.yml");
const workflowDocument = parseWorkflow(workflowPath);
const workflow = workflowDocument?.toJS() ?? {};

try { runManifestContractTests(); }
catch (error) { failures.push(`Manifest contract probes failed: ${error.message}`); }
try { runReleaseNotesTests(); }
catch (error) { failures.push(`Release notes probes failed: ${error.message}`); }
check(packageJson.version === manifest.version, "package.json version must match manifest.json.");
check(packageLock.version === manifest.version, "package-lock.json version must match manifest.json.");
check(packageLock.packages?.[""]?.version === manifest.version, "package-lock.json root package version must match manifest.json.");
check(versions[manifest.version] === manifest.minAppVersion, "versions.json must map the manifest version to its minimum app version.");
if (args.tag) {
  const tag = args.allowVTag ? args.tag.replace(/^v/, "") : args.tag;
  check(args.allowVTag || !args.tag.startsWith("v"), "New Obsidian release tags must not use a v prefix.");
  check(tag === manifest.version, "Release tag must match manifest.json version.");
  if (!args.allowVTag) {
    try {
      compileReleaseNotes(fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"), {
        version: manifest.version, repository: "AKin-lvyifang/codex-echoink", isTrackedFile: isTrackedReleaseHero
      });
    } catch (error) { failures.push(`Release notes contract failed: ${error.message}`); }
  }
}

checkPinnedWorkflowActions();
validateReleaseWorkflow(workflow);
validatePlatformBoundary();
validateArtifacts();

if (failures.length > 0) {
  console.error("Obsidian release contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Obsidian release contract passed for ${manifest.version}`
  + `${args.tag ? ` (tag ${args.tag})` : ""}`
  + `${args.artifacts ? ` with assets from ${args.artifacts}` : ""}.`
);

function readManifest() {
  const source = fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8");
  const errors = validateManifestSource(source);
  failures.push(...errors);
  return errors.length ? {} : JSON.parse(source);
}

function validatePlatformBoundary() {
  const entry = fs.readFileSync(path.join(rootDir, "src/platform-entry.ts"), "utf8");
  // Verify the executed selector, including tablets that use the desktop UI
  // while still lacking Node. The unused loader must never be evaluated.
  const code = transformSync(entry, { loader: "ts", format: "cjs", target: "es2022" }).code;
  for (const [name, platform, expected] of [
    ["phone", { isMobileApp: true, isMobile: true, isTablet: false }, "mobile"],
    ["tablet desktop UI", { isMobileApp: true, isMobile: false, isTablet: true }, "mobile"],
    ["desktop", { isMobileApp: false, isMobile: false, isTablet: false }, "desktop"]
  ]) {
    const calls = [];
    const module = { exports: {} };
    try {
      vm.runInNewContext(code, {
        module, exports: module.exports,
        require(id) {
          if (id !== "obsidian") throw new Error(`Unexpected platform import: ${id}`);
          return { Platform: platform };
        },
        loadMobile() { calls.push("mobile"); return "mobile"; },
        loadDesktop() { calls.push("desktop"); return "desktop"; }
      }, { timeout: 1000 });
      check(calls.length === 1 && calls[0] === expected && module.exports === expected,
        `platform entry must evaluate only the ${expected} loader on ${name}.`);
    } catch (error) {
      check(false, `platform entry failed on ${name}: ${error.message}`);
    }
  }
  check(packageJson.scripts?.["test:mobile"] === "node scripts/mobile-tests.mjs",
    "test:mobile must run the mobile integration and production no-Node entry checks.");
  check(packageJson.scripts?.test === "node scripts/run-tests.mjs",
    "npm test must use the local test runner that builds before checking the production entries.");
  check(packageJson.scripts?.["test:integration"] === "node scripts/run-tests.mjs --integration",
    "test:integration must use only the explicit integration mode of the test runner.");
  validateLocalTestTopology();
  const verificationCommands = (packageJson.scripts?.["verify:obsidian"] ?? "").split("&&").map(command => command.trim());
  check(JSON.stringify(verificationCommands) === JSON.stringify([
    "npm run check:public", "npm run lint", "npm run typecheck", "npm test", "npm run check:bundle"
  ]), "verify:obsidian must run public, review, type and full local test gates before checking the built bundle, with one build and mobile check owned by npm test.");
  const review = parseWorkflow(path.join(rootDir, ".github/workflows/obsidian-review.yml"))?.toJS();
  const reviewSteps = review?.jobs?.review?.steps ?? [];
  check(reviewSteps.some(step => step.run === "npm run verify:obsidian" && step.if === undefined),
    "review CI must run verify:obsidian, including the mobile production entry.");
  check(!reviewSteps.some(step => step.run === "node scripts/prepare-ci-test-vault.mjs"),
    "review CI must let the local test runner own its isolated test environment.");
  const bundleJob = review?.jobs?.["bundle-load"];
  const bundleSteps = bundleJob?.steps ?? [];
  const downloadIndex = bundleSteps.findIndex(step => typeof step.uses === "string" && step.uses.startsWith("actions/download-artifact@")
    && step.with?.name === "obsidian-review-bundle" && step.with?.path === "dist");
  const environmentIndex = bundleSteps.findIndex(step => step.run === "node scripts/prepare-ci-test-vault.mjs" && step.if === undefined);
  const mobileIndex = bundleSteps.findIndex(step => step.run === "npm run test:mobile" && step.if === undefined);
  check(downloadIndex >= 0 && environmentIndex > downloadIndex && mobileIndex > environmentIndex,
    "cross-platform CI must check the mobile entry in the same downloaded production bundle.");
  check(JSON.stringify([...(bundleJob?.strategy?.matrix?.os ?? [])].sort())
    === JSON.stringify(["macos-latest", "ubuntu-latest", "windows-latest"]),
  "cross-platform CI must retain Linux, macOS and Windows bundle checks.");
}

function validateLocalTestTopology() {
  const runner = fs.readFileSync(path.join(rootDir, "scripts/run-tests.mjs"), "utf8");
  const buildCalls = [...runner.matchAll(/\brun\(npm,\s*\["run",\s*"build"\],\s*"npm run build"\)/gu)];
  const localLoop = /for\s*\(const file of entries\)\s*run\(process\.execPath,\s*\[file\],\s*file\)/u.exec(runner);
  const modeLoop = /for\s*\(const mode of extra\)\s*run\(process\.execPath,\s*\[mode\.file,\s*\.\.\.mode\.args\],\s*mode\.file,\s*mode\.args\)/u.exec(runner);
  check(/from\s+["']\.\/test-suites\.mjs["']/u.test(runner)
    && /const entries = isIntegration \? integration : local;/u.test(runner)
    && /if\s*\(!isIntegration\)\s*run\(npm,\s*\["run",\s*"build"\],\s*"npm run build"\)/u.test(runner)
    && buildCalls.length === 1 && localLoop && buildCalls[0].index < localLoop.index,
  "the local test runner must build once before executing every local suite; integration mode must not build.");
  check(/const result = spawnSync\(command, args,/u.test(runner)
    && /if\s*\(result\.status !== 0\)\s*throw new Error/u.test(runner),
  "the test runner must execute suites synchronously and stop when a build or test fails.");
  check(localTestSuites.filter(file => file === "scripts/mobile-tests.mjs").length === 1,
    "the full local test inventory must directly check the mobile production entry exactly once.");
  check(testModes.some(mode => mode.file === "scripts/pi-brace-expansion-tests.mjs" && mode.group === "local"
    && JSON.stringify(mode.args) === JSON.stringify(["--production"]))
    && /const extra = modes\.filter\(mode => mode\.group === "local" && !isIntegration\);/u.test(runner)
    && localLoop && modeLoop && modeLoop.index > localLoop.index,
  "npm test must retain the production dependency check after the shared build.");
}

function validateReleaseWorkflow(config) {
  const steps = Array.isArray(config?.jobs?.release?.steps) ? config.jobs.release.steps : [];
  check(steps.length > 0, "release workflow must contain a release job with steps.");
  const draftIndex = steps.findIndex(isDraftReleaseStep);
  const verificationIndex = steps.findIndex(isPublishedAssetVerificationStep);
  const publishIndex = steps.findIndex(isPublishStep);
  const guardIndex = steps.findIndex(isExistingReleaseGuard);
  const attestIndex = steps.findIndex((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/attest@"));
  const testIndex = steps.findIndex(step => step.run === "npm run test");
  const buildIndex = steps.findIndex(step => step.run === "npm run build");
  const environmentIndex = steps.findIndex(step => step.run === "node scripts/prepare-ci-test-vault.mjs");
  const desktopCheckIndex = steps.findIndex(step => step.run === "npm run check:bundle");
  const mobileCheckIndex = steps.findIndex(step => step.run === "npm run test:mobile");
  const notesIndex = steps.findIndex(step => typeof step.run === "string" && step.run.includes("node scripts/release-notes.mjs"));

  const runTestsCondition = "${{ github.event_name != 'workflow_dispatch' || inputs.skip_tests != true }}";
  const skipTestsCondition = "${{ github.event_name == 'workflow_dispatch' && inputs.skip_tests == true }}";
  check(testIndex >= 0 && testIndex < desktopCheckIndex && steps[testIndex]?.if === runTestsCondition,
    "release workflow must run the full local test gate unless a historical dispatch explicitly skips tests.");
  check(buildIndex >= 0 && desktopCheckIndex > buildIndex && mobileCheckIndex > buildIndex
    && mobileCheckIndex < attestIndex && desktopCheckIndex < attestIndex
    && steps[desktopCheckIndex]?.if === undefined
    && steps[buildIndex]?.if === skipTestsCondition && steps[mobileCheckIndex]?.if === skipTestsCondition,
    "release workflow must reuse npm test's build and mobile checks normally, and explicitly build then verify both production entries before attestation when historical tests are skipped.");
  check(environmentIndex >= 0 && environmentIndex < buildIndex && steps[environmentIndex]?.if === skipTestsCondition,
    "historical rebuilds that skip the local runner must still prepare an isolated test environment.");

  check(attestIndex >= 0, "release workflow must attest the release assets.");
  check(draftIndex >= 0, "release workflow must create a draft release without overwriting files.");
  check(guardIndex >= 0, "release workflow must reject mutation of an existing public release.");
  check(verificationIndex >= 0, "release workflow must download and verify the draft assets before publishing.");
  check(publishIndex >= 0, "release workflow must publish only after verification.");
  check(notesIndex >= 0 && notesIndex < draftIndex,
    "release workflow must extract and validate structured notes before creating a draft.");
  check(
    attestIndex >= 0 && guardIndex > attestIndex && draftIndex > guardIndex
      && verificationIndex > draftIndex && publishIndex > verificationIndex,
    "release workflow must follow attest → guard → draft → verify → publish."
  );

  const draft = steps[draftIndex];
  const attestation = steps[attestIndex];
  if (draft) {
    check(draft.with?.name === "${{ env.RELEASE_TITLE }}", "draft release must explicitly use the validated release title.");
    check(draft.with?.body_path === "${{ env.RELEASE_NOTES_FILE }}", "draft release must use the validated bilingual notes and release-type marker.");
    check(draft.with?.draft === true, "the uploaded release must remain a draft until verification completes.");
    check(draft.with?.overwrite_files === false, "release assets must never overwrite existing assets.");
    check(draft.with?.make_latest === false, "an unverified draft must not become latest.");
    checkSameAssetSet(blockValues(draft.with?.files), "draft release assets");
  }
  if (attestation) checkSameAssetSet(blockValues(attestation.with?.["subject-path"]), "attested release assets");
  if (notesIndex >= 0) {
    const notesCommand = steps[notesIndex].run;
    check(notesCommand.includes('--version "$manifest_version"') && notesCommand.includes('--output "$notes"')
      && notesCommand.includes('--github-env "$GITHUB_ENV"'),
    "release notes extraction must use the checked manifest version and export its validated outputs.");
    check(notesCommand.includes('if [ "$EVENT_NAME" = "workflow_dispatch" ]; then') && notesCommand.includes("--historical"),
      "historical dispatch must retain compatibility with legacy release notes.");
  }

  const commands = steps.map((step) => typeof step?.run === "string" ? step.run : "").join("\n");
  for (const forbidden of ["gh release delete", "gh release delete-asset", "gh release upload", "--clobber"]) {
    check(!commands.includes(forbidden), `release workflow must not use destructive or overwriting command: ${forbidden}.`);
  }
}

function isDraftReleaseStep(step) {
  return typeof step?.uses === "string"
    && step.uses.startsWith("softprops/action-gh-release@")
    && step.with?.draft === true
    && step.with?.overwrite_files === false;
}

function isExistingReleaseGuard(step) {
  const run = step?.run;
  return typeof run === "string"
    && run.includes("gh api")
    && run.includes("public")
    && run.includes("exit 1");
}

function isPublishedAssetVerificationStep(step) {
  const run = step?.run;
  return typeof run === "string"
    && run.includes("gh release download")
    && run.includes("cmp ")
    && run.includes("gh attestation verify");
}

function isPublishStep(step) {
  const run = step?.run;
  return typeof run === "string"
    && run.includes("gh release edit")
    && run.includes("--draft=false")
    && run.includes("--latest");
}

function validateArtifacts() {
  if (!args.artifacts) return;
  const directory = path.resolve(rootDir, args.artifacts);
  check(fs.existsSync(directory), `artifact directory does not exist: ${directory}.`);
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile());
  checkSameAssetSet(files, "prepared release assets");
  for (const asset of expectedAssets) {
    const assetPath = path.join(directory, asset);
    check(fs.existsSync(assetPath) && fs.statSync(assetPath).size > 0, `release asset must be non-empty: ${asset}.`);
    const sourcePath = path.join(rootDir, asset === "main.js" ? "dist/main.js" : asset);
    if (fs.existsSync(assetPath) && fs.existsSync(sourcePath)) {
      check(fs.readFileSync(assetPath).equals(fs.readFileSync(sourcePath)), `release asset must match the verified source: ${asset}.`);
    } else {
      check(false, `missing verified source or release asset: ${asset}.`);
    }
  }
}

function checkPinnedWorkflowActions() {
  const workflowDir = path.join(rootDir, ".github", "workflows");
  for (const name of fs.readdirSync(workflowDir).filter((file) => /\.ya?ml$/iu.test(file)).sort()) {
    const config = parseWorkflow(path.join(workflowDir, name))?.toJS();
    for (const job of Object.values(config?.jobs ?? {})) {
      checkPinnedAction(job?.uses, `${name} job`);
      for (const step of Array.isArray(job?.steps) ? job.steps : []) checkPinnedAction(step?.uses, `${name} step`);
    }
  }
}

function parseWorkflow(filename) {
  if (!fs.existsSync(filename)) {
    failures.push(`missing workflow: ${path.relative(rootDir, filename)}.`);
    return null;
  }
  const document = parseDocument(fs.readFileSync(filename, "utf8"), { uniqueKeys: true });
  for (const issue of [...document.errors, ...document.warnings]) failures.push(`invalid workflow ${path.basename(filename)}: ${issue.message}`);
  return document.errors.length === 0 ? document : null;
}

function checkPinnedAction(action, label) {
  if (action === undefined || (typeof action === "string" && action.startsWith("./"))) return;
  check(typeof action === "string" && /^[^/\s]+\/[^@\s]+@[a-f0-9]{40}$/u.test(action), `${label} must pin external actions to a full commit SHA.`);
}

function checkSameAssetSet(values, label) {
  const assets = values.map((value) => value.replace(/^release-assets\//u, "")).sort();
  check(JSON.stringify(assets) === JSON.stringify(expectedAssets), `${label} must be exactly ${expectedAssets.join(", ")}.`);
}

function blockValues(value) {
  return typeof value === "string" ? value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean) : [];
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function parseArgs(values) {
  const parsed = { tag: "", artifacts: "", allowVTag: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--tag") parsed.tag = values[++index] ?? "";
    else if (value === "--artifacts") parsed.artifacts = values[++index] ?? "";
    else if (value === "--allow-v-tag") parsed.allowVTag = true;
    else {
      console.error(`Unknown argument: ${value}`);
      process.exit(1);
    }
  }
  return parsed;
}
