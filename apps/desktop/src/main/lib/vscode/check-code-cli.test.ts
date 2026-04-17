import { describe, expect, it } from "bun:test";
import { isCodeCliAvailable } from "./check-code-cli";

describe("isCodeCliAvailable", () => {
	it("returns false when PATH contains no resolvable 'code' binary", async () => {
		const result = await isCodeCliAvailable({ PATH: "/nonexistent/dir" });
		expect(result).toBe(false);
	});

	it("returns true when given a PATH that contains a 'code' executable", async () => {
		// Create a temp dir with an executable named "code"
		const fs = await import("node:fs/promises");
		const os = await import("node:os");
		const path = await import("node:path");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-cli-"));
		const bin = path.join(
			dir,
			process.platform === "win32" ? "code.cmd" : "code",
		);
		await fs.writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		try {
			const result = await isCodeCliAvailable({ PATH: dir });
			expect(result).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
