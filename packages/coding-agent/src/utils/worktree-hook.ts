/**
 * The `post-checkout` hook of worktrees omp creates for `/wt`, `github` `pr_checkout` and
 * `omp worktree add`: running it as `git worktree add` does, describing the outcome for display,
 * and discarding a new worktree whose setup was cut short.
 */
import * as fs from "node:fs/promises";
import type { VcsGitRepo, VcsWorktreeAddOptions, VcsWorktreeAddResult } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { filterChildShellEnv, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayWarning, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";

/** Display lines for a new worktree's `post-checkout` hook; both unset when it ran cleanly or there is none. */
export interface WorktreeCheckoutHookResult {
	/** The hook ran and failed: exit status and its last output line. */
	error?: string;
	/** The hook exists but did not run; see {@link vcs.SkippedPostCheckoutHook} for the reasons. */
	skipped?: string;
}

/**
 * Width left for a hook warning after the longest lead-in a caller puts before it (`/wt` shows
 * "Warning: Worktree created, but …"), so the whole rendered line stays within one display line.
 */
const WARNING_WIDTH = TRUNCATE_LENGTHS.LINE - Bun.stringWidth("Warning: Worktree created, but ");

const displayLine = (text: string, width = WARNING_WIDTH) => truncateToWidth(sanitizeDisplayWarning(text), width);

/** Warning line for a `post-checkout` hook that exists but did not run; sanitized and home-shortened. Only the path is cut, never the reason. */
export function describeSkippedHook(skipped: vcs.SkippedPostCheckoutHook): string {
	const why = {
		"not-executable": "is not executable, so git skipped it",
		"no-git": "did not run: no working git found",
		"old-git": "did not run: running hooks needs Git 2.36 or newer",
		inaccessible: "did not run: it could not be read",
	}[skipped.reason];
	const lead = "post-checkout hook ";
	return `${lead}${displayLine(skipped.path, WARNING_WIDTH - Bun.stringWidth(`${lead} ${why}`))} ${why}`;
}

/** The hook's warnings, failure first; each completes "Worktree created, but …". */
export function worktreeHookWarnings(hook: WorktreeCheckoutHookResult | undefined): string[] {
	return [hook?.error, hook?.skipped].filter(warning => warning !== undefined);
}

/**
 * Run a new linked worktree's `post-checkout` hook, as `git worktree add` does, without the
 * agent's own `GIT_DIR`-family variables and in its own session, so a prompt on the terminal
 * fails instead of writing into the TUI. Lines are sanitized, home-shortened and truncated for
 * display. Aborting `signal` stops the hook and rejects.
 */
export async function runWorktreeCheckoutHook(
	worktreeRoot: string,
	head: string,
	signal?: AbortSignal,
): Promise<WorktreeCheckoutHookResult> {
	const env = filterChildShellEnv(process.env);
	const hook = await vcs.runPostCheckoutHook(worktreeRoot, head, { signal, env, detached: true });
	const result: WorktreeCheckoutHookResult = {};
	if (hook.skipped) result.skipped = describeSkippedHook(hook.skipped);
	if (hook.exitCode !== 0) {
		const decoder = new TextDecoder();
		const output = sanitizeText(`${decoder.decode(hook.stdout)}\n${decoder.decode(hook.stderr)}`).trim();
		const last = output.split("\n").at(-1);
		// Composed first, then truncated as a whole, so the exit status always counts against the line limit.
		result.error = displayLine(
			last
				? `post-checkout hook exited with ${hook.exitCode}: ${last}`
				: `post-checkout hook exited with ${hook.exitCode}`,
		);
	}
	return result;
}

/** A worktree {@link addWorktreeWithHook} created, and its hook's outcome. */
export interface WorktreeSetup {
	added: VcsWorktreeAddResult;
	hook: WorktreeCheckoutHookResult;
}

/**
 * Add a linked worktree of `branch` at the unused `worktreePath`, then run its `post-checkout`
 * hook. If the hook stage fails or `signal` aborts, the worktree is discarded and `branch` put
 * back where the checkout left it, so a retry starts over instead of reusing a half-set-up
 * checkout or finding the branch diverged. A failed `worktreeAdd` discards nothing: another
 * process may own the path by then.
 */
export async function addWorktreeWithHook(
	repository: VcsGitRepo,
	worktreePath: string,
	branch: string,
	options: VcsWorktreeAddOptions,
	signal?: AbortSignal,
): Promise<WorktreeSetup> {
	signal?.throwIfAborted();
	// No signal: the native checkout runs to completion regardless, and an abort-rejected call would
	// not say whether this attempt created the worktree.
	const added = await repository.worktreeAdd(worktreePath, branch, options);
	let head: string | null | undefined;
	try {
		signal?.throwIfAborted();
		head = await repository.resolveRef(`refs/heads/${branch}`, signal);
		const hook = head ? await runWorktreeCheckoutHook(worktreePath, head, signal) : {};
		// An abort that lands as the hook finishes still cancels: the caller must not move into the worktree.
		signal?.throwIfAborted();
		return { added, hook };
	} catch (error) {
		await discardNewWorktree(repository, worktreePath);
		if (head) await restoreBranch(repository, branch, head);
		throw error;
	}
}

/**
 * Remove a worktree this attempt's own `worktreeAdd` created. When it is no longer discoverable
 * (its `.git` file is gone), deletes the directory and prunes the registration that now points
 * nowhere. Takes no signal, as the caller's may already be aborted; failures are logged, not
 * thrown, so the original error reaches the caller.
 */
async function discardNewWorktree(repository: VcsGitRepo, worktreePath: string): Promise<void> {
	try {
		if (await repository.worktreeRemove(worktreePath, true)) return;
		await fs.rm(worktreePath, { recursive: true, force: true });
		await repository.worktreePrune();
	} catch (error) {
		logger.warn("could not remove a worktree whose setup was cut short", {
			path: worktreePath,
			error: String(error),
		});
	}
}

/** Put `branch` back at `head` if a cut-short hook committed to it. Failures are logged. */
async function restoreBranch(repository: VcsGitRepo, branch: string, head: string): Promise<void> {
	try {
		const now = await repository.resolveRef(`refs/heads/${branch}`);
		if (now && now !== head) await repository.createBranch(branch, head, true);
	} catch (error) {
		logger.warn("could not restore a branch moved by a cut-short post-checkout hook", {
			branch,
			error: String(error),
		});
	}
}
