import type {
	VcsCloneOptions,
	VcsGitRepo,
	VcsGitRepoInfo,
	VcsHunkSelection,
	VcsHunkSelectionError,
	VcsJjWorkspace,
	VcsRepo,
} from "./index.js";
/** Portable capabilities that differ between Git and Jujutsu. */
export type VcsFeature = "stagedDiff" | "revDiff";

/**
 * A native VCS failure: a real `Error` constructed by the Rust layer on the
 * JS thread, carrying a machine-readable `code` and the CLI result fields.
 * Non-CLI failures synthesize `exitCode: 1` and mirror `message` into
 * `stderr`. Identify with {@link isVcsError} — `instanceof` cannot work for
 * foreign-constructed errors.
 */
export interface VcsError extends Error {
	name: "VcsError";
	code:
		| "NotARepository"
		| "RefNotFound"
		| "ObjectNotFound"
		| "EmptyCherryPick"
		| "Conflict"
		| "PatchFailed"
		| "Cli"
		| "CliTimeout"
		| "Io"
		| "Backend"
		| "Canceled"
		| "Unsupported"
		| "OutputTooLarge";
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** True when `error` is a native VCS failure. */
export declare function isVcsError(error: unknown): error is VcsError;

/** True when a cherry-pick failed because the commit is already applied. */
export declare function isEmptyCherryPick(error: unknown): error is VcsError & { code: "EmptyCherryPick" };

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export declare function git(dir: string): VcsGitRepo | null;
/** Discover the repository owning `dir`; `null` outside any repository. */
export declare function repo(dir: string): VcsRepo | null;
/** Like {@link repo}, but equal-root jj+git ties prefer Jujutsu for display. Git-safe automation must keep using {@link repo}. */
export declare function repoForDisplay(dir: string): VcsRepo | null;

/** Like {@link repo}, asserting any requested backend capabilities. */
export declare function require(dir: string, ...features: VcsFeature[]): VcsRepo;

/** Like {@link git}, but throws a `NotARepository` {@link VcsError}. */
export declare function requireGit(dir: string): VcsGitRepo;

/** Repository metadata only (cheap fs walk) — for synchronous render paths. */
export declare function gitInfo(dir: string): VcsGitRepoInfo | null;

/** Discover the Jujutsu workspace containing `dir`; `null` when absent. */
export declare function jj(dir: string): VcsJjWorkspace | null;

/** Whether jj is the nearest VCS ancestor, making git automation unsafe. */
export declare function isPureJj(dir: string): boolean;

/** Clone a repository (git CLI under the hood for credential parity). */
export declare function clone(
	url: string,
	target: string,
	options?: VcsCloneOptions,
	signal?: AbortSignal,
): Promise<void>;

/** Sever a copied working tree from shared git metadata. */
export declare function detachGitDir(
	worktreeRoot: string,
	sourceCommonDir: string,
	signal?: AbortSignal,
): Promise<"no-git" | "independent" | "detached">;

/** Preserve isolation-local Git objects in the source without changing its refs or index. */
export declare function copyGitObjects(isolationRoot: string, sourceRoot: string): Promise<void>;

/** A `post-checkout` hook that exists but did not run, and why. */
export interface SkippedPostCheckoutHook {
	path: string;
	/** `no-git`: no git starts, or `git version` fails. `old-git`: older than 2.36, without `git hook run`. `inaccessible`: checking the hook file failed other than with ENOENT/ENOTDIR. */
	reason: "not-executable" | "no-git" | "old-git" | "inaccessible";
}

/**
 * Run Git's checkout hook in a new linked worktree and return its exit status and the
 * last 64 KiB of each output stream. The git on `env`'s PATH locates the hook
 * (`git rev-parse --git-path`), seeing every config source; without a git that starts and
 * answers, the in-process lookup (`core.hooksPath`, path expanded, or the shared hooks
 * directory) does, so no git binary is needed when there is no hook. On Windows a
 * `post-checkout.exe` counts too, as in git. Only a missing path means no hook; anything else
 * there goes to git. The hook runs through `git hook run`, so, like hooks git runs itself and
 * unlike `git worktree add`'s, it sees `GIT_DIR` set to the new worktree's git dir. Returns
 * once `git hook run` exits, even if the hook left a background process running. `skipped` is
 * set when the hook exists but did not run: not executable (POSIX only), no working git on
 * PATH, a git older than 2.36, or a hook file that can't be checked. `env` replaces the
 * inherited environment; pass one without ambient `GIT_DIR`-family variables. `detached`
 * (POSIX) runs the hook, and the git calls that locate it, in their own session, without the
 * caller's controlling terminal, so a prompt on /dev/tty fails instead of writing into a TUI.
 * Aborting `signal` kills the hook's process tree (on Windows, commands MSYS `sh` started
 * through its fork stubs can survive) and rejects with the abort reason, also while a
 * filesystem check or a read is stalled; a `signal` implies `detached`.
 */
export declare function runPostCheckoutHook(
	worktreeRoot: string,
	head: string,
	options?: { signal?: AbortSignal; env?: Record<string, string>; detached?: boolean },
): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array; skipped?: SkippedPostCheckoutHook }>;

/** Join patch fragments, preserving each part's trailing newline. */
export declare function joinPatches(parts: string[]): string;

/** Validate hunk selections against a raw diff. */
export declare function validateHunkSelections(
	rawDiff: string,
	selections: VcsHunkSelection[],
): VcsHunkSelectionError[];

/** Stat-poll interval for {@link watch}. */
export declare const HEAD_WATCH_INTERVAL_MS: number;

/** Watch a repository for head changes; returns a disposer. */
export declare function watch(repo: VcsRepo, onChange: () => void, intervalMs?: number): () => void;
