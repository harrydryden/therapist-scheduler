import pdf from 'pdf-parse';
import { Client } from '@notionhq/client';
import { config } from '../config';
import {
  APPROACH_OPTIONS,
  STYLE_OPTIONS,
  AREAS_OF_FOCUS_OPTIONS,
  NOTION_CATEGORY_PROPERTIES,
  type TherapistCategories,
} from '../config/therapist-categories';
import { aiService } from './ai.service';
import { logger } from '../utils/logger';

const notion = new Client({ auth: config.notionApiKey });

// Category with evidence for explainability
export interface CategoryWithEvidence {
  type: string;
  evidence: string;  // Direct quote from source text (max ~100 chars)
  reasoning: string; // Brief explanation (max ~50 chars)
}

export interface ExtractedTherapistProfile {
  name: string;
  email: string;
  bio: string;
  // Categorization system with evidence
  approach: CategoryWithEvidence[];
  style: CategoryWithEvidence[];
  areasOfFocus: CategoryWithEvidence[];
  availability: {
    timezone: string;
    slots: Array<{
      day: string;
      start: string;
      end: string;
    }>;
  } | null;
  qualifications?: string[];
  yearsExperience?: number;
}

export interface AdminNotes {
  additionalInfo?: string; // Free text field for admin to add missing info
  overrideEmail?: string; // Override extracted email if needed
  // Category overrides
  overrideApproach?: string[];
  overrideStyle?: string[];
  overrideAreasOfFocus?: string[];
  overrideAvailability?: {
    timezone: string;
    slots: Array<{ day: string; start: string; end: string }>;
  };
  notes?: string; // Internal admin notes (not shown to users)
}

interface IngestionResult {
  success: boolean;
  therapistId?: string;
  notionUrl?: string;
  extractedData?: ExtractedTherapistProfile;
  error?: string;
}

// Build extraction prompt dynamically to include configured timezone and category options
function buildExtractionPrompt(): string {
  // Build detailed category descriptions with explainers
  const approachDescriptions = APPROACH_OPTIONS.map((o) => `"${o.type}" - ${o.explainer}`).join('\n  ');
  const styleDescriptions = STYLE_OPTIONS.map((o) => `"${o.type}" - ${o.explainer}`).join('\n  ');
  const areasOfFocusDescriptions = AREAS_OF_FOCUS_OPTIONS.map((o) => `"${o.type}" - ${o.explainer}`).join('\n  ');

  return `You are an expert at extracting structured information from therapist profiles, CVs, job applications, and descriptive text.

Analyze the following text and extract the therapist's profile information. The text may be from a CV/PDF or from a free-text description provided by an admin.

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
    "timezone": "${config.timezone}",
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
- The name and email fields are REQUIRED - extract them from the text
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
    additionalInfo?: string
  ): Promise<ExtractedTherapistProfile> {
    // Build the prompt with document text and any additional info from admin
    let prompt = buildExtractionPrompt() + '\n\nDocument text:\n' + pdfText;

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
      // Try to extract JSON from the response
      let jsonStr = response.content.trim();

      // Handle markdown code blocks
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7);
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3);
      }
      if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.slice(0, -3);
      }

      const extracted = JSON.parse(jsonStr.trim());

      // Validate required fields
      if (!extracted.name || !extracted.email) {
        throw new Error('Missing required fields: name and email');
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
      throw new Error('Failed to extract therapist profile from document');
    }
  }

  private applyAdminOverrides(profile: ExtractedTherapistProfile, adminNotes: AdminNotes): ExtractedTherapistProfile {
    const updated = { ...profile };

    // Apply email override
    if (adminNotes.overrideEmail) {
      updated.email = adminNotes.overrideEmail;
    }

    // Helper to merge categories - admin overrides are just type strings (no evidence needed for manual selections)
    const mergeCategories = (
      existing: CategoryWithEvidence[],
      overrides: string[] | undefined
    ): CategoryWithEvidence[] => {
      if (!overrides || overrides.length === 0) return existing;
      const existingTypes = new Set(existing.map(c => c.type));
      const newCategories = overrides
        .filter(type => !existingTypes.has(type))
        .map(type => ({ type, evidence: '', reasoning: 'Added by admin' }));
      return [...existing, ...newCategories];
    };

    // Apply category overrides
    updated.approach = mergeCategories(profile.approach, adminNotes.overrideApproach);
    updated.style = mergeCategories(profile.style, adminNotes.overrideStyle);
    updated.areasOfFocus = mergeCategories(profile.areasOfFocus, adminNotes.overrideAreasOfFocus);

    // Apply availability override
    if (adminNotes.overrideAvailability) {
      updated.availability = adminNotes.overrideAvailability;
    }

    return updated;
  }

  async createTherapistInNotion(
    profile: ExtractedTherapistProfile,
    adminNotes?: string
  ): Promise<{ id: string; url: string }> {
    try {
      // Build bio with admin notes appended if present (internal only)
      let bioContent = profile.bio.slice(0, 2000);

      // Build properties object
      const properties: Record<string, any> = {
        Name: {
          title: [
            {
              text: {
                content: profile.name,
              },
            },
          ],
        },
        Email: {
          email: profile.email,
        },
        Bio: {
          rich_text: [
            {
              text: {
                content: bioContent,
              },
            },
          ],
        },
        // Category system - extract type strings from CategoryWithEvidence objects
        [NOTION_CATEGORY_PROPERTIES.APPROACH]: {
          multi_select: profile.approach.slice(0, 5).map((c) => ({ name: c.type })),
        },
        [NOTION_CATEGORY_PROPERTIES.STYLE]: {
          multi_select: profile.style.slice(0, 5).map((c) => ({ name: c.type })),
        },
        [NOTION_CATEGORY_PROPERTIES.AREAS_OF_FOCUS]: {
          multi_select: profile.areasOfFocus.slice(0, 10).map((c) => ({ name: c.type })),
        },
        Active: {
          checkbox: true, // Add directly as active
        },
      };

      // Add availability to individual day columns
      if (profile.availability && profile.availability.slots) {
        // Group slots by day
        const slotsByDay: Record<string, string[]> = {};
        for (const slot of profile.availability.slots) {
          if (!slotsByDay[slot.day]) {
            slotsByDay[slot.day] = [];
          }
          slotsByDay[slot.day].push(`${slot.start}-${slot.end}`);
        }

        // Add each day's availability as a rich_text property
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        for (const day of days) {
          if (slotsByDay[day]) {
            properties[day] = {
              rich_text: [
                {
                  text: {
                    content: slotsByDay[day].join(', '),
                  },
                },
              ],
            };
          }
        }
      }

      const response = await notion.pages.create({
        parent: {
          database_id: config.notionDatabaseId,
        },
        properties,
      });

      const notionUrl = `https://www.notion.so/${response.id.replace(/-/g, '')}`;

      logger.info(
        {
          therapistId: response.id,
          name: profile.name,
          email: profile.email,
          hasAdminNotes: !!adminNotes,
        },
        'Created therapist in Notion'
      );

      // If there are admin notes, add them as a comment/block in the page body
      if (adminNotes) {
        try {
          await notion.blocks.children.append({
            block_id: response.id,
            children: [
              {
                type: 'callout',
                callout: {
                  rich_text: [
                    {
                      type: 'text',
                      text: {
                        content: `Admin Notes: ${adminNotes}`,
                      },
                    },
                  ],
                  icon: {
                    emoji: '📝',
                  },
                  color: 'gray_background',
                },
              },
            ],
          });
        } catch (blockErr) {
          // Non-critical, just log the error
          logger.warn({ blockErr, therapistId: response.id }, 'Failed to add admin notes block');
        }
      }

      return {
        id: response.id,
        url: notionUrl,
      };
    } catch (err) {
      logger.error({ err, profile }, 'Failed to create therapist in Notion');
      throw new Error('Failed to create therapist record in Notion');
    }
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

      // Step 2: Use AI to extract structured profile (with additional info if provided)
      const sourceText = pdfText || 'No PDF document provided.';
      logger.info({ traceId, textLength: sourceText.length, hasAdditionalInfo: !!adminNotes?.additionalInfo }, 'Extracting therapist profile with AI');
      let profile = await this.extractTherapistProfile(sourceText, traceId, adminNotes?.additionalInfo);

      // Step 3: Apply any admin overrides
      if (adminNotes) {
        profile = this.applyAdminOverrides(profile, adminNotes);
      }

      // Step 4: Create therapist in Notion (with internal admin notes if provided)
      logger.info({ traceId, name: profile.name }, 'Creating therapist in Notion');
      const { id, url } = await this.createTherapistInNotion(profile, adminNotes?.notes);

      return {
        success: true,
        therapistId: id,
        notionUrl: url,
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
