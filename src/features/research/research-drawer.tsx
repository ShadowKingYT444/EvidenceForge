"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";

export function ResearchDrawer({
  open,
  title,
  kicker,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  kicker?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog className="research-drawer" ref={dialogRef} onClose={onClose} onCancel={onClose} aria-labelledby={titleId}>
      <header>
        <div>{kicker ? <span>{kicker}</span> : null}<h2 id={titleId}>{title}</h2></div>
        <button type="button" onClick={() => dialogRef.current?.close()} aria-label={`Close ${title}`}><X size={17} /></button>
      </header>
      <div className="research-drawer-body">{children}</div>
    </dialog>
  );
}
