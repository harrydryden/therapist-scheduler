import { useRef, type ReactNode } from 'react';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface ModalFrameProps {
  onClose: () => void;
  /** Classes for the dialog panel itself. */
  className?: string;
  /** Accessible name for the dialog. */
  ariaLabel?: string;
  children: ReactNode;
}

/**
 * Backdrop + dialog panel for the admin modals: click-outside and Esc
 * close it, focus moves in on open, Tab stays inside, and focus returns
 * to the opener on close.
 */
export default function ModalFrame({ onClose, className = '', ariaLabel, children }: ModalFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogA11y(ref, { onEscape: onClose });
  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`outline-none ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
