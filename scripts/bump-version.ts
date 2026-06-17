// @ts-nocheck
const pkgPath = "packages/zenstack-mcp/package.json";
const pkg = await Bun.file(pkgPath).json();
const [major, minor, patch] = pkg.version.split(".").map(Number);
pkg.version = [major, minor, patch + 1].join(".");
await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("Bumped to", pkg.version);
