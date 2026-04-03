import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import { IOP_DIR, PROGRESS_FILE } from "../config/loader.ts";
import { logTaskProgress } from "../config/writer.ts";
import type { AIEngine, AIResult } from "../engines/types.ts";
import { getCurrentBranch, returnToBaseBranch } from "../git/branch.ts";
import { syncPrdToIssue } from "../git/issue-sync.ts";
import {
	abortMerge,
	analyzePreMerge,
	deleteLocalBranch,
	mergeAgentBranch,
	sortByConflictLikelihood,
} from "../git/merge.ts";
import { cleanupAgentWorktree, createAgentWorktree, getWorktreeBase } from "../git/worktree.ts";
import type { Task, TaskSource } from "../tasks/types.ts";
import { formatDuration, logDebug, logError, logInfo, logSuccess, logWarn } from "../ui/logger.ts";
import { resolveConflictsWithAI } from "./conflict-resolution.ts";
import { clearDeferredTask, recordDeferredTask } from "./deferred.ts";
import { buildParallelPrompt } from "./prompt.ts";
import { isRetryableError, withRetry } from "./retry.ts";
import type { ExecutionOptions, ExecutionResult } from "./sequential.ts";

interface ParallelAgentResult {
	task: Task;
	agentNum: number;
	worktreeDir: string;
	branchName: string;
	result: AIResult | null;
	error?: string;
}

/**
 * Run a single agent in a worktree
 */
async function runAgentInWorktree(
	engine: AIEngine,
	task: Task,
	agentNum: number,
	baseBranch: string,
	worktreeBase: string,
	originalDir: string,
	prdSource: string,
	prdFile: string,
	prdIsFolder: boolean,
	maxRetries: number,
	retryDelay: number,
	skipTests: boolean,
	skipLint: boolean,
	modelOverride?: string,
	engineArgs?: string[],
): Promise<ParallelAgentResult> {
	let worktreeDir = "";
	let branchName = "";

	try {
		// Create worktree
		const worktree = await createAgentWorktree(
			task.title,
			agentNum,
			baseBranch,
			worktreeBase,
			originalDir,
		);
		worktreeDir = worktree.worktreeDir;
		branchName = worktree.branchName;

		logDebug(`Agent ${agentNum}: Created worktree at ${worktreeDir}`);

		// Copy PRD file or folder to worktree
		if (prdSource === "markdown" || prdSource === "yaml" || prdSource === "json") {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				copyFileSync(srcPath, destPath);
			}
		} else if (prdSource === "markdown-folder" && prdIsFolder) {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				cpSync(srcPath, destPath, { recursive: true });
			}
		}

		// Ensure .iop/ exists in worktree
		const iopDir = join(worktreeDir, IOP_DIR);
		if (!existsSync(iopDir)) {
			mkdirSync(iopDir, { recursive: true });
		}

		// Build prompt
		const prompt = buildParallelPrompt({
			task: task.title,
			progressFile: PROGRESS_FILE,
			prdFile,
			skipTests,
			skipLint,
		});

		// Execute with retry
		const engineOptions = {
			...(modelOverride && { modelOverride }),
			...(engineArgs && engineArgs.length > 0 && { engineArgs }),
		};
		const result = await withRetry(
			async () => {
				const res = await engine.execute(prompt, worktreeDir, engineOptions);
				if (!res.success && res.error && isRetryableError(res.error)) {
					throw new Error(res.error);
				}
				return res;
			},
			{ maxRetries, retryDelay },
		);

		return { task, agentNum, worktreeDir, branchName, result };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { task, agentNum, worktreeDir, branchName, result: null, error: errorMsg };
	}
}

/**
 * Run tasks in parallel using worktrees
 */
export async function runParallel(
	options: ExecutionOptions & {
		maxParallel: number;
		prdSource: string;
		prdFile: string;
		prdIsFolder?: boolean;
	},
): Promise<ExecutionResult> {
	const {
		engine,
		taskSource,
		workDir,
		skipTests,
		skipLint,
		dryRun,
		maxIterations,
		maxRetries,
		retryDelay,
		baseBranch,
		maxParallel,
		prdSource,
		prdFile,
		prdIsFolder = false,
		modelOverride,
		skipMerge,
		engineArgs,
		syncIssue,
	} = options;

	const result: ExecutionResult = {
		tasksCompleted: 0,
		tasksFailed: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
	};

	const isolationBase = getWorktreeBase(workDir);
	logDebug(`Worktree base: ${isolationBase}`);

	// Save starting branch to restore after merge phase
	const startingBranch = await getCurrentBranch(workDir);

	// Save original base branch for merge phase
	const originalBaseBranch = baseBranch || startingBranch;

	// Track completed branches for merge phase
	const completedBranches: string[] = [];

	// Global agent counter to ensure unique numbering across batches
	let globalAgentNum = 0;

	// Track processed tasks in dry-run mode (since we don't modify the source file)
	const dryRunProcessedIds = new Set<string>();

	// Process tasks in batches
	let iteration = 0;

	while (true) {
		// Check iteration limit
		if (maxIterations > 0 && iteration >= maxIterations) {
			logInfo(`Reached max iterations (${maxIterations})`);
			break;
		}

		// Get tasks for this batch
		let tasks: Task[] = [];

		const taskSourceWithGroups = taskSource as TaskSource & {
			getParallelGroup?: (title: string) => Promise<number>;
			getTasksInGroup?: (group: number) => Promise<Task[]>;
		};

		if (taskSourceWithGroups.getParallelGroup && taskSourceWithGroups.getTasksInGroup) {
			let nextTask = await taskSource.getNextTask();
			if (dryRun && nextTask && dryRunProcessedIds.has(nextTask.id)) {
				const allTasks = await taskSource.getAllTasks();
				nextTask = allTasks.find((task) => !dryRunProcessedIds.has(task.id)) || null;
			}
			if (!nextTask) break;

			const group = await taskSourceWithGroups.getParallelGroup(nextTask.title);
			if (group > 0) {
				tasks = await taskSourceWithGroups.getTasksInGroup(group);
				if (dryRun) {
					tasks = tasks.filter((task) => !dryRunProcessedIds.has(task.id));
				}
			} else {
				tasks = [nextTask];
			}
		} else {
			tasks = await taskSource.getAllTasks();
			if (dryRun) {
				tasks = tasks.filter((task) => !dryRunProcessedIds.has(task.id));
			}
		}

		if (tasks.length === 0) {
			logSuccess("All tasks completed!");
			break;
		}

		// Limit to maxParallel
		const batch = tasks.slice(0, maxParallel);
		iteration++;

		const batchStartTime = Date.now();
		logInfo(`Batch ${iteration}: ${batch.length} tasks in parallel`);

		if (dryRun) {
			logInfo("(dry run) Skipping batch");
			// Track processed tasks to avoid infinite loop
			for (const task of batch) {
				dryRunProcessedIds.add(task.id);
			}
			continue;
		}

		// Log task names being processed
		for (const task of batch) {
			logInfo(`  -> ${task.title}`);
		}

		// Run agents in parallel using worktrees
		const promises = batch.map((task) => {
			globalAgentNum++;

			return runAgentInWorktree(
				engine,
				task,
				globalAgentNum,
				baseBranch,
				isolationBase,
				workDir,
				prdSource,
				prdFile,
				prdIsFolder,
				maxRetries,
				retryDelay,
				skipTests,
				skipLint,
				modelOverride,
				engineArgs,
			);
		});

		const results = await Promise.all(promises);

		// Process results and collect worktrees for parallel cleanup
		let sawRetryableFailure = false;
		const worktreesToCleanup: Array<{ worktreeDir: string; branchName: string }> = [];

		for (const agentResult of results) {
			const { task, agentNum, worktreeDir, result: aiResult, error } = agentResult;
			const branchName = agentResult.branchName;
			let failureReason: string | undefined = error;
			let retryableFailure = false;

			if (failureReason) {
				retryableFailure = isRetryableError(failureReason);
				if (retryableFailure) {
					const deferrals = recordDeferredTask(taskSource.type, task, workDir, prdFile);
					if (deferrals >= maxRetries) {
						logError(`Task "${task.title}" failed after ${deferrals} deferrals: ${failureReason}`);
						logTaskProgress(task.title, "failed", workDir);
						result.tasksFailed++;
						await taskSource.markComplete(task.id);
						clearDeferredTask(taskSource.type, task, workDir, prdFile);
						retryableFailure = false;
					} else {
						logWarn(`Task "${task.title}" deferred (${deferrals}/${maxRetries}): ${failureReason}`);
						result.tasksFailed++;
					}
				} else {
					logError(`Task "${task.title}" failed: ${failureReason}`);
					logTaskProgress(task.title, "failed", workDir);
					result.tasksFailed++;

					// Mark failed task as complete to remove it from the queue
					await taskSource.markComplete(task.id);
					clearDeferredTask(taskSource.type, task, workDir, prdFile);
				}
			} else if (aiResult?.success) {
				logSuccess(`Task "${task.title}" completed`);
				result.totalInputTokens += aiResult.inputTokens;
				result.totalOutputTokens += aiResult.outputTokens;

				await taskSource.markComplete(task.id);
				logTaskProgress(task.title, "completed", workDir);
				result.tasksCompleted++;

				clearDeferredTask(taskSource.type, task, workDir, prdFile);

				// Track successful branch for merge phase
				if (branchName) {
					completedBranches.push(branchName);
				}
			} else {
				const errMsg = aiResult?.error || "Unknown error";
				retryableFailure = isRetryableError(errMsg);
				if (retryableFailure) {
					const deferrals = recordDeferredTask(taskSource.type, task, workDir, prdFile);
					if (deferrals >= maxRetries) {
						logError(`Task "${task.title}" failed after ${deferrals} deferrals: ${errMsg}`);
						logTaskProgress(task.title, "failed", workDir);
						result.tasksFailed++;
						failureReason = errMsg;
						await taskSource.markComplete(task.id);
						clearDeferredTask(taskSource.type, task, workDir, prdFile);
						retryableFailure = false;
					} else {
						logWarn(`Task "${task.title}" deferred (${deferrals}/${maxRetries}): ${errMsg}`);
						result.tasksFailed++;
						failureReason = errMsg;
					}
				} else {
					logError(`Task "${task.title}" failed: ${errMsg}`);
					logTaskProgress(task.title, "failed", workDir);
					result.tasksFailed++;
					failureReason = errMsg;

					// Mark failed task as complete to remove it from the queue
					await taskSource.markComplete(task.id);
					clearDeferredTask(taskSource.type, task, workDir, prdFile);
				}
			}

			// Collect worktree for parallel cleanup
			if (worktreeDir) {
				worktreesToCleanup.push({ worktreeDir, branchName });
			}

			if (retryableFailure) {
				sawRetryableFailure = true;
			}
		}

		// Cleanup all worktrees in parallel
		if (worktreesToCleanup.length > 0) {
			const cleanupResults = await Promise.all(
				worktreesToCleanup.map(({ worktreeDir, branchName }) =>
					cleanupAgentWorktree(worktreeDir, branchName, workDir).then((cleanup) => ({
						worktreeDir,
						leftInPlace: cleanup.leftInPlace,
					})),
				),
			);

			// Log any worktrees left in place
			for (const { worktreeDir, leftInPlace } of cleanupResults) {
				if (leftInPlace) {
					logInfo(`Worktree left in place (uncommitted changes): ${worktreeDir}`);
				}
			}
		}

		// Sync PRD to GitHub issue once per batch (after all tasks processed)
		if (syncIssue && prdFile && result.tasksCompleted > 0) {
			await syncPrdToIssue(prdFile, syncIssue, workDir);
		}

		// Log batch completion time
		const batchDuration = formatDuration(Date.now() - batchStartTime);
		logInfo(`Batch ${iteration} completed in ${batchDuration}`);
		// If any retryable failure occurred, stop the run to allow retry later
		if (sawRetryableFailure) {
			logWarn("Stopping early due to retryable errors. Try again later.");
			break;
		}
	}

	// Merge phase: merge completed branches back to base branch
	if (!skipMerge && !dryRun && completedBranches.length > 0) {
		const git = simpleGit(workDir);
		let stashed = false;
		try {
			const status = await git.status();
			const hasChanges = status.files.length > 0 || status.not_added.length > 0;
			if (hasChanges) {
				await git.stash(["push", "-u", "-m", "iop-merge-stash"]);
				stashed = true;
				logDebug("Stashed local changes before merge phase");
			}
		} catch (stashErr) {
			logWarn(`Failed to stash local changes: ${stashErr}`);
		}

		try {
			await mergeCompletedBranches(
				completedBranches,
				originalBaseBranch,
				engine,
				workDir,
				modelOverride,
				engineArgs,
			);

			// Restore starting branch if we're not already on it
			const currentBranch = await getCurrentBranch(workDir);
			if (currentBranch !== startingBranch) {
				logDebug(`Restoring starting branch: ${startingBranch}`);
				await returnToBaseBranch(startingBranch, workDir);
			}
		} finally {
			if (stashed) {
				try {
					await git.stash(["pop"]);
					logDebug("Restored stashed changes after merge phase");
				} catch (stashErr) {
					logWarn(`Failed to restore stashed changes: ${stashErr}`);
				}
			}
		}
	}

	return result;
}

/**
 * Merge completed branches back to the base branch.
 *
 * Optimized merge phase:
 * 1. Parallel pre-merge analysis (git diff doesn't require locks)
 * 2. Sort branches by conflict likelihood (merge clean ones first)
 * 3. Sequential merges (git locking requirement)
 * 4. Parallel branch deletion
 */
async function mergeCompletedBranches(
	branches: string[],
	targetBranch: string,
	engine: AIEngine,
	workDir: string,
	modelOverride?: string,
	engineArgs?: string[],
): Promise<void> {
	if (branches.length === 0) {
		return;
	}

	const mergeStartTime = Date.now();
	logInfo(`\nMerge phase: merging ${branches.length} branch(es) into ${targetBranch}`);

	// Stage 1: Parallel pre-merge analysis
	logDebug("Analyzing branches for potential conflicts...");
	const analyses = await Promise.all(
		branches.map((branch) => analyzePreMerge(branch, targetBranch, workDir)),
	);

	// Stage 2: Sort by conflict likelihood (merge clean ones first)
	const sortedAnalyses = sortByConflictLikelihood(analyses);
	const sortedBranches = sortedAnalyses.map((a) => a.branch);

	if (sortedBranches[0] !== branches[0]) {
		logDebug("Reordered branches to minimize conflicts");
	}

	// Stage 3: Sequential merges (git operations require this)
	const merged: string[] = [];
	const failed: string[] = [];

	for (const branch of sortedBranches) {
		const analysis = analyses.find((a) => a.branch === branch);
		const fileCount = analysis?.fileCount ?? 0;
		logInfo(`Merging ${branch}... (${fileCount} file${fileCount === 1 ? "" : "s"} changed)`);

		const mergeResult = await mergeAgentBranch(branch, targetBranch, workDir);

		if (mergeResult.success) {
			logSuccess(`Merged ${branch}`);
			merged.push(branch);
		} else if (mergeResult.hasConflicts && mergeResult.conflictedFiles) {
			// Try AI-assisted conflict resolution
			logWarn(`Merge conflict in ${branch}, attempting AI resolution...`);

			const resolved = await resolveConflictsWithAI(
				engine,
				mergeResult.conflictedFiles,
				branch,
				workDir,
				modelOverride,
				engineArgs,
			);

			if (resolved) {
				logSuccess(`Resolved conflicts and merged ${branch}`);
				merged.push(branch);
			} else {
				logError(`Failed to resolve conflicts for ${branch}`);
				await abortMerge(workDir);
				failed.push(branch);
			}
		} else {
			logError(`Failed to merge ${branch}: ${mergeResult.error || "Unknown error"}`);
			failed.push(branch);
		}
	}

	// Stage 4: Parallel branch deletion
	if (merged.length > 0) {
		const deleteResults = await Promise.all(
			merged.map(async (branch) => {
				const deleted = await deleteLocalBranch(branch, workDir, true);
				return { branch, deleted };
			}),
		);

		for (const { branch, deleted } of deleteResults) {
			if (deleted) {
				logDebug(`Deleted merged branch: ${branch}`);
			}
		}
	}

	// Summary
	const mergeDuration = formatDuration(Date.now() - mergeStartTime);
	if (merged.length > 0) {
		logSuccess(`Successfully merged ${merged.length} branch(es) in ${mergeDuration}`);
	}
	if (failed.length > 0) {
		logWarn(`Failed to merge ${failed.length} branch(es): ${failed.join(", ")}`);
		logInfo("These branches have been preserved for manual review.");
	}
}
