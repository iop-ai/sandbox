#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPlatformBinary() {
	const platform = process.platform;
	const arch = process.arch;

	const platformMap = {
		darwin: "darwin",
		linux: "linux",
	};

	const archMap = {
		arm64: "arm64",
		aarch64: "arm64",
		x64: "x64",
		amd64: "x64",
	};

	const platformKey = platformMap[platform];
	const archKey = archMap[arch];

	if (!platformKey || !archKey) {
		console.error(`Unsupported platform: ${platform}-${arch}`);
		process.exit(1);
	}

	const binaryName = `iop-${platformKey}-${archKey}`;

	return join(__dirname, "dist", binaryName);
}

/**
 * Check if a command exists in PATH
 */
function commandExists(name) {
	try {
		const result = spawnSync("which", [name], { stdio: "pipe" });
		return result.status === 0;
	} catch {
		return false;
	}
}

function main() {
	const binaryPath = getPlatformBinary();

	if (!existsSync(binaryPath)) {
		// Fallback: try running with tsx or bun directly (development mode)
		const srcPath = join(__dirname, "src", "index.ts");
		if (existsSync(srcPath)) {
			const runners = ["bun", "tsx"];

			for (const runner of runners) {
				if (!commandExists(runner)) continue;

				const runnerArgs = runner === "bun" ? ["run", srcPath] : [srcPath];
				const userArgs = process.argv.slice(2);

				const result = spawnSync(runner, [...runnerArgs, ...userArgs], {
					stdio: "inherit",
					cwd: process.cwd(),
				});

				if (result.error === undefined) {
					process.exit(result.status ?? 1);
				}
			}
		}

		console.error(`Binary not found: ${binaryPath}`);
		console.error("Run 'bun run build' to compile the binary for your platform.");
		console.error("Or install tsx: npm install -g tsx");
		process.exit(1);
	}

	const result = spawnSync(binaryPath, process.argv.slice(2), {
		stdio: "inherit",
		cwd: process.cwd(),
	});

	process.exit(result.status ?? 1);
}

main();
