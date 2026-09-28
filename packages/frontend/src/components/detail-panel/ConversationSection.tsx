/**
 * The appointment's recent conversation, oldest first — so an admin taking
 * over can read what was said before replying. It replaces the 240-char
 * "last action" snippet plus raw Gmail thread ids the drawer used to show.
 *
 * Entries come from the conversation log the agent keeps: 'Agent' is the
 * AI assistant's own notes of what it did, 'Inbound' an email from the
 * client or therapist (reduced to the new message), 'Admin' in-band admin
 * or system notes.
 */

import type { AppointmentDetail } from '../../types';
import { formatDateTime } from '../../utils/date-format';
import LastActionSection from './LastActionSection';

const ROLE_STYLES: Record<'agent' | 'admin' | 'inbound', { label: string; className: string }> = {
  agent: { label: 'Agent', className: 'bg-spill-blue-100 text-spill-blue-800' },
  admin: { label: 'Admin', className: 'bg-slate-200 text-slate-700' },
  inbound: { label: 'Inbound', className: 'bg-emerald-100 text-emerald-800' },
};

interface ConversationSectionProps {
  appointment: AppointmentDetail;
}

export default function ConversationSection({ appointment }: ConversationSectionProps) {
  const messages = appointment.recentMessages;
  // Older backends don't send the conversation; keep the last-action view.
  if (!Array.isArray(messages)) {
    return <LastActionSection preview={appointment.lastMessagePreview} />;
  }

  const total = appointment.totalMessages ?? messages.length;

  return (
    <section aria-labelledby="conversation-heading" className="px-4 py-3 border-b border-slate-100">
      <h3 id="conversation-heading" className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
        Conversation
        {total > messages.length && (
          <span className="normal-case tracking-normal font-normal text-slate-400">
            {' '}
            (last {messages.length} of {total})
          </span>
        )}
      </h3>

      {messages.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No messages yet.</p>
      ) : (
        <ol className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
          {messages.map((message, index) => {
            const style = ROLE_STYLES[message.role] ?? ROLE_STYLES.inbound;
            return (
              <li key={index} className="text-sm">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${style.className}`}>
                    {style.label}
                  </span>
                  {message.timestamp && (
                    <time dateTime={message.timestamp} className="text-[11px] text-slate-400">
                      {formatDateTime(message.timestamp)} (UK)
                    </time>
                  )}
                </div>
                <p className="text-slate-700 leading-snug whitespace-pre-wrap break-words">
                  {message.text}
                  {message.truncated && <span className="text-slate-400"> (shortened)</span>}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
