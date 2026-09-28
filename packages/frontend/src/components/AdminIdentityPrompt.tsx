import { useRef, useState } from 'react';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { MAX_ADMIN_NAME_LENGTH, normalizeAdminDisplayName } from '../utils/admin-id';

interface AdminIdentityPromptProps {
  initialName?: string | null;
  onSave: (name: string) => void;
  /** Present when changing an existing name (the first prompt can't be skipped). */
  onCancel?: () => void;
}

/**
 * Asks an admin once for the name shown to colleagues in "Taken by" and
 * in the audit trail (it used to be a random per-tab id).
 */
export default function AdminIdentityPrompt({ initialName, onSave, onCancel }: AdminIdentityPromptProps) {
  const [name, setName] = useState(initialName ?? '');
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, { onEscape: onCancel });
  const normalized = normalizeAdminDisplayName(name);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-identity-title"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-lg max-w-md w-full p-6"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (normalized) onSave(normalized);
          }}
        >
          <h2 id="admin-identity-title" className="text-lg font-semibold text-slate-900 mb-1">
            What should colleagues see as your name?
          </h2>
          <p className="text-sm text-slate-600 mb-4">
            Shown in &ldquo;Taken by&rdquo; when you take over a conversation and recorded in the audit trail.
            Saved in this browser.
          </p>
          <label htmlFor="admin-display-name" className="block text-sm font-medium text-slate-700 mb-1">
            Your name
          </label>
          <input
            id="admin-display-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_ADMIN_NAME_LENGTH}
            autoComplete="name"
            placeholder="e.g. Sam (Ops)"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
          />
          <div className="flex gap-3 justify-end mt-5">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 text-sm font-medium"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={!normalized}
              className="px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 text-sm font-medium"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
