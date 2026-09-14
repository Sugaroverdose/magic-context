import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const floor = packageJson.engines.bun.replace(/^>=\s*/, "");
const found = process.versions.bun;

const versionParts = (version) =>
	version.split(/[.-]/, 3).map((part) => Number.parseInt(part, 10));
const [floorMajor, floorMinor, floorPatch] = versionParts(floor);
const [foundMajor, foundMinor, foundPatch] = versionParts(found);
const belowFloor =
	foundMajor < floorMajor ||
	(foundMajor === floorMajor && foundMinor < floorMinor) ||
	(foundMajor === floorMajor &&
		foundMinor === floorMinor &&
		foundPatch < floorPatch);

if (belowFloor) {
	console.error(`Bun ${found} is below the ${floor} floor`);
	process.exit(1);
}
