import DOMPurify from 'dompurify';
import type { AppointmentDetail } from '../../types';
import { APP } from '../../config/constants';

function sanitizeText(text: string): string {
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [] });
}

const senderLabel: Record<string, string> = {
  client: 'Client',
  therapist: 'Therapist',
  agent: APP.COORDINATOR_NAME,
  admin: 'Admin (Human)',
};

const senderStyle: Record<string, string> = {
  client: 'bg-slate-100 border border-slate-200',
  therapist: 'bg-violet-50 border border-violet-100',
  agent: 'bg-primary-50 border border-primary-100',
  admin: 'bg-orange-50 border border-orange-100',
};

const labelStyle: Record<string, string> = {
  client: 'text-slate-600',
  therapist: 'text-violet-600',
  agent: 'text-primary-600',
  admin: 'text-orange-600',
};

// Show client and therapist first, then agent, then admin
const senderOrder = ['client', 'therapist', 'agent', 'admin'];

interface ConversationSectionProps {
  conversation: AppointmentDetail['conversation'];
}

export default function ConversationSection({ conversation }: ConversationSectionProps) {
  if (!conversation || conversation.latestMessages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-4 max-h-[450px]">
        <h3 className="font-medium text-slate-700 mb-3">Latest Messages</h3>
        <p className="text-slate-500 text-sm">No conversation history</p>
      </div>
    );
  }

  const sorted = [...conversation.latestMessages].sort(
    (a, b) => senderOrder.indexOf(a.senderType) - senderOrder.indexOf(b.senderType)
  );

  return (
    <div className="flex-1 overflow-y-auto p-4 max-h-[450px]">
      <h3 className="font-medium text-slate-700 mb-3">Latest Messages</h3>
      <div className="space-y-3">
        {sorted.map((msg) => (
          <div
            key={msg.senderType}
            className={`p-3 rounded-lg ${senderStyle[msg.senderType] || 'bg-slate-100 border border-slate-200'}`}
          >
            <p className={`text-xs font-medium mb-1 ${labelStyle[msg.senderType] || 'text-slate-500'}`}>
              {senderLabel[msg.senderType] || msg.senderType}
            </p>
            <p className="text-sm text-slate-800 whitespace-pre-wrap line-clamp-6">
              {sanitizeText(msg.content)}
            </p>
          </div>
        ))}
        <p className="text-xs text-slate-400 text-center">
          {conversation.totalMessageCount} total messages in conversation
        </p>
      </div>
    </div>
  );
}
