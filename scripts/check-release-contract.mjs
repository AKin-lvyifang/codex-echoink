import crypto from "crypto";
import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";
import { parseDocument } from "yaml";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const manifestSource = fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8");
const manifestValue = JSON.parse(manifestSource);
const manifest = isPlainRecord(manifestValue) ? manifestValue : {};
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const workflowPath = path.join(rootDir, ".github", "workflows", "release.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const expectedAssets = ["main.js", "manifest.json", "styles.css"];
const failures = [];
const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const notDispatch = "${{ github.event_name != 'workflow_dispatch' }}";
const requiredManifestSchema = {
  author: ["string"],
  minAppVersion: ["string"],
  name: ["string"],
  version: ["string"],
  id: ["string"],
  description: ["string"],
  isDesktopOnly: ["boolean"],
};
const optionalManifestSchema = {
  authorUrl: ["string"],
  fundingUrl: ["string", "object"],
};
const allowedManifestSchema = {
  ...requiredManifestSchema,
  ...optionalManifestSchema,
};
const expectedStepNames = [
  "Checkout release source",
  "Resolve release tag",
  "Set up Node",
  "Install dependencies",
  "Check Obsidian release contract",
  "Check version and release notes",
  "Check public repository files",
  "Check Obsidian review rules",
  "Test",
  "Typecheck",
  "Build",
  "Prepare Obsidian release assets",
  "Verify historical release assets before attesting",
  "Attest release assets",
  "Guard draft release state before upload",
  "Create draft release with attested assets",
  "Add structured release notes",
  "Verify published assets and attestations",
  "Publish verified release",
];
const expectedRunDigests = {
  "Resolve release tag": "c1e59e800ea41b183261795beab948e381848c5afd7b79d6bc61107c296c32ed",
  "Install dependencies": "9db3f780def6105eee3cc930de4d0982607760820fddaa3facdd3813ccb40628",
  "Check Obsidian release contract": "f2edea92f648d23bc17e56ec8a65f8f9270e08b31e52efcc55a0253cfc981c7e",
  "Check version and release notes": "3d9281278fb9af144247a2354c3947722e63bea43e09bb3052ed619cc7fd0f67",
  "Check public repository files": "04fd146f9435964cc9ef0083dba4ddf3256958947a32522e775a5dcc328db3b3",
  "Check Obsidian review rules": "326d9800e732eb9d5a5eb56384a547a097ed84be317cb2852cea5bb574831812",
  "Test": "0c7ec4aac044044cc5b274b09866dbba6c2eedca7ca0198dae0fa3b38e59513b",
  "Typecheck": "982c1455e5e73c8ccab2d70a550c972e2841a0582596e26a7fcc53b80e14aa14",
  "Build": "16c0e4305ac213dff39fc82b69b6e08aeeb8758e33cd72d7c409752a70e9f054",
  "Prepare Obsidian release assets": "3334d582f439fb679d06bb65a233fdb3ab25e58762581cfac200330556e54855",
  "Verify historical release assets before attesting": "bc8a2fbc6fe7b72bacf735e93d574d662ab2a9ef3e8f18b561eabd99d2c10879",
  "Guard draft release state before upload": "83f845ec68df6874bb9362243c7a47cdfe665687be17959a7bd5652c204e0871",
  "Add structured release notes": "206cb32c672c8d2145852263c2af08abfbce633028aee4b9647573d6009c67af",
  "Verify published assets and attestations": "f152b7350e3b29e837a30e226997f2f981a50182423eca7349d0608cec97ea9a",
  "Publish verified release": "489c4aa7ca7e50a55728e2761db20b61fae2faf3c7bc5b1228a1dce80b529f7d",
};
const expectedStepKeys = {
  "Checkout release source": ["name", "uses", "with"],
  "Resolve release tag": ["name", "run"],
  "Set up Node": ["name", "uses", "with"],
  "Install dependencies": ["name", "run"],
  "Check Obsidian release contract": ["name", "run"],
  "Check version and release notes": ["env", "name", "run"],
  "Check public repository files": ["name", "run"],
  "Check Obsidian review rules": ["name", "run"],
  "Test": ["if", "name", "run"],
  "Typecheck": ["name", "run"],
  "Build": ["name", "run"],
  "Prepare Obsidian release assets": ["name", "run"],
  "Verify historical release assets before attesting": ["env", "if", "name", "run"],
  "Attest release assets": ["name", "uses", "with"],
  "Guard draft release state before upload": ["env", "if", "name", "run"],
  "Create draft release with attested assets": ["if", "name", "uses", "with"],
  "Add structured release notes": ["env", "if", "name", "run"],
  "Verify published assets and attestations": ["env", "name", "run"],
  "Publish verified release": ["env", "if", "name", "run"],
};
const expectedStepIf = {
  "Test": "${{ github.event_name != 'workflow_dispatch' || inputs.skip_tests != true }}",
  "Verify historical release assets before attesting": "${{ github.event_name == 'workflow_dispatch' }}",
  "Guard draft release state before upload": notDispatch,
  "Create draft release with attested assets": notDispatch,
  "Add structured release notes": "${{ github.event_name != 'workflow_dispatch' && env.RELEASE_NOTES_FILE != '' }}",
  "Publish verified release": notDispatch,
};
const expectedJobEnv = {
  REQUESTED_TAG: "${{ github.event_name == 'workflow_dispatch' && inputs.tag || '' }}",
  EVENT_NAME: "${{ github.event_name }}",
  EVENT_REF_TYPE: "${{ github.ref_type }}",
  EVENT_REF_NAME: "${{ github.ref_name }}",
  ATTESTATION_SOURCE_REF: "${{ github.ref }}",
  ATTESTATION_SOURCE_DIGEST: "${{ github.sha }}",
};
const expectedStepEnv = {
  "Check version and release notes": {
    ALLOW_MISSING_RELEASE_NOTES: "${{ github.event_name == 'workflow_dispatch' }}",
  },
  "Verify historical release assets before attesting": {
    GH_TOKEN: "${{ github.token }}",
  },
  "Guard draft release state before upload": {
    GH_TOKEN: "${{ github.token }}",
  },
  "Add structured release notes": {
    GH_TOKEN: "${{ github.token }}",
  },
  "Verify published assets and attestations": {
    GH_TOKEN: "${{ github.token }}",
  },
  "Publish verified release": {
    GH_TOKEN: "${{ github.token }}",
  },
};
const expectedStepWith = {
  "Checkout release source": {
    ref: "${{ github.ref }}",
    "fetch-depth": 0,
  },
  "Set up Node": {
    "node-version": "24",
    cache: "npm",
  },
  "Attest release assets": {
    "subject-path": "release-assets/main.js\nrelease-assets/manifest.json\nrelease-assets/styles.css\n",
  },
  "Create draft release with attested assets": {
    tag_name: "${{ env.RELEASE_TAG }}",
    draft: true,
    make_latest: false,
    fail_on_unmatched_files: true,
    overwrite_files: false,
    files: "release-assets/main.js\nrelease-assets/manifest.json\nrelease-assets/styles.css\n",
  },
};
const expectedUsesStepContracts = {
  "Checkout release source": {
    uses: "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    with: expectedStepWith["Checkout release source"],
    env: null,
  },
  "Set up Node": {
    uses: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    with: expectedStepWith["Set up Node"],
    env: null,
  },
  "Attest release assets": {
    uses: "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6",
    with: expectedStepWith["Attest release assets"],
    env: null,
  },
  "Create draft release with attested assets": {
    uses: "softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65",
    with: expectedStepWith["Create draft release with attested assets"],
    env: null,
  },
};

checkPinnedWorkflowActions();
validateManifestSchema(manifestValue, manifestSource);

for (const requiredFile of ["README.md", "LICENSE", "manifest.json"]) {
  check(fs.existsSync(path.join(rootDir, requiredFile)), `Repository root must contain ${requiredFile}.`);
}
check(strictSemver.test(manifest.version), `manifest.json version ${manifest.version} must use strict x.y.z SemVer.`);
check(strictSemver.test(manifest.minAppVersion), `manifest.json minAppVersion ${manifest.minAppVersion} must use strict x.y.z SemVer.`);
check(packageJson.version === manifest.version, `package.json version ${packageJson.version} must match manifest.json ${manifest.version}.`);
check(versions[manifest.version] === manifest.minAppVersion, `versions.json must map ${manifest.version} to ${manifest.minAppVersion}.`);
check(manifest.isDesktopOnly === true, "manifest.json isDesktopOnly must stay true while EchoInk uses Node.js and local CLI backends.");
check(typeof manifest.id === "string" && /^[a-z]+(?:-[a-z]+)*$/.test(manifest.id), "manifest id must contain only lowercase letters separated by single hyphens.");
check(
  typeof manifest.id === "string" && !/(?:obsidian|plugin)/i.test(manifest.id),
  "manifest id must not contain Obsidian or Plugin.",
);
check(
  typeof manifest.name === "string" && /^[A-Za-z0-9 +()-]+$/.test(manifest.name),
  "manifest name must use Basic Latin letters, digits, and spaces; punctuation is limited to -, +, and parentheses.",
);
check(!/(?:obsidian|plugin)/i.test(manifest.name), "manifest name must not contain Obsidian or Plugin.");
check(typeof manifest.author === "string" && manifest.author.trim().length > 0, "manifest author must be a non-empty string.");
check(
  typeof manifest.description === "string"
    && manifest.description.length >= 10
    && manifest.description.length <= 250
    && /^[A-Z][A-Za-z0-9\s.,!?'"-]*\.$/.test(manifest.description)
    && !/(?:obsidian|plugin)/i.test(manifest.description),
  "manifest description must be 10-250 Basic Latin characters, start with a capital letter, end with '.', and omit Obsidian/Plugin.",
);
if ("authorUrl" in manifest) {
  check(validHttpUrl(manifest.authorUrl), "manifest authorUrl must be a non-empty HTTP or HTTPS URL string.");
}
if ("fundingUrl" in manifest) {
  check(validFundingUrl(manifest.fundingUrl), "manifest fundingUrl must be a non-empty URL string or a non-empty map of URL strings.");
}

if (args.tag) {
  const normalizedTag = args.allowVTag ? args.tag.replace(/^v/, "") : args.tag;
  check(args.allowVTag || !args.tag.startsWith("v"), `New Obsidian release tag ${args.tag} must not use a v prefix.`);
  check(normalizedTag === manifest.version, `Release tag ${args.tag} must match manifest version ${manifest.version}.`);
}

const workflowDocument = parseDocument(workflow, { uniqueKeys: true });
for (const issue of [...workflowDocument.errors, ...workflowDocument.warnings]) {
  failures.push(`Invalid release workflow YAML: ${issue.message}`);
}
const workflowConfig = workflowDocument.errors.length === 0 ? workflowDocument.toJS() : {};
checkSameSet(Object.keys(workflowConfig ?? {}), ["name", "on", "concurrency", "permissions", "jobs"], "Release workflow top-level keys");
check(workflowConfig?.name === "Release", "Release workflow name must remain Release.");
const triggers = workflowConfig?.on;
checkSameSet(Object.keys(triggers ?? {}), ["push", "workflow_dispatch"], "Release workflow triggers");
checkSameSet(Object.keys(triggers?.push ?? {}), ["tags"], "Release push filters");
checkSameSet(triggers?.push?.tags ?? [], ["*"], "Release tag patterns");
checkSameSet(Object.keys(triggers?.workflow_dispatch ?? {}), ["inputs"], "Manual Release trigger keys");
checkSameSet(Object.keys(triggers?.workflow_dispatch?.inputs ?? {}), ["tag", "skip_tests"], "Manual Release inputs");
checkDeepEqual(
  {
    required: triggers?.workflow_dispatch?.inputs?.tag?.required,
    type: triggers?.workflow_dispatch?.inputs?.tag?.type,
  },
  { required: true, type: "string" },
  "Manual Release tag input",
);
checkDeepEqual(
  {
    required: triggers?.workflow_dispatch?.inputs?.skip_tests?.required,
    default: triggers?.workflow_dispatch?.inputs?.skip_tests?.default,
    type: triggers?.workflow_dispatch?.inputs?.skip_tests?.type,
  },
  { required: false, default: false, type: "boolean" },
  "Manual Release skip_tests input",
);
checkSameSet(Object.keys(workflowConfig?.concurrency ?? {}), ["group", "cancel-in-progress"], "Release concurrency keys");
check(
  workflowConfig?.concurrency?.group
    === "release-${{ github.repository }}-${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
  "Release concurrency group must serialize the repository and exact requested tag.",
);
check(workflowConfig?.concurrency?.["cancel-in-progress"] === false, "Release workflow must not cancel an in-progress publish.");
checkSameSet(Object.keys(workflowConfig?.permissions ?? {}), [
  "artifact-metadata",
  "attestations",
  "contents",
  "id-token",
], "Release workflow permissions");
for (const permission of ["contents", "id-token", "attestations", "artifact-metadata"]) {
  check(workflowConfig?.permissions?.[permission] === "write", `Release workflow permission ${permission} must be write.`);
}
checkSameSet(Object.keys(workflowConfig?.jobs ?? {}), ["release"], "Release workflow jobs");

const releaseJob = workflowConfig?.jobs?.release ?? {};
checkSameSet(Object.keys(releaseJob), ["runs-on", "env", "steps"], "Release job keys");
check(releaseJob["runs-on"] === "ubuntu-latest", "Release job must run on ubuntu-latest.");
checkDeepEqual(releaseJob.env, expectedJobEnv, "Release job environment");
check(releaseJob.env?.ATTESTATION_SOURCE_REF === "${{ github.ref }}", "Attestation source ref must be the triggering Git ref.");
check(releaseJob.env?.ATTESTATION_SOURCE_DIGEST === "${{ github.sha }}", "Attestation source digest must be the triggering Git commit.");
const steps = Array.isArray(releaseJob.steps) ? releaseJob.steps : [];
const stepNames = steps.map((step) => step?.name).filter((name) => typeof name === "string");
check(stepNames.length === steps.length, "Every release step must have an audited name.");
check(stepNames.length === new Set(stepNames).size, "Release workflow step names must be unique.");
checkSameSequence(stepNames, expectedStepNames, "Audited release step order");
checkSameSequence(
  steps.filter((step) => step?.uses !== undefined).map((step) => step.name),
  Object.keys(expectedUsesStepContracts),
  "Audited release action step order",
);
for (const step of steps) {
  const stepName = typeof step?.name === "string" ? step.name : "<unnamed>";
  const expectedKeys = ownValue(expectedStepKeys, stepName);
  checkSameSet(Object.keys(step ?? {}), expectedKeys ?? [], `Keys for release step ${stepName}`);
  const expectedIf = ownValue(expectedStepIf, stepName);
  check(
    expectedIf === undefined ? step?.if === undefined : step?.if === expectedIf,
    `Release step ${stepName} has an unexpected if condition.`,
  );
  checkDeepEqual(step?.env, ownValue(expectedStepEnv, stepName), `Environment for release step ${stepName}`);
  checkDeepEqual(step?.with, ownValue(expectedStepWith, stepName), `Inputs for release step ${stepName}`);
  const expectedUsesContract = ownValue(expectedUsesStepContracts, stepName);
  checkDeepEqual(
    expectedUsesContract === undefined
      ? step?.uses
      : { uses: step?.uses, with: step?.with, env: step?.env ?? null },
    expectedUsesContract,
    `Action contract for release step ${stepName}`,
  );
  check(step?.["continue-on-error"] === undefined, `Release step ${stepName} must fail closed.`);
  if (typeof step?.run === "string") {
    check(
      sha256(step.run) === ownValue(expectedRunDigests, stepName),
      `Release step ${stepName} command changed; review it and update the audited digest deliberately.`,
    );
  }
}
const allRunScripts = steps.map((step) => typeof step?.run === "string" ? step.run : "").join("\n");
check(
  countOccurrences(allRunScripts, "--draft=false --latest") === 1,
  "Release workflow must contain exactly one publish transition, after verification.",
);
for (const forbiddenCommand of ["gh release delete", "gh release delete-asset", "gh release upload", "--clobber"]) {
  check(!allRunScripts.includes(forbiddenCommand), `Release workflow must not contain destructive or overwrite command: ${forbiddenCommand}.`);
}
const checkoutStep = findStep(steps, "Checkout release source");
const setupNodeStep = findStep(steps, "Set up Node");
const resolveStep = findStep(steps, "Resolve release tag");
const contractStep = findStep(steps, "Check Obsidian release contract");
const lintStep = findStep(steps, "Check Obsidian review rules");
const attestStep = findStep(steps, "Attest release assets");
const guardDraftStep = findStep(steps, "Guard draft release state before upload");
const draftStep = findStep(steps, "Create draft release with attested assets");
const notesStep = findStep(steps, "Add structured release notes");
const verifyStep = findStep(steps, "Verify published assets and attestations");
const publishStep = findStep(steps, "Publish verified release");

check(
  checkoutStep?.uses === "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
  "Release source must use the reviewed checkout v6 commit.",
);
check(checkoutStep?.with?.ref === "${{ github.ref }}", "Release checkout must use the triggering ref.");
check(checkoutStep?.with?.["fetch-depth"] === 0, "Release checkout must fetch tag history.");
check(
  setupNodeStep?.uses === "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  "Release Node runtime must use the reviewed setup-node v6 commit.",
);
check(setupNodeStep?.with?.["node-version"] === "24", "Release Node runtime must stay aligned on Node 24.");
check(setupNodeStep?.with?.cache === "npm", "Release Node setup must keep the npm cache.");
checkIncludes(resolveStep?.run, '[ "$EVENT_REF_TYPE" != "tag" ] || [ "$EVENT_REF_NAME" != "$release_tag" ]', "Historical rebuilds must run from the exact tag ref used for provenance.");
checkIncludes(contractStep?.run, "npm run check:release", "Release workflow must enforce this release contract.");
checkIncludes(lintStep?.run, "npm run lint", "Release workflow must run the Obsidian review lint gate.");
check(
  attestStep?.uses === "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6",
  "Release workflow must use the reviewed actions/attest v4 commit.",
);
check(guardDraftStep?.if === notDispatch, "The new-release state guard must run only for tag publishing.");
checkIncludes(guardDraftStep?.run, "gh api", "The release state guard must query GitHub through a fail-closed API call.");
checkIncludes(guardDraftStep?.run, "--paginate", "The release state guard must inspect all existing Releases.");
checkIncludes(guardDraftStep?.run, "--slurp", "The paginated Release inventory must be parsed as one document.");
checkIncludes(guardDraftStep?.run, "case \"$release_state\"", "The release state guard must explicitly handle public, draft, and missing states.");
checkIncludes(guardDraftStep?.run, "public)", "The release state guard must reject an existing public Release.");
checkIncludes(guardDraftStep?.run, "exit 1", "The release state guard must fail closed.");
check(!String(guardDraftStep?.run ?? "").includes("2>/dev/null"), "The release state guard must not hide GitHub API failures.");
check(draftStep?.if === notDispatch, "Draft asset upload must run only for tag publishing.");
check(
  draftStep?.uses === "softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65",
  "Draft Release creation must use the reviewed action-gh-release v2 commit.",
);
check(draftStep?.with?.draft === true, "New releases must remain draft until final verification succeeds.");
check(draftStep?.with?.make_latest === false, "Draft creation must not mark an unverified release latest.");
check(draftStep?.with?.overwrite_files === false, "Release publishing must never blindly overwrite public assets.");
check(notesStep?.if === "${{ github.event_name != 'workflow_dispatch' && env.RELEASE_NOTES_FILE != '' }}", "Release notes must only mutate a new draft.");
check(verifyStep?.if === undefined, "Asset verification must also run for an explicit re-attestation.");
checkIncludes(verifyStep?.run, "gh release download", "Release workflow must download final published assets.");
checkIncludes(verifyStep?.run, "cmp \"release-assets/$asset\" \"published-assets/$asset\"", "Published assets must byte-match the attested assets.");
checkIncludes(verifyStep?.run, "gh attestation verify", "Release workflow must verify downloaded release assets.");
checkIncludes(verifyStep?.run, "--source-ref \"$ATTESTATION_SOURCE_REF\"", "Published attestation verification must bind the source ref.");
checkIncludes(verifyStep?.run, "--source-digest \"$ATTESTATION_SOURCE_DIGEST\"", "Published attestation verification must bind the source commit.");
checkIncludes(verifyStep?.run, "--cert-identity \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/.github/workflows/release.yml@$ATTESTATION_SOURCE_REF\"", "Published attestations must be signed by release.yml at the exact release ref.");
check(!String(verifyStep?.run ?? "").includes("gh release delete-asset"), "Release automation must not delete existing public assets.");
check(publishStep?.if === notDispatch, "Only a new tag run may publish the verified draft.");
checkIncludes(publishStep?.run, "--draft=false --latest", "The verified draft must be published only after final verification.");

const attestStepIndex = stepIndex(steps, "Attest release assets");
const guardDraftStepIndex = stepIndex(steps, "Guard draft release state before upload");
const draftStepIndex = stepIndex(steps, "Create draft release with attested assets");
const verifyStepIndex = stepIndex(steps, "Verify published assets and attestations");
const publishStepIndex = stepIndex(steps, "Publish verified release");
check(
  attestStepIndex >= 0
    && guardDraftStepIndex > attestStepIndex
    && draftStepIndex > guardDraftStepIndex
    && verifyStepIndex > draftStepIndex
    && publishStepIndex > verifyStepIndex,
  "Release workflow order must be build -> attest -> guard draft state -> draft -> download and verify -> publish.",
);

const attestedAssets = blockValues(attestStep?.with?.["subject-path"]).map(stripReleaseAssetPrefix);
checkSameSet(attestedAssets, expectedAssets, "Attested assets");

const publishedAssets = blockValues(draftStep?.with?.files).map(stripReleaseAssetPrefix);
checkSameSet(publishedAssets, expectedAssets, "Published assets");

if (args.artifacts) {
  const artifactDir = path.resolve(rootDir, args.artifacts);
  check(fs.existsSync(artifactDir), `Artifact directory does not exist: ${artifactDir}.`);
  if (fs.existsSync(artifactDir)) {
    const actualAssets = fs.readdirSync(artifactDir).sort();
    checkSameSet(actualAssets, expectedAssets, "Prepared release assets");
    for (const asset of expectedAssets) {
      const assetPath = path.join(artifactDir, asset);
      check(fs.existsSync(assetPath) && fs.statSync(assetPath).size > 0, `Release asset must exist and be non-empty: ${asset}.`);
    }
  }
}

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

function validateManifestSchema(value, source) {
  const document = parseDocument(source, { uniqueKeys: true });
  for (const issue of [...document.errors, ...document.warnings]) {
    failures.push(`Invalid manifest.json structure: ${issue.message}`);
  }

  if (!isPlainRecord(value)) {
    failures.push("manifest.json must contain exactly one JSON object at the root.");
    return;
  }

  for (const key of Object.keys(requiredManifestSchema)) {
    check(
      Object.prototype.hasOwnProperty.call(value, key),
      `manifest.json is missing required field ${key}.`,
    );
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(allowedManifestSchema, key)) {
      failures.push(`manifest.json field ${key} is not allowed.`);
      continue;
    }
    const allowedTypes = allowedManifestSchema[key];
    const actualType = jsonValueType(fieldValue);
    check(
      allowedTypes.includes(actualType),
      `manifest.json field ${key} must be ${allowedTypes.join(" or ")}; found ${actualType}.`,
    );
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function ownValue(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function checkSameSet(actual, expected, label) {
  const filteredActual = actual.filter(Boolean);
  const normalizedActual = [...new Set(filteredActual)].sort();
  const normalizedExpected = [...expected].sort();
  check(filteredActual.length === expected.length, `${label} must contain exactly ${expected.length} entries; found ${filteredActual.length}.`);
  check(normalizedActual.length === filteredActual.length, `${label} must not contain duplicate entries.`);
  check(
    JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected),
    `${label} must be exactly ${normalizedExpected.join(", ")}; found ${normalizedActual.join(", ") || "none"}.`
  );
}

function checkSameSequence(actual, expected, label) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must be exactly ${expected.join(" -> ")}.`,
  );
}

function checkDeepEqual(actual, expected, label) {
  check(
    stableJson(actual) === stableJson(expected),
    `${label} does not match the audited contract.`,
  );
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (value && typeof value === "object") {
    const normalized = Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, JSON.parse(stableJson(item))]),
    );
    return JSON.stringify(normalized);
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function checkIncludes(value, expected, message) {
  check(typeof value === "string" && value.includes(expected), message);
}

function findStep(steps, name) {
  const step = steps.find((candidate) => candidate?.name === name);
  check(Boolean(step), `Release workflow is missing step: ${name}.`);
  return step;
}

function stepIndex(steps, name) {
  return steps.findIndex((step) => step?.name === name);
}

function blockValues(value) {
  return typeof value === "string"
    ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : [];
}

function stripReleaseAssetPrefix(value) {
  return value.replace(/^release-assets\//, "");
}

function jsonValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/\S+$/.test(value);
}

function validFundingUrl(value) {
  if (typeof value === "string") return validHttpUrl(value);
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0
    && entries.every(([label, url]) => label.trim() && validHttpUrl(url));
}

function checkPinnedWorkflowActions() {
  const workflowDir = path.join(rootDir, ".github", "workflows");
  for (const filename of fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
    const source = fs.readFileSync(path.join(workflowDir, filename), "utf8");
    const document = parseDocument(source, { uniqueKeys: true });
    for (const issue of [...document.errors, ...document.warnings]) {
      failures.push(`Invalid workflow YAML in ${filename}: ${issue.message}`);
    }
    if (document.errors.length > 0) continue;
    const config = document.toJS();
    for (const [jobName, job] of Object.entries(config?.jobs ?? {})) {
      checkPinnedAction(job?.uses, `${filename} job ${jobName}`);
      for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
        checkPinnedAction(step?.uses, `${filename} job ${jobName} step ${step?.name ?? index + 1}`);
      }
    }
  }
}

function checkPinnedAction(action, label) {
  if (action === undefined || (typeof action === "string" && action.startsWith("./"))) return;
  check(
    typeof action === "string" && /^[^/\s]+\/[^@\s]+@[a-f0-9]{40}$/.test(action),
    `${label} must pin external action ${String(action)} to a full commit SHA.`,
  );
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
