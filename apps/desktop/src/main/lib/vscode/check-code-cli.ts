import { access, constants } from "node:fs/promises";
import path from "node:path";
import { getProcessEnvWithShellPath } from "../../../lib/trpc/routers/workspaces/utils/shell-env";

const BINARY_NAMES =
	process.platform === "win32" ? ["code.cmd", "code.exe"] : ["code"];

/**
 * Returns true if the `code` binary is resolvable on PATH.
 * Accepts an optional env override so tests can pin a PATH deterministically.
 */
export async function isCodeCliAvailable(
	envOverride?: NodeJS.ProcessEnv,
): Promise<boolean> {
	const env = envOverride ?? (await getProcessEnvWithShellPath());
	const rawPath = env.PATH ?? env.Path ?? "";
	if (!rawPath) return false;

	const sep = process.platform === "win32" ? ";" : ":";
	for (const dir of rawPath.split(sep)) {
		if (!dir) continue;
		for (const name of BINARY_NAMES) {
			try {
				await access(path.join(dir, name), constants.X_OK);
				return true;
			} catch {
				// try next candidate
			}
		}
	}
	return false;
}
