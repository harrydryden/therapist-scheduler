import { useId, useRef, type ReactNode } from 'react';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  isPending?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  isPending = false,
  disabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmStyles = confirmVariant === 'danger'
    ? 'bg-red-600 text-white hover:bg-red-700'
    : 'bg-slate-900 text-white hover:bg-slate-800';

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus moves in on open (once — never stealing it back from a field the
  // user is typing in), Tab stays inside, Esc cancels without also closing
  // a drawer behind the dialog, and focus returns to the trigger on close.
  useDialogA11y(dialogRef, { onEscape: isPending ? undefined : onCancel });

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-lg max-w-md w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
      >
        <h3 id={titleId} className="text-lg font-semibold text-slate-900 mb-2">{title}</h3>
        <div className="mb-6">{children}</div>
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending || disabled}
            aria-busy={isPending}
            className={`px-4 py-2 rounded-lg transition-colors disabled:opacity-50 text-sm font-medium ${confirmStyles}`}
          >
            {isPending ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
