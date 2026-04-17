import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";

interface VscodeDisableConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	vscodePaneCount: number;
}

export function VscodeDisableConfirmDialog({
	open,
	onOpenChange,
	onConfirm,
	vscodePaneCount,
}: VscodeDisableConfirmDialogProps) {
	const tabWord = vscodePaneCount === 1 ? "tab" : "tabs";

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="max-w-[340px] gap-0 p-0">
				<AlertDialogHeader className="px-4 pt-4 pb-2">
					<AlertDialogTitle className="font-medium">
						Disable VS Code (Beta)?
					</AlertDialogTitle>
					<AlertDialogDescription>
						{vscodePaneCount} open VS Code {tabWord} will be closed.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter className="px-4 pb-4 pt-2 flex-row justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-3 text-xs"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<AlertDialogAction
						variant="destructive"
						size="sm"
						className="h-7 px-3 text-xs"
						onClick={onConfirm}
					>
						Disable
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
