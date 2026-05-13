# `core/` — Generic Kernel

Modules under `core/` are **domain-agnostic**. They have no dependency on
therapist-scheduling concepts (appointments, therapists, availability,
lifecycle status, voucher codes, …) and could be lifted into another
product on top of this codebase — most immediately, the planned ATS
extension.

## What belongs here

A module belongs in `core/` if all of the following are true:

1. It does not import from `core/../domain/` or from any service that
   models a scheduling concept.
2. Its types and function signatures use generic concepts
   (`Recipient`, `Message`, `Window`, `Token`, …) rather than
   scheduling-specific ones (`Appointment`, `Therapist`, `Booking`, …).
3. It would be roughly correct in an ATS context with at most a rename.

## What does not belong here

- The appointment lifecycle state machine
- Availability extraction / windows / formatter
- Therapist booking-status tracking, voucher issuance, post-booking
  follow-up
- Anything that reads `AppointmentRequest`, `Therapist.availability`,
  or related scheduling tables

Those live in `domain/scheduling/` (see `domain/README.md`).

## Layout

```
core/
  timezone/          IANA validation, DST-safe wall-clock resolution,
                     timezone resolution for users/therapists/recipients,
                     audit classifier, prompt-section fragment.
  messaging/         Email/message deduplication facade (Redis + DB).
                     More to follow: email send queue, classifier,
                     MIME parsing, polling primitives.
```

## Migration policy

Files are physically located here, not aliased. Imports throughout the
codebase point to `core/<module>` directly. Old re-export shims at the
previous paths are NOT kept — call sites are updated as part of each
consolidation PR.

The kernel boundary is enforced by code review, not yet by lint rules.
A follow-up will add an ESLint rule banning `core/**` files from
importing `domain/**` or `services/<scheduling-specific>.service`.
