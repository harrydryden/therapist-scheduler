/**
 * API Client — barrel re-export file.
 *
 * All implementation has been split into domain-specific modules:
 *   core.ts        — Shared infrastructure (error classes, fetch wrappers, retry/dedup logic)
 *   appointments.ts — Appointment-related endpoints
 *   therapists.ts  — Therapist-related endpoints
 *   knowledge.ts   — Knowledge base endpoints
 *   settings.ts    — Settings endpoints
 *   ingestion.ts   — Therapist CV/PDF ingestion endpoints
 *   slack.ts       — Slack diagnostics endpoints
 *
 * This file re-exports everything so existing imports from 'api/client' continue to work.
 */

export * from './core';
export * from './appointments';
export * from './therapists';
export * from './knowledge';
export * from './settings';
export * from './ingestion';
export * from './slack';
export * from './vouchers';
