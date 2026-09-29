import type { AppointmentListItem } from '../types';
import { HEALTH_LABELS } from '../config/color-mappings';

/** Screen-reader name for a row: who, with whom, and its health (the dot alone is colour). */
export function appointmentRowLabel(appointment: AppointmentListItem): string {
  const health = HEALTH_LABELS[appointment.healthStatus] ?? HEALTH_LABELS.green;
  const unconfirmed = appointment.emailVerified === false ? ', client email not yet confirmed' : '';
  return `Open appointment for ${appointment.userName || appointment.userEmail} with ${appointment.therapistName}. Health: ${health}${unconfirmed}`;
}
