import type { AppointmentDetail } from '../../types';
import StatusBadge from '../StatusBadge';
import { formatDateTime } from '../../utils/date-format';

interface DetailHeaderProps {
  appointment: AppointmentDetail;
}

/** Open a Gmail thread (works for whoever is signed in to the scheduling mailbox). */
function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

export default function DetailHeader({ appointment }: DetailHeaderProps) {
  return (
    <div className="p-4 border-b border-slate-100">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="font-semibold text-slate-900">
            {appointment.userName || 'Unknown User'}
          </h2>
          <p className="text-sm text-slate-500">{appointment.userEmail}</p>
          {appointment.trackingCode && (
            <p className="text-xs text-slate-400 font-mono mt-0.5">{appointment.trackingCode}</p>
          )}
        </div>
        <StatusBadge status={appointment.status} />
      </div>
      {appointment.emailVerified === false && (
        <div className="mt-3 p-2.5 bg-spill-yellow-100 border border-spill-yellow-200 rounded-lg text-xs text-slate-700">
          Waiting for the client to confirm their email address. Nothing has been sent to the therapist yet; the
          request is deleted if it isn't confirmed within 24 hours.
        </div>
      )}
      <div className="mt-3 text-sm text-slate-600">
        <p>
          <span className="font-medium">Therapist:</span> {appointment.therapistName}
        </p>
        <p>
          <span className="font-medium">Email:</span> {appointment.therapistEmail}
        </p>
      </div>
      {appointment.confirmedAt && (
        <div className="mt-3 p-3 bg-green-50 rounded-lg border border-green-200">
          <p className="text-sm font-medium text-green-700">
            {/* Appointment time: prefer the human-readable string, then the
                parsed instant rendered in UK time. Never fall back to
                confirmedAt — that's WHEN the booking was confirmed, not when
                the session is, and labelling it "Confirmed:" misled admins. */}
            Confirmed: {appointment.confirmedDateTime
              || (appointment.confirmedDateTimeParsed
                ? `${formatDateTime(appointment.confirmedDateTimeParsed)} (UK)`
                : 'time not recorded')}
          </p>
          <p className="text-xs text-green-600 mt-1">
            on {formatDateTime(appointment.confirmedAt)} (UK)
          </p>
        </div>
      )}
      {(appointment.gmailThreadId || appointment.therapistGmailThreadId) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {appointment.gmailThreadId && (
            <a
              href={gmailThreadUrl(appointment.gmailThreadId)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-spill-blue-800 hover:underline"
            >
              Client thread in Gmail
            </a>
          )}
          {appointment.therapistGmailThreadId && (
            <a
              href={gmailThreadUrl(appointment.therapistGmailThreadId)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-spill-blue-800 hover:underline"
            >
              Therapist thread in Gmail
            </a>
          )}
        </div>
      )}
    </div>
  );
}
