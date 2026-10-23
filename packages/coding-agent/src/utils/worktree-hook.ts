/**
 * The `post-checkout` hook of worktrees omp creates for `/wt`, `github` `pr_checkout` and
 * `omp worktree add`: running it as `git worktree add` does, describing the outcome for display,
 * and discarding a new worktree whose setup was cut short.
 */
import * as fs from "node:fs/promises";
import type { VcsGitRepo, VcsWorktreeAddOptions, VcsWorktreeAddResult, VcsWorktreeEntry } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { filterChildShellEnvAsync, logger, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
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
	// Its dotenv reads off the JS thread, raced against the abort like the hook itself.
	const env = await filterChildShellEnvAsync(process.env, undefined, signal);
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

/** A worktree {@link addWorktreeWithHook} created, its resolved path, and its hook's outcome. */
export interface WorktreeSetup {
	added: VcsWorktreeAddResult;
	/** `worktreePath` with symlinks resolved. */
	path: string;
	hook: WorktreeCheckoutHookResult;
	/**
	 * Short name (no `refs/heads/`) of the branch the worktree is on once set up: the requested
	 * `branch`, or the one a hook renamed it to with `git branch -m`.
	 */
	branch: string;
}

/**
 * `worktreePath` with symlinks resolved, raced against `signal`, so a stalled filesystem (e.g. a
 * `worktree.base` on a network mount) cannot outlast an abort.
 */
export function resolveWorktreePath(worktreePath: string, signal?: AbortSignal): Promise<string> {
	// A function, not a started lookup: on an already-aborted signal it never runs, so its failure can't go unhandled.
	return untilAborted(signal, () => fs.realpath(worktreePath));
}

/** The post-checkout hook removed the new worktree; its path and branch may be another process's by now. */
export class WorktreeRemovedByHookError extends Error {
	constructor(worktreePath: string) {
		super(`The post-checkout hook removed the new worktree at ${worktreePath}; it was not set up`);
		this.name = "WorktreeRemovedByHookError";
	}
}

/**
 * Add a linked worktree of `branch` at the unused `worktreePath` (the hook may move it; the
 * returned path is where it ended up), then run its `post-checkout`
 * hook. Until the hook is done the worktree carries this process's setup mark, so another omp
 * process does not take it over (`pr_checkout` would reuse it); git commands, the hook's
 * included, see it as `git worktree add` leaves it. If the hook stage fails or `signal` aborts
 * before the setup mark is removed, the worktree is discarded and `branch` put back where the
 * checkout left it, so a retry starts over instead of reusing a half-set-up checkout or finding
 * the branch diverged. A branch the hook renamed the new branch to is deleted and the original
 * put back, but only when its reflog shows that rename and it did not exist before the hook. The discard itself takes no signal and runs to completion. A failed
 * `worktreeAdd` discards nothing: another process may own the path by then. If the hook removed
 * the worktree, the call fails with {@link WorktreeRemovedByHookError} and touches neither the path
 * nor the branch, which another process may have taken since.
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
	const setupOwner = vcs.worktreeSetupOwner();
	const added = await repository.worktreeAdd(worktreePath, branch, { ...options, setupOwner });
	let head: string | null | undefined;
	// Local branches before the hook ran: a branch absent from it was created by the hook.
	let branchesBefore: Set<string> | undefined;
	// A hook may move its worktree, as under `git worktree add`; everything after it uses the current path.
	let current = worktreePath;
	let gitDir: string | undefined;
	// Set once the hook is known to have removed the worktree: its path and branch may be another process's by now.
	let gone = false;
	try {
		// The branch is still the checked-out one here; the hook may rename it or move the worktree, not the git dir.
		const listed = await untilAborted(signal, () => repository.worktrees());
		gitDir = listed.find(entry => entry.branch === `refs/heads/${branch}`)?.gitDir;
		signal?.throwIfAborted();
		head = await repository.resolveRef(`refs/heads/${branch}`, signal);
		branchesBefore = new Set(await untilAborted(signal, () => repository.listBranches(false)));
		const hook = head ? await runWorktreeCheckoutHook(worktreePath, head, signal) : {};
		// Raced like the path lookup below, so an abort rejects with its reason.
		const located = await currentWorktreeEntry(repository, gitDir, signal);
		if (located === undefined) {
			gone = true;
			throw new WorktreeRemovedByHookError(worktreePath);
		}
		current = located?.path ?? current;
		const setUpBranch = located ? await adoptedBranch(repository, branch, located, signal) : branch;
		// The abort may also have landed as the hook finished: either way, or with a stalled `worktree.base`,
		// the caller must not move into the worktree, so it is discarded below.
		const resolved = await resolveWorktreePath(current, signal);
		// The commit point: with the mark gone another omp process may reuse the worktree, so an abort from
		// here on is too late to discard it, as one just after the return would be.
		if (gitDir === undefined) {
			await repository.worktreeEndSetup(current).catch(error => {
				// Set up all the same; other omp processes only wait for it until this one exits.
				logger.warn("could not mark a new worktree as set up", { path: current, error: String(error) });
			});
		} else {
			// By saved identity, never by path: a replacement at this path carries another process's mark.
			const cleared = await repository.worktreeReplaceSetupOwner(gitDir, setupOwner, null).catch(error => {
				logger.warn("could not mark a new worktree as set up", { path: current, error: String(error) });
				return true;
			});
			if (!cleared) {
				gone = true;
				throw new WorktreeRemovedByHookError(worktreePath);
			}
		}
		return { added, path: resolved, hook, branch: setUpBranch };
	} catch (error) {
		let hookBranch: string | undefined;
		if (!gone) {
			// The hook may have moved the worktree before it was cut short; discard where it is now.
			try {
				const located = await currentWorktreeEntry(repository, gitDir);
				if (located === undefined) gone = true;
				else {
					current = located?.path ?? current;
					if (located && !located.detached && located.branch?.startsWith("refs/heads/")) {
						hookBranch = located.branch.slice("refs/heads/".length);
					}
				}
			} catch (lookupError) {
				logger.warn("could not locate a new worktree its hook may have moved", {
					path: current,
					error: String(lookupError),
				});
			}
		}
		if (gone) {
			logger.warn("a new worktree was removed by its post-checkout hook; leaving its path and branch alone", {
				path: worktreePath,
				branch,
			});
		} else {
			await discardNewWorktree(repository, current, gitDir, setupOwner);
			if (gitDir !== undefined && branchesBefore && hookBranch !== undefined) {
				await deleteRenamedBranch(repository, branch, hookBranch, branchesBefore);
			}
			if (head) await restoreBranch(repository, branch, head);
		}
		throw error;
	}
}

/**
 * The listing entry of the registration `gitDir`, or `null` when `gitDir` is undefined (nothing to
 * look up). When `gitDir` is listed nowhere the worktree is gone (the hook deleted it) and the
 * result is `undefined`: its path may by now belong to another process. The git directory survives
 * `git worktree move` and a branch rename.
 */
async function currentWorktreeEntry(
	repository: VcsGitRepo,
	gitDir: string | undefined,
	signal?: AbortSignal,
): Promise<VcsWorktreeEntry | null | undefined> {
	if (gitDir === undefined) return null;
	const listed = await untilAborted(signal, () => repository.worktrees());
	return listed.find(entry => entry.gitDir === gitDir);
}

/**
 * The branch a set-up worktree is on: `branch`, unless a hook renamed it (`refs/heads/<branch>` is
 * gone and the worktree is on another branch), in which case the new short name.
 */
async function adoptedBranch(
	repository: VcsGitRepo,
	branch: string,
	entry: VcsWorktreeEntry,
	signal?: AbortSignal,
): Promise<string> {
	const prefix = "refs/heads/";
	if (entry.detached || !entry.branch?.startsWith(prefix) || entry.branch === `${prefix}${branch}`) return branch;
	if (await repository.refExists(`${prefix}${branch}`, signal)) return branch;
	return entry.branch.slice(prefix.length);
}

/**
 * Remove a worktree this attempt's own `worktreeAdd` created, or, when it is no longer
 * discoverable (its `.git` file is gone), delete its directory. A native removal deletes the
 * registration with its setup mark; after the directory fallback the mark is cleared by
 * compare-and-swap on `gitDir` and `owner`, never by path, which another process may have reused
 * by then. If it could not be removed, it keeps the mark: it stays owned by this live process, so
 * other omp processes do not reuse the half-set-up checkout. Takes no signal, as the caller's may
 * already be aborted; failures are logged, not thrown, so the original error reaches the caller.
 */
async function discardNewWorktree(
	repository: VcsGitRepo,
	worktreePath: string,
	gitDir: string | undefined,
	owner: string,
): Promise<void> {
	const warn = (error: unknown) =>
		logger.warn("could not remove a worktree whose setup was cut short", {
			path: worktreePath,
			error: String(error),
		});
	let removed: boolean;
	try {
		removed = await repository.worktreeRemove(worktreePath, true);
		if (!removed) await fs.rm(worktreePath, { recursive: true, force: true });
	} catch (error) {
		warn(error);
		return;
	}
	try {
		if (!removed) {
			if (gitDir === undefined) await repository.worktreeEndSetup(worktreePath);
			else await repository.worktreeReplaceSetupOwner(gitDir, owner, null);
		}
		await repository.worktreePrune();
	} catch (error) {
		warn(error);
	}
}

/** Put `branch` back at `head` if a cut-short hook moved or deleted it. Failures are logged. */
async function restoreBranch(repository: VcsGitRepo, branch: string, head: string): Promise<void> {
	try {
		const now = await repository.resolveRef(`refs/heads/${branch}`);
		if (now !== head) await repository.createBranch(branch, head, true);
	} catch (error) {
		logger.warn("could not restore a branch moved by a cut-short post-checkout hook", {
			branch,
			error: String(error),
		});
	}
}

/**
 * Delete `renamed`, the branch a cut-short hook renamed `branch` to, once its worktree is gone. Only
 * when `branch` no longer exists, `renamed` is not in `before` (the hook created it), and the reflog
 * of `renamed` shows the hook renamed `branch` to it, so a branch that existed earlier or that
 * another process created is never deleted. Failures are logged.
 */
async function deleteRenamedBranch(
	repository: VcsGitRepo,
	branch: string,
	renamed: string,
	before: ReadonlySet<string>,
): Promise<void> {
	if (renamed === branch || before.has(renamed)) return;
	try {
		if (await repository.refExists(`refs/heads/${branch}`)) return;
		if (!(await repository.branchRenamedFrom(renamed, branch))) {
			logger.warn(
				"a branch the cut-short hook left the worktree on is kept: no rename from the original in its reflog",
				{ branch: renamed, original: branch },
			);
			return;
		}
		if (!(await repository.deleteBranch(renamed, true))) {
			logger.warn("could not delete a branch a cut-short post-checkout hook renamed", { branch: renamed });
		}
	} catch (error) {
		logger.warn("could not delete a branch a cut-short post-checkout hook renamed", {
			branch: renamed,
			error: String(error),
		});
	}
}
