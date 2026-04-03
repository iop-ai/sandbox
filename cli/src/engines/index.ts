export * from "./types.ts";
export * from "./base.ts";
export * from "./claude.ts";
export * from "./codex.ts";

import { ClaudeEngine } from "./claude.ts";
import { CodexEngine } from "./codex.ts";
import type { AIEngine, AIEngineName } from "./types.ts";

/**
 * Create an AI engine by name
 */
export function createEngine(name: AIEngineName): AIEngine {
	switch (name) {
		case "claude":
			return new ClaudeEngine();
		case "codex":
			return new CodexEngine();
		default:
			throw new Error(`Unknown AI engine: ${name}`);
	}
}

/**
 * Get the display name for an engine
 */
export function getEngineName(name: AIEngineName): string {
	return createEngine(name).name;
}

/**
 * Check if an engine is available
 */
export async function isEngineAvailable(name: AIEngineName): Promise<boolean> {
	return createEngine(name).isAvailable();
}
