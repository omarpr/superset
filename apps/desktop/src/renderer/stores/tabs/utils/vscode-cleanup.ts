import { electronTrpcClient } from "../../../lib/trpc-client";

/**
 * Tears down the main-process `code serve-web` process and WebContentsView
 * associated with a vscode pane. Uses the standalone tRPC client so we don't
 * depend on React context — `removePane`/`removeTab` run outside components.
 */
export const killVscodeForPane = (paneId: string): void => {
	electronTrpcClient.vscode.stop.mutate({ paneId }).catch((error) => {
		console.warn(`Failed to stop vscode server for pane ${paneId}:`, error);
	});
};
