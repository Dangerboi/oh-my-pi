import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadNative } from "./loader-state.js";

let native;
function api() {
	native ??= loadNative();
	return native;
}
function vcsError(code, message) {
	const error = new Error(message);
	error.name = "VcsError";
	error.code = code;
	error.exitCode = 1;
	error.stdout = "";
	error.stderr = message;
	return error;
}

/**
 * True when `error` is a native VCS failure. The native layer constructs these
 * on the JS thread as real `Error` objects with `name: "VcsError"`, a
 * machine-readable `code`, and `exitCode`/`stdout`/`stderr` properties — an
 * `instanceof` check is impossible for foreign-constructed errors, so identity
 * rides on `name`.
 */
export function isVcsError(error) {
	return error instanceof Error && error.name === "VcsError";
}

/** True when a cherry-pick failed because the commit is already applied. */
export function isEmptyCherryPick(error) {
	return isVcsError(error) && error.code === "EmptyCherryPick";
}

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export function git(dir) {
	return api().vcsGitDiscover(dir);
}
/** Discover the repository owning `dir`; `null` outside any repository. */
export function repo(dir) {
	return api().vcsDiscover(dir);
}

/** Like {@link repo}, but equal-root jj+git ties prefer Jujutsu for display. Git-safe automation must keep using {@link repo}. */
export function repoForDisplay(dir) {
	return api().vcsDiscoverForDisplay(dir);
}

/** Like {@link repo}, asserting any requested backend capabilities. */
export function require(dir, ...features) {
	const discovered = repo(dir);
	if (!discovered) throw vcsError("NotARepository", `not a repository: ${dir}`);
	for (const feature of features) {
		if (!discovered.supports(feature)) {
			throw vcsError(
				"Unsupported",
				`\`${feature}\` is not supported on a ${discovered.kind()} repository`,
			);
		}
	}
	return discovered;
}

/** Like {@link git}, but throws a `NotARepository` VcsError. */
export function requireGit(dir) {
	const repo = git(dir);
	if (!repo) {
		throw vcsError("NotARepository", `not a repository: ${dir}`);
	}
	return repo;
}

/** Repository metadata only (cheap fs walk) — for synchronous render paths. */
export function gitInfo(dir) {
	return api().vcsGitRepoInfo(dir);
}

/** Discover the Jujutsu workspace containing `dir`; `null` when absent. */
export function jj(dir) {
	return api().vcsJjDiscover(dir);
}

/** Whether jj is the nearest VCS ancestor, making git automation unsafe. */
export function isPureJj(dir) {
	return api().vcsIsPureJj(dir);
}

/** Clone a repository (git CLI under the hood for credential parity). */
export function clone(url, target, options = {}, signal) {
	return api().vcsGitClone(url, target, options, signal);
}

/** Sever a copied working tree from shared git metadata. */
export function detachGitDir(worktreeRoot, sourceCommonDir, signal) {
	return api().vcsDetachGitDir(worktreeRoot, sourceCommonDir, signal);
}

/**
 * Publish `from` at `to` only once fully written: copy to a sibling temp name,
 * then hard-link it into place (Git's own `finalize_object_file` strategy) so
 * readers never see a partial file and an interrupted copy leaves only a
 * `tmp_` file that `git gc` prunes. An existing `to` was itself published
 * whole and holds the same content-addressed bytes, so it is kept.
 */
async function publishGitObjectFile(from, to) {
	const tmp = path.join(path.dirname(to), `tmp_obj_omp_${crypto.randomUUID()}`);
	try {
		await fs.promises.copyFile(from, tmp, fs.constants.COPYFILE_EXCL);
		try {
			await fs.promises.link(tmp, to);
		} catch (error) {
			if (error?.code === "EEXIST") return;
			// Filesystems without hard links: rename is still atomic, and any
			// file it replaces holds identical content-addressed bytes.
			if (error?.code !== "EPERM" && error?.code !== "ENOTSUP" && error?.code !== "EXDEV") throw error;
			await fs.promises.rename(tmp, to);
		}
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
}

/**
 * Keep objects created in an isolated Git repository reachable after its
 * worktree is removed, without changing the destination's refs or index.
 * Every file is published atomically; a pack is published before its index.
 */
export async function copyGitObjects(isolationRoot, sourceRoot) {
	const from = path.join(requireGit(isolationRoot).info().commonDir, "objects");
	const to = path.join(requireGit(sourceRoot).info().commonDir, "objects");
	for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
		await fs.promises.mkdir(path.join(to, entry.name), { recursive: true });
		for (const name of await fs.promises.readdir(path.join(from, entry.name))) {
			if (!/^[0-9a-f]{38,62}$/.test(name)) continue;
			await publishGitObjectFile(path.join(from, entry.name, name), path.join(to, entry.name, name));
		}
	}
	const packs = (await fs.promises.readdir(path.join(from, "pack"))).filter(name => name.startsWith("pack-"));
	await fs.promises.mkdir(path.join(to, "pack"), { recursive: true });
	// The index must only become visible after the pack it describes.
	for (const name of packs.filter(name => name.endsWith(".pack"))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
	for (const name of packs.filter(name => /\.(?:idx|rev|keep|promisor|mtimes)$/.test(name))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
}

/** Bytes kept from the end of each of the hook's output streams. */
const HOOK_OUTPUT_TAIL_BYTES = 64 * 1024;
const HOOK_CAPTURE_PREFIX = "omp-post-checkout-";
/**
 * Where pids mean the same: hostname, plus on Linux the boot and pid namespace, so containers
 * sharing a hostname and the TMPDIR but not their pids (a pod's sidecars) differ too. Read from
 * /proc, which never stalls. Each part on its own: a missing one (no /proc, an AppArmor profile
 * denying `boot_id`) must not take the others with it.
 */
function pidScope() {
	const scope = [os.hostname()];
	if (process.platform === "linux") {
		for (const read of [
			() => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
			() => fs.readlinkSync("/proc/self/ns/pid"),
		]) {
			try {
				scope.push(read());
			} catch {
				scope.push("");
			}
		}
	}
	return scope.join("\0");
}
/**
 * This process's pid scope as a tag. Pids only identify processes within one scope, so what
 * another host or container left behind is never judged by them.
 */
const PID_SCOPE = Bun.hash(pidScope()).toString(36);
/** A capture directory of this pid scope, with the pid of the omp process that created it. */
const HOOK_CAPTURE_OWNED = new RegExp(`^${HOOK_CAPTURE_PREFIX}${PID_SCOPE}-(\\d+)-`);

/** Whether process `pid` still exists (EPERM: it does, under another user). */
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/** This process as the owner of a worktree setup (`setupOwner` of `worktreeAdd`). */
export function worktreeSetupOwner() {
	return `${PID_SCOPE}-${process.pid}`;
}

/**
 * Whether the owner of a worktree setup may still be running it: its process exists, or it is
 * in another pid scope (another host or container), where this process can't tell.
 */
export function isWorktreeSetupOwnerAlive(owner) {
	const match = /^(.+)-(\d+)$/.exec(owner);
	if (match?.[1] !== PID_SCOPE) return true;
	return processAlive(Number(match[2]));
}

/**
 * Delete this host's capture directories whose omp process is gone: it crashed or was killed
 * before its own cleanup, or (Windows) a background process the hook left running kept the files
 * open then. A run in progress is never touched, however long it takes: its omp is alive.
 * shortcut: a pid reused by an unrelated process keeps its leftover until that process exits, fine for a few small directories.
 */
async function sweepStaleHookCaptures() {
	const tmp = os.tmpdir();
	for (const name of await fs.promises.readdir(tmp).catch(() => [])) {
		const pid = Number(HOOK_CAPTURE_OWNED.exec(name)?.[1]);
		if (!(pid > 0) || processAlive(pid)) continue;
		await fs.promises.rm(path.join(tmp, name), { recursive: true, force: true }).catch(() => {});
	}
}

/** Oldest Git with `git hook run`. */
const HOOK_RUN_MIN_GIT = [2, 36];

/** Settle with `promise`, or reject with the abort reason as soon as `signal` aborts. */
async function untilAborted(promise, signal) {
	if (!signal) return promise;
	// Observed even when the abort wins, so its later failure never goes unhandled.
	promise.catch(() => {});
	const aborted = Promise.withResolvers();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		signal.throwIfAborted();
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Open `file` for a child's output, raced against the abort. Asynchronous, unlike handing
 * `Bun.spawn` a `BunFile`, which opens it on the JS thread, where a stalled TMPDIR would block it.
 */
async function openCapture(file, signal) {
	const opening = fs.promises.open(file, "w");
	try {
		return await untilAborted(opening, signal);
	} catch (error) {
		// Opened after the abort: close it once it is.
		opening.then(handle => handle.close(), () => {});
		throw error;
	}
}

/**
 * Up to `maxBytes` of a capture file, from its start or (`fromEnd`) its end, read through a file
 * handle off the JS thread and raced against the abort. A missing file reads as empty.
 */
function readCapture(file, maxBytes, { fromEnd = false, signal } = {}) {
	const read = async () => {
		let handle;
		try {
			handle = await fs.promises.open(file, "r");
		} catch (error) {
			if (error?.code === "ENOENT") return new Uint8Array();
			throw error;
		}
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, maxBytes);
			const bytes = new Uint8Array(length);
			const { bytesRead } = await handle.read(bytes, 0, length, fromEnd ? size - length : 0);
			return bytes.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	};
	return untilAborted(read(), signal);
}

/**
 * Run `git <args>` with output to the files `stdout`/`stderr` (paths, or "ignore") and resolve with
 * its exit code. Aborting `signal` kills its process tree, descendants that left its process group
 * included (see the shortcut below), and rejects with the reason. Throws `ENOENT` when no git is on
 * `env`'s PATH. `detached` runs it in its own session even without a signal (POSIX), away from the
 * caller's terminal.
 */
async function runGitToFiles(args, { cwd, env, stdout = "ignore", stderr = "ignore", signal, detached = false }) {
	const posix = process.platform !== "win32";
	const handles = [];
	const sink = async file => {
		if (file === "ignore") return file;
		const handle = await openCapture(file, signal);
		handles.push(handle);
		return handle.fd;
	};
	try {
		const out = await sink(stdout);
		const err = await sink(stderr);
		// No await between this check and the abort listener below, so no abort can be missed.
		signal?.throwIfAborted();
		const child = Bun.spawn(["git", ...args], {
			cwd,
			env,
			stdin: "ignore",
			stdout: out,
			stderr: err,
			// Own session (setsid): an abort can stop what it spawned, e.g. `npm install`, and without a controlling
			// terminal a prompt on /dev/tty fails instead of writing into the caller's TUI.
			detached: posix && (detached || signal !== undefined),
		});
		// Pin the root now: killTree walks its descendants by parent, so it also reaches one that left the
		// process group (setsid), and on Windows, which has no process groups, finds them at all.
		// shortcut: a descendant that double-forks out to init escapes, as do commands MSYS `sh` starts through fork
		// stubs on Windows (taskkill /T misses them too), upgrade to ptree's Linux subreaper / a Job Object if hooks
		// that daemonize must be stopped.
		const root = signal ? api().Process.fromPid(child.pid) : null;
		const onAbort = () => {
			// killTree snapshots the descendants, then signals the root's process group, the descendants and the root;
			// the group kill after it covers a root that had exited before it could be pinned.
			try {
				if (posix) root?.killTree(9);
				else root?.killTree();
			} catch {
				// Already exited.
			}
			try {
				if (posix) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already exited.
			}
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		let exitCode;
		try {
			exitCode = await child.exited;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		signal?.throwIfAborted();
		return exitCode;
	} finally {
		// Our copies only; the child (and anything it left running) holds its own. Not awaited, like the capture cleanup.
		for (const handle of handles) void handle.close().catch(() => {});
	}
}

/** Spawn errors meaning the `git` on PATH cannot start: missing, not a runnable binary, or not executable. */
const GIT_CANNOT_START = new Set(["ENOENT", "ENOEXEC", "EACCES"]);

/** Bytes read from a probe's output: enough for a version line or a path, bounded for noisy wrappers. */
const PROBE_OUTPUT_BYTES = 4096;

/**
 * Run `git <args>` for its output: written to a file in `captureDir`, so a wrapper's lingering
 * child cannot hold it back, and read up to {@link PROBE_OUTPUT_BYTES}. Null when no git starts
 * or the command fails.
 */
async function gitProbe(args, captureDir, cwd, { env, signal, detached }) {
	const outPath = path.join(captureDir, args[0]);
	try {
		const exitCode = await runGitToFiles(args, { cwd, env, stdout: outPath, signal, detached });
		if (exitCode !== 0) return null;
	} catch (error) {
		if (GIT_CANNOT_START.has(error?.code)) return null;
		throw error;
	}
	return new TextDecoder().decode(await readCapture(outPath, PROBE_OUTPUT_BYTES, { signal }));
}

/**
 * Whether the git on `env`'s PATH can run hooks: "no-git" when none starts or `git version`
 * fails, "old-git" when it predates `git hook run`, else undefined.
 */
async function hookRunnerProblem(captureDir, cwd, gitOptions) {
	const version = await gitProbe(["version"], captureDir, cwd, gitOptions);
	if (version === null) return "no-git";
	const match = /^git version (\d+)\.(\d+)/.exec(version);
	// An unrecognised version string gets the benefit of the doubt.
	if (!match) return undefined;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	const [minMajor, minMinor] = HOOK_RUN_MIN_GIT;
	return major < minMajor || (major === minMajor && minor < minMinor) ? "old-git" : undefined;
}

/**
 * Where git looks for the `post-checkout` hook. The git on `env`'s PATH answers whenever it can,
 * since only it sees every config source (wrappers, distribution system config, `-c` and
 * environment overrides). Without a git that starts and answers, the in-process lookup (`find_hook`
 * rules) stands, so a hook it finds is reported as not run rather than treated as missing.
 */
async function postCheckoutHookPath(captureDir, worktreeRoot, gitOptions) {
	const answer = await gitProbe(["rev-parse", "--git-path", "hooks/post-checkout"], captureDir, worktreeRoot, gitOptions);
	// Only the line break git ends it with: a relative `core.hooksPath` may start or end with spaces.
	const reported = answer?.replace(/\r?\n$/, "");
	// Nothing usable (no answer, empty, or an MSYS/Cygwin `/c/…` path on Windows; `//server/share` UNC paths are fine).
	if (!reported || (process.platform === "win32" && reported.startsWith("/") && !reported.startsWith("//"))) {
		// Discovery reads the repository too: off the JS thread, raced against the abort like the rest.
		const location = api().vcsGitHookLocation(worktreeRoot, "post-checkout", gitOptions.signal);
		return (await untilAborted(location, gitOptions.signal)) ?? undefined;
	}
	// A relative result is relative to the worktree, where `git hook run` runs.
	return path.resolve(worktreeRoot, reported);
}

/**
 * Run Git's checkout hook in a newly created linked worktree, using the same
 * null old HEAD and branch-switch flag as `git worktree add`. Git locates the
 * hook; without a usable git the in-process lookup does, so no git binary is
 * needed when there is no hook. Returns once `git hook run` exits, even if the
 * hook left a background process running, with the last 64 KiB of each output
 * stream; `skipped` says why an existing hook did not run. Aborting
 * `options.signal` kills the hook's process tree and rejects with the reason, also while a
 * lookup, a file check or a read is stalled (starting git still happens on this thread).
 */
export async function runPostCheckoutHook(worktreeRoot, head, options = {}) {
	const { signal, env, detached } = options;
	signal?.throwIfAborted();
	const notRun = { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
	const posix = process.platform !== "win32";
	// Awaited, raced against the abort: a stalled TMPDIR holds the run up until then, as `mkdtemp` would.
	await untilAborted(sweepStaleHookCaptures(), signal);
	// Files, not pipes: a background process git or the hook starts inherits them, and pipes would stay open until it exits.
	const removeCapture = dir => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
	// Host and pid let a later run tell this directory from one whose omp process is gone.
	const creating = fs.promises.mkdtemp(
		path.join(os.tmpdir(), `${HOOK_CAPTURE_PREFIX}${PID_SCOPE}-${process.pid}-`),
	);
	let dir;
	try {
		dir = await untilAborted(creating, signal);
	} catch (error) {
		// Aborted while a stalled TMPDIR was still creating it: remove it once it exists.
		creating.then(removeCapture, () => {});
		throw error;
	}
	const gitOptions = { env, signal, detached };
	try {
		const foundAt = await postCheckoutHookPath(dir, worktreeRoot, gitOptions);
		if (!foundAt) return notRun;
		// Only a missing path means no hook; any other failure (EACCES, EIO) is reported, not mistaken for one.
		const missing = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";
		const statHook = file =>
			untilAborted(
				fs.promises.stat(file).catch(error => (missing(error) ? null : error)),
				signal,
			);
		let hookPath = foundAt;
		let stat = await statHook(hookPath);
		// Git for Windows' `find_hook` also takes the name with `.exe` appended.
		if (!posix && stat === null) {
			const exeStat = await statHook(`${foundAt}.exe`);
			if (exeStat !== null) [hookPath, stat] = [`${foundAt}.exe`, exeStat];
		}
		if (stat instanceof Error) return { ...notRun, skipped: { path: hookPath, reason: "inaccessible" } };
		// Anything else there, even a directory, isn't missing: git tries to run it and reports the failure.
		if (stat === null) return notRun;
		// Git's own `access(X_OK)` check; Git for Windows ignores the bit.
		if (posix) {
			const access = fs.promises.access(hookPath, fs.constants.X_OK).then(
				() => true,
				() => false,
			);
			if (!(await untilAborted(access, signal))) {
				return { ...notRun, skipped: { path: hookPath, reason: "not-executable" } };
			}
		}
		const reason = await hookRunnerProblem(dir, worktreeRoot, gitOptions);
		if (reason) return { ...notRun, skipped: { path: hookPath, reason } };
		const outPath = path.join(dir, "stdout");
		const errPath = path.join(dir, "stderr");
		const nullOid = "0".repeat(head.length);
		const exitCode = await runGitToFiles(["hook", "run", "--ignore-missing", "post-checkout", "--", nullOid, head, "1"], {
			cwd: worktreeRoot,
			env,
			stdout: outPath,
			stderr: errPath,
			signal,
			detached,
		});
		const tail = file => readCapture(file, HOOK_OUTPUT_TAIL_BYTES, { fromEnd: true, signal });
		const [stdout, stderr] = await Promise.all([tail(outPath), tail(errPath)]);
		return { exitCode, stdout, stderr };
	} finally {
		// Not awaited: a stalled TMPDIR must not hold up the result or an abort. A lingering child may still hold the files open on Windows; leave them for the OS then.
		void removeCapture(dir);
	}
}

/** Join patch fragments, preserving each part's trailing newline. */
export function joinPatches(parts) {
	return api().vcsJoinPatches(parts);
}

/** Validate hunk selections against a raw diff. */
export function validateHunkSelections(rawDiff, selections) {
	return api().vcsValidateHunkSelections(rawDiff, selections);
}

/** Stat-poll interval for {@link watch}. */
export const HEAD_WATCH_INTERVAL_MS = 1000;

/**
 * Watch a repository for head changes; returns a disposer.
 *
 * Stat-polls via `fs.watchFile` instead of `fs.watch`: backends may atomically
 * replace the watched entry, permanently silencing inotify-backed watchers.
 */
export function watch(repo, onChange, intervalMs = HEAD_WATCH_INTERVAL_MS) {
	const target = repo.watchTarget();
	const listener = (curr, prev) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
	};
	fs.watchFile(target, { interval: intervalMs }, listener).unref();
	return () => fs.unwatchFile(target, listener);
}
