import esbuild from "esbuild";

try {
  const build = await esbuild.build({
    entryPoints: ["src/harness/records/storage-inventory-cli.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: "storage-inventory-cli.mjs",
    write: false,
    logLevel: "silent"
  });
  const output = build.outputFiles?.[0];
  if (!output) throw new Error("missing bundled output");
  const source = Buffer.from(output.contents).toString("base64");
  const cli = await import(`data:text/javascript;base64,${source}`);
  process.exitCode = await cli.runStorageInventoryCli(process.argv.slice(2));
} catch {
  // Bundler and module-loader errors can include source excerpts. Keep the
  // metadata-only launcher failure generic.
  process.stderr.write("Storage inventory launcher failed.\n");
  process.exitCode = 1;
}
