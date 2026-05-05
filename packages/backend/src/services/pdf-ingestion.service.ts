import pdf from 'pdf-parse';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import {
  APPROACH_OPTIONS,
  STYLE_OPTIONS,
  AREAS_OF_FOCUS_OPTIONS,
  type TherapistCategories,
} from '../config/therapist-categories';
import { aiService } from './ai.service';
import { prisma } from '../utils/database';
import { generateUniqueTherapistId } from '../utils/unique-id';
import { logger } from '../utils/logger';
import { parseJsonFromLLMResponse } from '../utils/json-parser';
import { getDefaultTimezone, getCountryLabel } from '@therapist-scheduler/shared';
import type { CategoryWithEvidence, ExtractedTherapistProfile, AdminNotes } from '@therapist-scheduler/shared';

// Re-export for consumers
export type { CategoryWithEvidence, ExtractedTherapistProfile, AdminNotes };

interface IngestionResult {
  success: boolean;
  therapistId?: string;
  /** Legacy field — was the URL of the created Notion page. Always undefined post-Notion-deprecation. */
  notionUrl?: string;
  extractedData?: ExtractedTherapistProfile;
  error?: string;
}

/**
 * Resolve the IANA timezone the AI should stamp on extracted availability.
 * Prefers an explicit override, then the country's single timezone (when
 * unambiguous), then the system default. Multi-timezone countries (US, CA, AU)
 * fall through to the system default — the admin must override the timezone
 * manually since we can't infer the right region from a CV.
 */
function resolveExtractionTimezone(country?: string, override?: string): string {
  if (override) return override;
  const fromCountry = getDefaultTimezone(country);
  if (fromCountry) return fromCountry;
  return config.timezone;
}

// Build extraction prompt dynamically to include configured timezone and category options
function buildExtractionPrompt(timezone: string, country?: string): string {
  // Build detailed category descriptions with explainers
  const approachDescriptions = APPROACH_OPTIONS.map((o) => `"${o.type}" - ${o.explainer}`).join('\n  ');
  const styleDescriptions = STYLE_OPTIONS.map((o) => `"${o.type}" - ${o.explainer}`).join('\n  ');
  const areasOfFocusDescriptions = AREAS_OF_FOCUS_OPTIONS.map((o) => `"${o.type}" - ${o.explainer}`).join('\n  ');

  const countryHint = country
    ? `\n\nThe therapist is based in ${getCountryLabel(country)}. Treat any times you find as expressed in their LOCAL time and stamp the availability with the timezone above.`
    : '';

  return `You are an expert at extracting structured information from therapist profiles, CVs, job applications, and descriptive text.

Analyze the following text and extract the therapist's profile information. The text may be from a CV/PDF or from a free-text description provided by an admin.${countryHint}

Return a JSON object with these fields:
{
  "name": "Full name of the therapist",
  "email": "Email address",
  "bio": "A professional bio paragraph (150-300 words) summarizing their background, approach, and experience. Write this in third person.",
  "approach": [
    {"type": "Category Name", "evidence": "quoted text from source...", "reasoning": "why this maps to category"}
  ],
  "style": [
    {"type": "Category Name", "evidence": "quoted text from source...", "reasoning": "why this maps to category"}
  ],
  "areasOfFocus": [
    {"type": "Category Name", "evidence": "quoted text from source...", "reasoning": "why this maps to category"}
  ],
  "availability": {
    "timezone": "${timezone}",
    "slots": [
      {"day": "Monday", "start": "09:00", "end": "17:00"}
    ]
  },
  "qualifications": ["List of qualifications and certifications"],
  "yearsExperience": number or null
}

CATEGORY EVIDENCE FORMAT:
For each category you select, provide:
- "type": The exact category name from the options below
- "evidence": A direct quote (max 100 chars) from the source text that supports this categorization
- "reasoning": Brief explanation (max 50 chars) of why this quote maps to this category

=== APPROACH OPTIONS (therapeutic methods/tools used) ===
  ${approachDescriptions}

=== STYLE OPTIONS (how they work with clients) ===
  ${styleDescriptions}

=== AREAS OF FOCUS OPTIONS (specific issues they specialize in) ===
  ${areasOfFocusDescriptions}

CATEGORY MAPPING GUIDELINES - BE SPECIFIC AND DISCERNING:

=== APPROACH (therapeutic methods - require EXPLICIT mention of technique) ===
- "Cognitive & Behavioural (CBT)": ONLY if they explicitly mention CBT, cognitive therapy, cognitive behavioural therapy, or describe structured thought/behaviour change work. Do NOT assign for general "talking therapy" or counselling.
- "Mindfulness": ONLY if they specifically mention mindfulness-based techniques, MBCT, MBSR, meditation practices, or breathing exercises as a core method. General "holistic" approaches do NOT qualify.
- "Integrative / Holistic": ONLY if they explicitly describe using multiple distinct modalities (e.g., "I integrate CBT with psychodynamic approaches") or identify as eclectic/integrative. Do NOT assign as a default.
- "Person-Centred": ONLY if they explicitly mention person-centred, Rogerian, humanistic therapy, or describe working in a specifically non-directive, client-led way as their core approach. General empathy does NOT qualify.

=== STYLE (how they work - require CLEAR description of their way of working) ===
- "Directive / Guiding": ONLY if they describe giving direct advice, assigning homework, providing psychoeducation, or taking an active teaching role. Requires explicit mention.
- "Solution Focused": ONLY if they explicitly mention solution-focused brief therapy (SFBT), goal-setting focus, or primarily future/solution-oriented work. General "practical" approaches do NOT qualify.
- "Relational": ONLY if they explicitly emphasise the therapeutic relationship as a PRIMARY tool for change (attachment-based, relational psychotherapy). All therapists build rapport - this is about therapy THROUGH the relationship.
- "Working at Depth": ONLY if they mention psychodynamic, psychoanalytic, depth psychology, exploring unconscious patterns, transference, or childhood roots. Do NOT assign to general exploratory work. NOTE: This is ONLY a Style category, never an Approach.

=== AREAS OF FOCUS (require SPECIFIC clinical experience or training) ===
- "Mental Health & Mood": ONLY if they have specific experience/training with clinical anxiety disorders, depression, OCD, panic, or mood disorders. General wellbeing support does NOT qualify. Look for: clinical terminology, specific conditions mentioned, NHS/clinical background.
- "Trauma & Crisis": ONLY if they mention trauma-specific training (EMDR, TF-CBT, somatic experiencing), PTSD, abuse, addiction, self-harm, or crisis intervention experience. General "difficult experiences" does NOT qualify.
- "Life Stages & Work": ONLY if they specifically mention bereavement, career counselling, workplace issues, divorce, retirement, or life transitions as an area of focus.
- "Family & Relationships": ONLY if they mention couples therapy, family therapy, systemic work, or specific relationship/parenting focus. Generic "relationship issues" mentioned in a list does NOT qualify.
- "Pregnancy & Post-Natal": ONLY if they specifically mention perinatal mental health, post-natal depression, pregnancy-related support, or parent-infant work.
- "Identity & Body": ONLY if they mention specific work with LGBTQ+ clients, gender identity, eating disorders, body dysmorphia, neurodiversity, cultural identity, or have relevant lived experience/training.

STRICT RULES:
- ONLY use the exact category values listed above
- DO NOT assign a category without STRONG supporting evidence from the text
- Empty arrays are PREFERRED over weak assignments - quality over quantity
- Each category assignment MUST have clear, specific evidence that would satisfy a clinical reviewer
- "Working at Depth" can ONLY appear in Style, NEVER in Approach
- If the source text is generic or lacks specific clinical detail, assign FEWER categories
- If availability information is not provided, set availability to null
- The name and email fields are REQUIRED - look for them in both the document text AND the additional information section below
- If no email is found anywhere, use "unknown@placeholder.com" as a placeholder
`;
}

class PDFIngestionService {
  async extractTextFromPDF(pdfBuffer: Buffer): Promise<string> {
    try {
      const data = await pdf(pdfBuffer);
      return data.text;
    } catch (err) {
      logger.error({ err }, 'Failed to parse PDF');
      throw new Error('Failed to parse PDF file');
    }
  }

  async extractTherapistProfile(
    pdfText: string,
    traceId?: string,
    additionalInfo?: string,
    country?: string,
    overrideTimezone?: string,
  ): Promise<ExtractedTherapistProfile> {
    // The timezone stamped on extracted availability must reflect WHERE the
    // therapist works, not the platform's home timezone. Prefer the admin's
    // chosen timezone, then the country's unambiguous default, then the
    // system fallback.
    const timezone = resolveExtractionTimezone(country, overrideTimezone);

    // Build the prompt with document text and any additional info from admin
    let prompt = buildExtractionPrompt(timezone, country) + '\n\nDocument text:\n' + pdfText;

    if (additionalInfo) {
      prompt +=
        '\n\n---\nADDITIONAL INFORMATION PROVIDED BY ADMIN (use this to supplement or correct missing data):\n' +
        additionalInfo;
    }

    const response = await aiService.generateResponse(
      prompt,
      'You are a data extraction assistant. Always respond with valid JSON only, no additional text.',
      {
        maxTokens: 2000,
        temperature: 0.3,
        traceId,
      }
    );

    try {
      const extracted: any = parseJsonFromLLMResponse(response.content, 'therapist-extraction');

      // Validate required fields - use fallbacks from additional info if possible
      if (!extracted.name) {
        // Try to extract name from additional info
        const nameMatch = additionalInfo?.match(/Therapist Name:\s*(.+)/i);
        if (nameMatch) {
          extracted.name = nameMatch[1].trim();
        } else {
          throw new Error('Missing required field: name. Please provide the therapist name.');
        }
      }
      if (!extracted.email) {
        // Try to extract email from additional info
        const emailMatch = additionalInfo?.match(/Therapist Email:\s*(\S+@\S+)/i);
        if (emailMatch) {
          extracted.email = emailMatch[1].trim();
        }
        // Email can be overridden by admin, so don't require it here
        if (!extracted.email) {
          extracted.email = 'unknown@placeholder.com';
        }
      }

      // Helper to normalize categories - handle both old string[] and new object[] formats
      const normalizeCategories = (cats: any[]): CategoryWithEvidence[] => {
        if (!Array.isArray(cats)) return [];
        return cats.map(cat => {
          // If already in new format
          if (typeof cat === 'object' && cat.type) {
            return {
              type: cat.type,
              evidence: cat.evidence || '',
              reasoning: cat.reasoning || '',
            };
          }
          // Legacy string format - no evidence
          if (typeof cat === 'string') {
            return { type: cat, evidence: '', reasoning: '' };
          }
          return { type: String(cat), evidence: '', reasoning: '' };
        });
      };

      // Validate and filter categories
      // "Working at Depth" is ONLY valid in Style, not in Approach
      const approachCategories = normalizeCategories(extracted.approach)
        .filter(c => c.type !== 'Working at Depth');

      // If "Working at Depth" was incorrectly in Approach, move it to Style
      const workingAtDepthInApproach = normalizeCategories(extracted.approach)
        .find(c => c.type === 'Working at Depth');
      const styleCategories = normalizeCategories(extracted.style);
      if (workingAtDepthInApproach && !styleCategories.some(c => c.type === 'Working at Depth')) {
        styleCategories.push({
          type: 'Working at Depth',
          evidence: workingAtDepthInApproach.evidence,
          reasoning: 'Moved from Approach - this is a Style category',
        });
      }

      return {
        name: extracted.name,
        email: extracted.email,
        bio: extracted.bio || `${extracted.name} is a qualified therapist.`,
        approach: approachCategories,
        style: styleCategories,
        areasOfFocus: normalizeCategories(extracted.areasOfFocus),
        availability: extracted.availability || null,
        qualifications: extracted.qualifications,
        yearsExperience: extracted.yearsExperience,
      };
    } catch (err) {
      logger.error({ err, responseContent: response.content }, 'Failed to parse AI extraction response');
      // Surface a user-friendly message instead of raw JSON.parse errors
      const isParseError = err instanceof SyntaxError;
      const message = isParseError
        ? 'Failed to extract therapist profile — the AI returned malformed data. Please try again.'
        : (err instanceof Error ? err.message : 'Failed to extract therapist profile');
      throw new Error(message);
    }
  }

  private applyAdminOverrides(profile: ExtractedTherapistProfile, adminNotes: AdminNotes): ExtractedTherapistProfile {
    const updated = { ...profile };

    // Apply email override
    if (adminNotes.overrideEmail) {
      updated.email = adminNotes.overrideEmail;
    }

    // Replace categories with admin selections. The admin checkboxes represent
    // the final desired set — unchecking an AI suggestion should remove it.
    // Preserve AI evidence for categories the admin kept selected.
    const replaceCategories = (
      existing: CategoryWithEvidence[],
      overrides: string[] | undefined
    ): CategoryWithEvidence[] => {
      if (!overrides) return existing; // undefined = no override provided
      const existingByType = new Map(existing.map(c => [c.type, c]));
      return overrides.map(type => existingByType.get(type) || { type, evidence: '', reasoning: 'Added by admin' });
    };

    // Apply category overrides (replace, not merge)
    updated.approach = replaceCategories(profile.approach, adminNotes.overrideApproach);
    updated.style = replaceCategories(profile.style, adminNotes.overrideStyle);
    updated.areasOfFocus = replaceCategories(profile.areasOfFocus, adminNotes.overrideAreasOfFocus);

    // Apply availability override
    if (adminNotes.overrideAvailability) {
      updated.availability = adminNotes.overrideAvailability;
    }

    return updated;
  }

  async ingestPDF(pdfBuffer: Buffer | null, traceId?: string, adminNotes?: AdminNotes): Promise<IngestionResult> {
    try {
      let pdfText = '';

      // Step 1: Extract text from PDF (if provided)
      if (pdfBuffer) {
        logger.info({ traceId }, 'Extracting text from PDF');
        pdfText = await this.extractTextFromPDF(pdfBuffer);

        if (!pdfText || pdfText.trim().length < 50) {
          // If PDF has no content but we have additional info, continue without PDF text
          if (!adminNotes?.additionalInfo || adminNotes.additionalInfo.trim().length < 50) {
            return {
              success: false,
              error: 'PDF appears to be empty or contains too little text',
            };
          }
          logger.info({ traceId }, 'PDF empty but additional info provided, continuing');
          pdfText = '';
        }
      } else {
        // No PDF provided - must have additional info
        if (!adminNotes?.additionalInfo || adminNotes.additionalInfo.trim().length < 50) {
          return {
            success: false,
            error: 'Either a PDF or sufficient additional information is required',
          };
        }
        logger.info({ traceId }, 'No PDF provided, using additional info only');
      }

      // Step 2: Use AI to extract structured profile (with additional info if provided).
      // Pass the therapist's country and (if present) the admin's chosen timezone so
      // the AI stamps extracted availability with the correct local timezone — not
      // the platform default of UK time.
      const sourceText = pdfText || 'No PDF document provided.';
      logger.info({ traceId, textLength: sourceText.length, hasAdditionalInfo: !!adminNotes?.additionalInfo, country: adminNotes?.country }, 'Extracting therapist profile with AI');
      let profile = await this.extractTherapistProfile(
        sourceText,
        traceId,
        adminNotes?.additionalInfo,
        adminNotes?.country,
        adminNotes?.overrideAvailability?.timezone,
      );

      // Step 3: Apply any admin overrides
      if (adminNotes) {
        profile = this.applyAdminOverrides(profile, adminNotes);
      }

      // Step 4: Validate final profile before persisting
      if (!profile.email || profile.email === 'unknown@placeholder.com') {
        return {
          success: false,
          error: 'A valid email address is required. Please provide one via the email field or in the additional information.',
        };
      }

      // Step 5: Create the Postgres Therapist row directly. Notion is no
      // longer authoritative; the public-facing handle for new ingestions
      // is the Postgres uuid (notionId stays null). All profile fields are
      // written here in a single insert.
      logger.info({ traceId, name: profile.name }, 'Creating therapist in Postgres');

      // Cast through unknown because Prisma's JSON branding doesn't quite
      // line up with our shared TherapistAvailability interface.
      const availabilityForDb = profile.availability
        ? (profile.availability as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull;

      const odId = await generateUniqueTherapistId();
      const therapist = await prisma.therapist.create({
        data: {
          odId,
          notionId: null,
          email: profile.email.toLowerCase().trim(),
          name: profile.name,
          country: adminNotes?.country ?? 'UK',
          bio: profile.bio || null,
          approach: profile.approach.slice(0, 5).map((c) => c.type),
          style: profile.style.slice(0, 5).map((c) => c.type),
          areasOfFocus: profile.areasOfFocus.slice(0, 10).map((c) => c.type),
          active: true,
          availability: availabilityForDb,
          ingestedAt: new Date(),
        },
      });

      logger.info(
        {
          traceId,
          therapistId: therapist.id,
          odId: therapist.odId,
          country: therapist.country,
          hasAvailability: !!profile.availability,
        },
        'Created Postgres therapist record',
      );

      // Admin notes used to be appended as a Notion callout block. Post-cutover
      // we don't have anywhere to put them yet — log so they aren't silently
      // dropped, and the admin can paste them into the bio if needed.
      if (adminNotes?.notes) {
        logger.info(
          { traceId, therapistId: therapist.id, notes: adminNotes.notes },
          'Admin notes captured during ingestion (review and add to bio if needed)',
        );
      }

      return {
        success: true,
        therapistId: therapist.id,
        extractedData: profile,
      };
    } catch (err) {
      logger.error({ err, traceId }, 'PDF ingestion failed');
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error during PDF ingestion',
      };
    }
  }
}

export const pdfIngestionService = new PDFIngestionService();
