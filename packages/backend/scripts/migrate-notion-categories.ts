/**
 * Migration Script: Add Therapist Category Properties to Notion Database
 *
 * This script adds three new multi-select properties to the Notion database:
 * - Approach (therapeutic methods/tools)
 * - Style (how they work with clients)
 * - Areas of Focus (specific issues they specialize in)
 *
 * Run with: npx tsx scripts/migrate-notion-categories.ts
 *
 * You can provide credentials via:
 * 1. Environment variables: NOTION_API_KEY and NOTION_DATABASE_ID
 * 2. Command line args: --api-key=xxx --database-id=xxx
 */

import { Client } from '@notionhq/client';

// Parse command line arguments
const args = process.argv.slice(2);
const argMap: Record<string, string> = {};
args.forEach(arg => {
  const [key, value] = arg.split('=');
  if (key && value) {
    argMap[key.replace('--', '')] = value;
  }
});

const API_KEY = argMap['api-key'] || process.env.NOTION_API_KEY;
const DATABASE_ID = argMap['database-id'] || process.env.NOTION_DATABASE_ID;

if (!API_KEY) {
  console.error('Error: NOTION_API_KEY is required');
  console.error('Provide via --api-key=xxx or NOTION_API_KEY env var');
  process.exit(1);
}

const notion = new Client({
  auth: API_KEY,
});

if (!DATABASE_ID) {
  console.error('Error: NOTION_DATABASE_ID environment variable is required');
  process.exit(1);
}

// Category colors for Notion multi-select options
const COLORS = {
  approach: ['purple', 'pink', 'blue', 'green'] as const,
  style: ['orange', 'yellow', 'red', 'brown'] as const,
  areasOfFocus: ['gray', 'default', 'purple', 'pink', 'blue', 'green'] as const,
};

// Category options from therapist-categories.ts
const APPROACH_OPTIONS = [
  'Cognitive & Behavioural (CBT)',
  'Mindfulness',
  'Integrative / Holistic',
  'Person-Centred',
];

const STYLE_OPTIONS = [
  'Directive / Guiding',
  'Solution Focused',
  'Relational',
  'Working at Depth',
];

const AREAS_OF_FOCUS_OPTIONS = [
  'Mental Health & Mood',
  'Trauma & Crisis',
  'Life Stages & Work',
  'Family & Relationships',
  'Pregnancy & Post-Natal',
  'Identity & Body',
];

async function updateDatabaseSchema() {
  console.log('Updating Notion database schema...\n');
  console.log(`Database ID: ${DATABASE_ID}\n`);

  try {
    // First, retrieve the current database schema
    const database = await notion.databases.retrieve({
      database_id: DATABASE_ID!,
    });

    console.log('Current database properties:');
    console.log(Object.keys((database as any).properties).join(', '));
    console.log('\n');

    // Check if properties already exist
    const existingProps = (database as any).properties;
    const hasApproach = 'Approach' in existingProps;
    const hasStyle = 'Style' in existingProps;
    const hasAreasOfFocus = 'Areas of Focus' in existingProps;

    if (hasApproach && hasStyle && hasAreasOfFocus) {
      console.log('All category properties already exist in the database.');
      console.log('No migration needed.\n');
      return;
    }

    // Build the properties to add
    const propertiesToAdd: Record<string, any> = {};

    if (!hasApproach) {
      console.log('Adding "Approach" property...');
      propertiesToAdd['Approach'] = {
        multi_select: {
          options: APPROACH_OPTIONS.map((name, idx) => ({
            name,
            color: COLORS.approach[idx % COLORS.approach.length],
          })),
        },
      };
    } else {
      console.log('"Approach" property already exists, skipping.');
    }

    if (!hasStyle) {
      console.log('Adding "Style" property...');
      propertiesToAdd['Style'] = {
        multi_select: {
          options: STYLE_OPTIONS.map((name, idx) => ({
            name,
            color: COLORS.style[idx % COLORS.style.length],
          })),
        },
      };
    } else {
      console.log('"Style" property already exists, skipping.');
    }

    if (!hasAreasOfFocus) {
      console.log('Adding "Areas of Focus" property...');
      propertiesToAdd['Areas of Focus'] = {
        multi_select: {
          options: AREAS_OF_FOCUS_OPTIONS.map((name, idx) => ({
            name,
            color: COLORS.areasOfFocus[idx % COLORS.areasOfFocus.length],
          })),
        },
      };
    } else {
      console.log('"Areas of Focus" property already exists, skipping.');
    }

    // If there are properties to add, update the database
    if (Object.keys(propertiesToAdd).length > 0) {
      console.log('\nUpdating database...');

      await notion.databases.update({
        database_id: DATABASE_ID!,
        properties: propertiesToAdd,
      });

      console.log('\n✅ Database schema updated successfully!\n');
      console.log('New properties added:');
      Object.keys(propertiesToAdd).forEach((prop) => {
        console.log(`  - ${prop}`);
      });
    }

    // Verify the update
    const updatedDatabase = await notion.databases.retrieve({
      database_id: DATABASE_ID!,
    });

    console.log('\n📋 Final database properties:');
    console.log(Object.keys((updatedDatabase as any).properties).join(', '));

  } catch (error: any) {
    if (error.code === 'object_not_found') {
      console.error('Error: Database not found. Check your NOTION_DATABASE_ID.');
    } else if (error.code === 'unauthorized') {
      console.error('Error: Unauthorized. Check your NOTION_API_KEY and ensure the integration has access to the database.');
    } else {
      console.error('Error updating database:', error.message || error);
    }
    process.exit(1);
  }
}

// Run the migration
updateDatabaseSchema()
  .then(() => {
    console.log('\n✨ Migration complete!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
