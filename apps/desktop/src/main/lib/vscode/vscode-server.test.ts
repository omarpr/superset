import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VscodeServer } from "./vscode-server";

async function writeFakeCode(
	dir: string,
	script: string,
): Promise<{ command: string; env: NodeJS.ProcessEnv }> {
	const bin = path.join(dir, "code");
	await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return { command: bin, env: { PATH: dir } };
}

describe("VscodeServer", () => {
	it("emits 'ready' when stdout advertises a localhost URL", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-server-"));
		try {
			const { command, env } = await writeFakeCode(
				tmp,
				`printf 'Web UI available at http://127.0.0.1:12345/?tkn=abc\\n'; sleep 30`,
			);
			const server = new VscodeServer({
				command,
				worktreePath: tmp,
				port: 12345,
				env,
			});
			const url = await new Promise<string>((resolve, reject) => {
				server.once("ready", (info: { url: string }) => resolve(info.url));
				server.once("exit", () => reject(new Error("exited before ready")));
				void server.start();
			});
			expect(url).toBe("http://127.0.0.1:12345/?tkn=abc");
			server.stop();
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("passes --user-data-dir and --extensions-dir when provided", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-server-"));
		try {
			const argsLog = path.join(tmp, "args.log");
			const { command, env } = await writeFakeCode(
				tmp,
				`printf '%s\\n' "$@" > ${JSON.stringify(argsLog)}; printf 'http://127.0.0.1:12347/\\n'; sleep 30`,
			);
			const userDataDir = path.join(tmp, "user-data");
			const extensionsDir = path.join(tmp, "extensions");
			const server = new VscodeServer({
				command,
				worktreePath: tmp,
				port: 12347,
				env,
				userDataDir,
				extensionsDir,
			});
			await new Promise<void>((resolve, reject) => {
				server.once("ready", () => resolve());
				server.once("exit", () => reject(new Error("exited before ready")));
				void server.start();
			});
			const logged = await fs.readFile(argsLog, "utf8");
			const argLines = logged.split("\n");
			const userIdx = argLines.indexOf("--user-data-dir");
			const extIdx = argLines.indexOf("--extensions-dir");
			expect(userIdx).toBeGreaterThanOrEqual(0);
			expect(argLines[userIdx + 1]).toBe(userDataDir);
			expect(extIdx).toBeGreaterThan(userIdx);
			expect(argLines[extIdx + 1]).toBe(extensionsDir);
			server.stop();
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("emits 'exit' if the child quits before becoming ready", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-server-"));
		try {
			const { command, env } = await writeFakeCode(tmp, `exit 2`);
			const server = new VscodeServer({
				command,
				worktreePath: tmp,
				port: 12346,
				env,
			});
			const reason = await new Promise<{ code: number | null }>((resolve) => {
				server.once("exit", (info: { code: number | null }) => resolve(info));
				void server.start();
			});
			expect(reason.code).toBe(2);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
