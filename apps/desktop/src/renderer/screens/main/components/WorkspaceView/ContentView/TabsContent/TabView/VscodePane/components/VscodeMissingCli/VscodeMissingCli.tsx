import { Button } from "@superset/ui/button";
import { electronTrpcClient } from "renderer/lib/trpc-client";

const DOCS_URL = "https://code.visualstudio.com/docs/editor/command-line";

export function VscodeMissingCli() {
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
			<h2 className="text-sm font-medium text-foreground">
				VS Code command line tool not found
			</h2>
			<p className="max-w-md text-xs text-muted-foreground">
				This tab embeds VS Code by running <code>code serve-web</code> locally.
				Install VS Code and make sure the <code>code</code> command is on your{" "}
				<code>PATH</code>, then reopen this tab.
			</p>
			<Button
				variant="outline"
				size="sm"
				onClick={() => {
					void electronTrpcClient.external.openUrl.mutate(DOCS_URL);
				}}
			>
				Open install instructions
			</Button>
		</div>
	);
}
