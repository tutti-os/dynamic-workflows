import {
  useEffect,
  useState,
  type ComponentProps,
} from "react";
import {
  Button,
  CheckIcon,
  CopyIcon,
} from "@tutti-os/ui-system";
import { writeClipboardText } from "@/components/workflow/workflowClientUtils";

type CopyToClipboardButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "onClick" | "onCopy" | "type"
> & {
  text?: string;
  label?: string;
  copiedLabel?: string;
  copied?: boolean;
  resetDelayMs?: number;
  onCopyText?: () => void | Promise<void>;
};

export function CopyToClipboardButton(props: CopyToClipboardButtonProps) {
  const {
    text,
    label = "Copy",
    copiedLabel = "Copied",
    copied,
    resetDelayMs = 1600,
    onCopyText,
    ...buttonProps
  } = props;
  const [internalCopied, setInternalCopied] = useState(false);
  const isCopied = copied ?? internalCopied;

  useEffect(() => {
    if (copied !== undefined || !internalCopied) {
      return;
    }
    const timeout = window.setTimeout(
      () => setInternalCopied(false),
      resetDelayMs,
    );
    return () => window.clearTimeout(timeout);
  }, [copied, internalCopied, resetDelayMs]);

  async function copyText() {
    if (text !== undefined) {
      await writeClipboardText(text);
    }
    await onCopyText?.();
    if (copied === undefined) {
      setInternalCopied(true);
    }
  }

  return (
    <Button {...buttonProps} type="button" onClick={() => void copyText()}>
      {isCopied ? (
        <CheckIcon data-icon="inline-start" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {isCopied ? copiedLabel : label}
    </Button>
  );
}
