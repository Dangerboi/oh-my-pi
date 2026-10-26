import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

describe.skipIf(process.platform === "win32")("worktree add checkout hooks", () => {
	let root: string;
	let repo: string;
	let hooks: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-hook-"));
		repo = path.join(root, "repo");
		await $`git init -q ${repo}`.quiet();
		await $`git -C ${repo} -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit --allow-empty -qm probe`.quiet();
		hooks = path.join(repo, ".git", "hooks");
		await $`git -C ${repo} config core.hooksPath ${hooks}`.quiet();
		await Bun.write(path.join(repo, "local-probe.txt"), "untracked file to exercise clone fallback\n");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function hook(script: string): Promise<void> {
		const file = path.join(hooks, "post-checkout");
		await Bun.write(file, `#!/bin/sh\n${script}\n`);
		await fs.chmod(file, 0o755);
	}

	async function add(name: string) {
		const worktree = path.join(root, name);
		const result = await $`bun ${cli} worktree add --detach ${worktree} HEAD`.cwd(repo).quiet().nothrow();
		return { worktree, result };
	}

	it("runs post-checkout in the new worktree after clone or plain-checkout fallback", async () => {
		await hook('printf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran; echo hook-output');
		const { worktree, result } = await add("linked");
		const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
		const marker = (await Bun.file(path.join(worktree, ".post-checkout-ran")).text()).trim().split("\n");

		expect(result.exitCode).toBe(0);
		expect(marker).toEqual([worktree, "0".repeat(head.length), head, "1"]);
		expect(result.stderr.toString()).toContain("hook-output");
	});

	it("exits 1 with a warning and keeps the worktree when git cannot be launched for the hook", async () => {
		const worktree = path.join(root, "nogit");
		const bunDir = path.join(root, "bin");
		await fs.mkdir(bunDir);
		await fs.symlink(process.execPath, path.join(bunDir, "bun"));
		const result = await $`${process.execPath} ${cli} worktree add --detach ${worktree} HEAD`
			.cwd(repo)
			.env({ ...process.env, PATH: bunDir })
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("warning:");
		expect((await fs.stat(worktree)).isDirectory()).toBe(true);
	});

	it("preserves a refusing hook's failure status and stderr", async () => {
		await hook("echo checkout-refused >&2; exit 17");
		const { result } = await add("refused");

		expect(result.exitCode).toBe(17);
		expect(result.stderr.toString()).toContain("checkout-refused");
	});

	it("preserves the status when git hook run itself dies of a signal", async () => {
		await hook("kill -TERM $PPID");
		const { worktree, result } = await add("signalled");

		expect(result.exitCode).toBe(143);
		expect((await fs.stat(worktree)).isDirectory()).toBe(true);
	});

	it("returns promptly with a failing hook's status when it leaves a background process holding its output", async () => {
		const pidFile = path.join(root, "bg.pid");
		await hook(`sleep 30 &\necho $! > "${pidFile}"\nexit 3`);
		try {
			const started = performance.now();
			const { worktree, result } = await add("background");
			const elapsed = performance.now() - started;

			expect(result.exitCode).toBe(3);
			expect(elapsed).toBeLessThan(10_000);
			expect((await fs.stat(worktree)).isDirectory()).toBe(true);
		} finally {
			const pid = Number.parseInt(
				await Bun.file(pidFile)
					.text()
					.catch(() => ""),
				10,
			);
			if (Number.isInteger(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	}, 15_000);

	it("delivers all hook output to a slow stderr consumer after the hook exits", async () => {
		const bytes = 20_000_000;
		await hook(`head -c ${bytes} /dev/zero | tr '\\0' '\\1' >&2`);
		// The consumer is a real pipe reader that starts late; a stalled OS pipe is the scenario, so no fake timers.
		const script = '"$0" "$1" worktree add --detach "$2" HEAD 2>&1 | { sleep 2; tr -cd "\\001" | wc -c; }';
		const result = await $`sh -c ${script} ${process.execPath} ${cli} ${path.join(root, "slow")}`
			.cwd(repo)
			.quiet()
			.nothrow();
		expect(Number.parseInt(result.stdout.toString().trim(), 10)).toBe(bytes);
	}, 30_000);

	// Real child processes and signals: the polls below wait on OS state, which fake timers cannot drive.
	it("stops the hook when the terminal's process group receives Ctrl-C", async () => {
		const pidFile = path.join(root, "hook.pid");
		await hook(`echo $$ > "${pidFile}"\nsleep 30`);
		const child = Bun.spawn(["bun", cli, "worktree", "add", "--detach", path.join(root, "interrupted"), "HEAD"], {
			cwd: repo,
			detached: true,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		let pid = Number.NaN;
		try {
			const pollDeadline = Date.now() + 10_000;
			while (Date.now() < pollDeadline && !Number.isInteger(pid)) {
				const text = await Bun.file(pidFile)
					.text()
					.catch(() => "");
				const parsed = Number.parseInt(text, 10);
				if (Number.isInteger(parsed)) pid = parsed;
				else await Bun.sleep(50);
			}
			expect(Number.isInteger(pid)).toBe(true);

			process.kill(-child.pid, "SIGINT");

			const alive = () => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			const goneDeadline = Date.now() + 5_000;
			while (Date.now() < goneDeadline && alive()) await Bun.sleep(50);
			expect(alive()).toBe(false);
		} finally {
			if (Number.isInteger(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Group already gone.
			}
		}
	}, 20_000);
});
