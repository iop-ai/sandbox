import {
	BaseAIEngine,
	checkForErrors,
	detectStepFromOutput,
	execCommand,
	execCommandStreaming,
	formatCommandError,
	parseStreamJsonResult,
} from "./base.ts";
import type { AIResult, EngineOptions, ProgressCallback } from "./types.ts";

/**
 * Claude Code AI Engine
 */
export class ClaudeEngine extends BaseAIEngine {
	name = "Claude Code";
	cliCommand = "claude";

	async execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult> {
		const args = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];
		if (options?.modelOverride) {
			args.push("--model", options.modelOverride);
		}
		if (options?.engineArgs && options.engineArgs.length > 0) {
			args.push(...options.engineArgs);
		}

		args.push("-p", prompt);

		const { stdout, stderr, exitCode } = await execCommand(this.cliCommand, args, workDir);

		const output = stdout + stderr;

		// Check for errors
		const error = checkForErrors(output);
		if (error) {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error,
			};
		}

		// Parse result
		const { response, inputTokens, outputTokens } = parseStreamJsonResult(output);

		// If command failed with non-zero exit code, provide a meaningful error
		if (exitCode !== 0) {
			return {
				success: false,
				response,
				inputTokens,
				outputTokens,
				error: formatCommandError(exitCode, output),
			};
		}

		return {
			success: true,
			response,
			inputTokens,
			outputTokens,
		};
	}

	async executeStreaming(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult> {
		const args = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];
		if (options?.modelOverride) {
			args.push("--model", options.modelOverride);
		}
		if (options?.engineArgs && options.engineArgs.length > 0) {
			args.push(...options.engineArgs);
		}

		args.push("-p", prompt);

		const outputLines: string[] = [];

		const { exitCode } = await execCommandStreaming(this.cliCommand, args, workDir, (line) => {
			outputLines.push(line);

			const step = detectStepFromOutput(line);
			if (step) {
				onProgress(step);
			}
		});

		const output = outputLines.join("\n");

		// Check for errors
		const error = checkForErrors(output);
		if (error) {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error,
			};
		}

		// Parse result
		const { response, inputTokens, outputTokens } = parseStreamJsonResult(output);

		// If command failed with non-zero exit code, provide a meaningful error
		if (exitCode !== 0) {
			return {
				success: false,
				response,
				inputTokens,
				outputTokens,
				error: formatCommandError(exitCode, output),
			};
		}

		return {
			success: true,
			response,
			inputTokens,
			outputTokens,
		};
	}
}
