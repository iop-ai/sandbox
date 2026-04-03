import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { type IopConfig, IopConfigSchema } from "./types.ts";

export const IOP_DIR = ".iop";
export const CONFIG_FILE = "config.yaml";
export const PROGRESS_FILE = "progress.txt";

/**
 * Get the full path to the iop directory
 */
export function getIopDir(workDir = process.cwd()): string {
	return join(workDir, IOP_DIR);
}

/**
 * Get the full path to the config file
 */
export function getConfigPath(workDir = process.cwd()): string {
	return join(workDir, IOP_DIR, CONFIG_FILE);
}

/**
 * Get the full path to the progress file
 */
export function getProgressPath(workDir = process.cwd()): string {
	return join(workDir, IOP_DIR, PROGRESS_FILE);
}

/**
 * Check if iop is initialized in the directory
 */
export function isInitialized(workDir = process.cwd()): boolean {
	return existsSync(getConfigPath(workDir));
}

/**
 * Load the iop config from disk
 */
export function loadConfig(workDir = process.cwd()): IopConfig | null {
	const configPath = getConfigPath(workDir);

	if (!existsSync(configPath)) {
		return null;
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = YAML.parse(content);
		return IopConfigSchema.parse(parsed);
	} catch (error) {
		// Log error for debugging, but return default config
		console.error(`Warning: Failed to parse config at ${configPath}:`, error);
		return IopConfigSchema.parse({});
	}
}

/**
 * Get rules from config
 */
export function loadRules(workDir = process.cwd()): string[] {
	const config = loadConfig(workDir);
	return config?.rules ?? [];
}

/**
 * Get boundaries from config
 */
export function loadBoundaries(workDir = process.cwd()): string[] {
	const config = loadConfig(workDir);
	return config?.boundaries.never_touch ?? [];
}

/**
 * Get test command from config
 */
export function loadTestCommand(workDir = process.cwd()): string {
	const config = loadConfig(workDir);
	return config?.commands.test ?? "";
}

/**
 * Get lint command from config
 */
export function loadLintCommand(workDir = process.cwd()): string {
	const config = loadConfig(workDir);
	return config?.commands.lint ?? "";
}

/**
 * Get build command from config
 */
export function loadBuildCommand(workDir = process.cwd()): string {
	const config = loadConfig(workDir);
	return config?.commands.build ?? "";
}

/**
 * Get project context as a formatted string
 */
export function loadProjectContext(workDir = process.cwd()): string {
	const config = loadConfig(workDir);
	if (!config) return "";

	const parts: string[] = [];
	if (config.project.name) parts.push(`Project: ${config.project.name}`);
	if (config.project.language) parts.push(`Language: ${config.project.language}`);
	if (config.project.framework) parts.push(`Framework: ${config.project.framework}`);
	if (config.project.description) parts.push(`Description: ${config.project.description}`);

	return parts.join("\n");
}
