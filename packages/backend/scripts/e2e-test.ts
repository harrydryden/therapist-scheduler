/**
 * End-to-End Testing Script
 *
 * Tests the complete appointment booking lifecycle including:
 * 1. Creating an appointment request
 * 2. Email notifications via mailing service
 * 3. Confirming via admin API
 * 4. Feedback form submission (filling out all questions)
 * 5. Appointment completion / cancellation
 *
 * IMPORTANT: Uses dedicated TEST accounts in Notion:
 * - Test User: "Test User E2E" (scheduling+testuser@spill.chat)
 * - Test Therapist: "Test Therapist (E2E)" (scheduling+therapist@spill.chat)
 *
 * Usage:
 *   WEBHOOK_SECRET=xxx npx ts-node scripts/e2e-test.ts [scenario]
 *
 * Scenarios:
 *   completion    - Full lifecycle ending with feedback and completion
 *   cancellation  - Booking cancelled before session
 *   forms         - Just test the forms admin API
 *   all           - Run all scenarios (default)
 */

// Test configuration - uses dedicated TEST accounts in Notion
const TEST_CONFIG = {
  apiBase: process.env.TEST_API_BASE || 'https://backend-production-fe25.up.railway.app',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  // Test user - dedicated test account in Notion
  testUserEmail: 'scheduling+testuser@spill.chat',
  testUserName: 'Test User E2E',
  // Test therapist - dedicated test account in Notion with known ID
  // We use the ID directly since the therapist may be frozen between tests
  testTherapist: {
    notionId: '30749f92-fc6b-81b4-bc19-f5851d35e9fd',
    name: 'Test Therapist (E2E)',
    email: 'scheduling+therapist@spill.chat',
  },
  verbose: process.env.VERBOSE === 'true',
};

// Validate required env vars
if (!TEST_CONFIG.webhookSecret) {
  console.error('ERROR: WEBHOOK_SECRET environment variable is required');
  console.error('Usage: WEBHOOK_SECRET=xxx npx ts-node scripts/e2e-test.ts');
  process.exit(1);
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

interface NotificationCheck {
  type: string;
  expected: boolean;
  note: string;
}

// Tracking for notifications to verify manually
const notificationChecks: NotificationCheck[] = [];
const issuesToFix: string[] = [];

// Helper to make API requests
async function apiRequest(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ status: number; data: any }> {
  const url = `${TEST_CONFIG.apiBase}${endpoint}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': TEST_CONFIG.webhookSecret,
        ...options.headers,
      },
      ...options,
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (TEST_CONFIG.verbose) {
      console.log(`  [API] ${options.method || 'GET'} ${endpoint} -> ${response.status}`);
      if (!response.ok) {
        console.log(`  [API] Response: ${JSON.stringify(data).slice(0, 200)}`);
      }
    }

    return { status: response.status, data };
  } catch (err) {
    console.error(`  [API] Error: ${err}`);
    return { status: 0, data: { error: String(err) } };
  }
}

// Helper to wait
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test: Forms admin page loads
async function testFormsAdminPage(): Promise<TestResult> {
  console.log('\n  Testing forms admin API...');

  const { status, data } = await apiRequest('/api/admin/forms/feedback');

  if (status !== 200) {
    return {
      name: 'Forms Admin API',
      passed: false,
      error: `Status ${status}: ${JSON.stringify(data)}`,
    };
  }

  console.log(`  Form config loaded: ${data.formName}`);
  console.log(`  Questions: ${Array.isArray(data.questions) ? data.questions.length : 'N/A'}`);
  console.log(`  Active: ${data.isActive}`);

  return { name: 'Forms Admin API', passed: true };
}

// Test: Create appointment request using the dedicated TEST therapist account
// Uses the known test therapist ID directly (bypasses public list which may show them as frozen)
async function testCreateAppointment(): Promise<{ appointmentId: string; therapistName: string; therapistNotionId: string } | null> {
  console.log('\n  Creating appointment request...');

  // Use the dedicated test therapist directly by ID
  const testTherapist = TEST_CONFIG.testTherapist;
  console.log(`  Using TEST therapist: ${testTherapist.name} (${testTherapist.notionId})`);

  // Create appointment request with test therapist
  const { status, data } = await apiRequest('/api/appointments/request', {
    method: 'POST',
    body: JSON.stringify({
      therapistNotionId: testTherapist.notionId,
      therapistName: testTherapist.name,
      therapistEmail: testTherapist.email,
      userName: TEST_CONFIG.testUserName,
      userEmail: TEST_CONFIG.testUserEmail,
    }),
  });

  if (status !== 201) {
    console.error(`  Failed to create appointment: ${JSON.stringify(data)}`);
    return null;
  }

  console.log(`  Created appointment: ${data.data.appointmentRequestId}`);
  console.log(`  Test user email: ${TEST_CONFIG.testUserEmail}`);
  console.log(`  Test therapist: ${testTherapist.name}`);

  // Note: Initial request triggers email to therapist
  notificationChecks.push({
    type: 'Email: Initial Request to Therapist',
    expected: true,
    note: `Check scheduling+therapist@spill.chat received initial booking request email`,
  });

  return {
    appointmentId: data.data.appointmentRequestId,
    therapistName: testTherapist.name,
    therapistNotionId: testTherapist.notionId,
  };
}

// Test: Get appointment details
async function testGetAppointmentDetail(appointmentId: string): Promise<any> {
  const { status, data } = await apiRequest(`/api/admin/dashboard/appointments/${appointmentId}`);

  if (status !== 200) {
    console.error(`  Failed to get appointment details: ${JSON.stringify(data)}`);
    return null;
  }

  return data.data;
}

// Test: Take human control of appointment
async function testTakeControl(appointmentId: string): Promise<boolean> {
  console.log('\n  Taking human control...');

  const { status, data } = await apiRequest(
    `/api/admin/dashboard/appointments/${appointmentId}/take-control`,
    {
      method: 'POST',
      body: JSON.stringify({
        adminId: 'e2e-test',
        reason: 'E2E test automation',
      }),
    }
  );

  if (status !== 200) {
    console.error(`  Failed to take control: ${JSON.stringify(data)}`);
    return false;
  }

  console.log('  Human control enabled');
  return true;
}

// Test: Confirm appointment
async function testConfirmAppointment(appointmentId: string): Promise<boolean> {
  console.log('\n  Confirming appointment...');

  // Set confirmed time to 2 hours from now (so it's "soon")
  const confirmedDateTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const { status, data } = await apiRequest(
    `/api/admin/dashboard/appointments/${appointmentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'confirmed',
        confirmedDateTime,
        adminId: 'e2e-test',
      }),
    }
  );

  if (status !== 200) {
    console.error(`  Failed to confirm appointment: ${JSON.stringify(data)}`);
    return false;
  }

  console.log(`  Appointment confirmed for: ${confirmedDateTime}`);

  notificationChecks.push({
    type: 'Slack: Appointment Confirmed',
    expected: true,
    note: 'Check Slack for confirmation notification',
  });

  notificationChecks.push({
    type: 'Email: Client Confirmation',
    expected: true,
    note: `Check scheduling+testuser@spill.chat received confirmation email`,
  });

  notificationChecks.push({
    type: 'Email: Therapist Confirmation',
    expected: true,
    note: `Check scheduling+therapist@spill.chat received confirmation email`,
  });

  return true;
}

// Test: Update status to session_held
async function testMarkSessionHeld(appointmentId: string): Promise<boolean> {
  console.log('\n  Marking session as held...');

  const { status, data } = await apiRequest(
    `/api/admin/dashboard/appointments/${appointmentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'session_held',
        adminId: 'e2e-test',
      }),
    }
  );

  if (status !== 200) {
    console.error(`  Failed to mark session held: ${JSON.stringify(data)}`);
    return false;
  }

  console.log('  Session marked as held');
  return true;
}

// Test: Submit feedback form with all required fields
async function testSubmitFeedback(trackingCode: string | null, therapistName: string): Promise<boolean> {
  console.log('\n  Filling out feedback form...');

  // Prepare form responses - filling out all required fields
  const formResponses = {
    // Q1: Confirm therapist name (text, required, prefilled)
    therapist_confirmation: therapistName,
    // Q2: How safe and comfortable did you feel? (scale 0-5, required)
    safety_comfort: 5,
    // Q3: Did you feel listened to? (scale 0-5, required)
    listened_to: 4,
    // Q4: Did the session feel professionally conducted? (scale 0-5, required)
    professional: 5,
    // Q5: Would you book another session? (choice: Yes/Maybe/No, required)
    would_book_again: 'Yes',
  };

  console.log('  Form responses:');
  console.log(`    - Therapist confirmation: "${formResponses.therapist_confirmation}"`);
  console.log(`    - Safety & comfort: ${formResponses.safety_comfort}/5`);
  console.log(`    - Felt listened to: ${formResponses.listened_to}/5`);
  console.log(`    - Professional: ${formResponses.professional}/5`);
  console.log(`    - Would book again: ${formResponses.would_book_again}`);

  console.log(`  Submitting with tracking code: ${trackingCode || 'none'}`);

  const { status, data } = await apiRequest('/api/feedback/submit', {
    method: 'POST',
    body: JSON.stringify({
      trackingCode: trackingCode || undefined,
      therapistName,
      responses: formResponses,
    }),
  });

  if (status !== 201) {
    console.error(`  Failed to submit feedback: ${JSON.stringify(data)}`);
    return false;
  }

  console.log(`  ✅ Feedback submitted successfully: ${data.submissionId}`);

  notificationChecks.push({
    type: 'Slack: Appointment Completed',
    expected: true,
    note: 'Check Slack for completion notification',
  });

  return true;
}

// Test: Verify status
async function testVerifyStatus(appointmentId: string, expectedStatus: string): Promise<boolean> {
  console.log(`\n  Verifying status is '${expectedStatus}'...`);

  const detail = await testGetAppointmentDetail(appointmentId);

  if (!detail) {
    return false;
  }

  if (detail.status !== expectedStatus) {
    console.error(`  Expected status '${expectedStatus}', got '${detail.status}'`);
    return false;
  }

  console.log(`  Status verified: ${detail.status}`);
  return true;
}

// Test: Cancel appointment
async function testCancelAppointment(appointmentId: string): Promise<boolean> {
  console.log('\n  Cancelling appointment...');

  const { status, data } = await apiRequest(
    `/api/admin/dashboard/appointments/${appointmentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'cancelled',
        reason: 'E2E test cancellation',
        adminId: 'e2e-test',
      }),
    }
  );

  if (status !== 200) {
    console.error(`  Failed to cancel appointment: ${JSON.stringify(data)}`);
    return false;
  }

  console.log('  Appointment cancelled');

  notificationChecks.push({
    type: 'Slack: Appointment Cancelled',
    expected: true,
    note: 'Check Slack for cancellation notification',
  });

  return true;
}

// Test: Delete appointment (cleanup)
async function testDeleteAppointment(appointmentId: string): Promise<boolean> {
  console.log('\n  Cleaning up: deleting appointment...');

  const { status, data } = await apiRequest(
    `/api/admin/dashboard/appointments/${appointmentId}`,
    {
      method: 'DELETE',
      body: JSON.stringify({
        adminId: 'e2e-test',
        reason: 'E2E test cleanup',
        forceDeleteConfirmed: true,
      }),
    }
  );

  if (status !== 200) {
    console.error(`  Failed to delete appointment: ${JSON.stringify(data)}`);
    return false;
  }

  console.log('  Appointment deleted');
  return true;
}

// Run completion scenario
async function runCompletionScenario(): Promise<TestResult[]> {
  console.log('\n========================================');
  console.log('SCENARIO: Full Completion Lifecycle');
  console.log('========================================');

  const results: TestResult[] = [];

  // Step 1: Create appointment
  const created = await testCreateAppointment();
  if (!created) {
    results.push({ name: 'Create Appointment', passed: false, error: 'Failed to create' });
    return results;
  }
  results.push({ name: 'Create Appointment', passed: true, details: { appointmentId: created.appointmentId } });

  // Step 2: Get details to find tracking code
  const detail = await testGetAppointmentDetail(created.appointmentId);
  const trackingCode = detail?.trackingCode || null;
  console.log(`  Tracking code: ${trackingCode || 'none'}`);

  // Step 3: Take human control
  if (await testTakeControl(created.appointmentId)) {
    results.push({ name: 'Take Human Control', passed: true });
  } else {
    results.push({ name: 'Take Human Control', passed: false });
    await testDeleteAppointment(created.appointmentId);
    return results;
  }

  // Step 4: Confirm appointment
  if (await testConfirmAppointment(created.appointmentId)) {
    results.push({ name: 'Confirm Appointment', passed: true });
  } else {
    results.push({ name: 'Confirm Appointment', passed: false });
    await testDeleteAppointment(created.appointmentId);
    return results;
  }

  // Step 5: Mark session held
  if (await testMarkSessionHeld(created.appointmentId)) {
    results.push({ name: 'Mark Session Held', passed: true });
  } else {
    results.push({ name: 'Mark Session Held', passed: false });
  }

  // Step 6: Submit feedback
  if (await testSubmitFeedback(trackingCode, created.therapistName)) {
    results.push({ name: 'Submit Feedback', passed: true });
  } else {
    results.push({ name: 'Submit Feedback', passed: false });
  }

  // Step 7: Verify completed status
  await sleep(1000); // Wait for status update
  if (await testVerifyStatus(created.appointmentId, 'completed')) {
    results.push({ name: 'Verify Completed Status', passed: true });

    // Note: Using TEST therapist account - verify in Notion
    notificationChecks.push({
      type: 'Notion: TEST Therapist Inactive',
      expected: true,
      note: `Verify TEST therapist "${created.therapistName}" (${created.therapistNotionId}) is marked Active=false in Notion`,
    });
  } else {
    results.push({ name: 'Verify Completed Status', passed: false });
    issuesToFix.push('Appointment not marked as completed after feedback submission');
  }

  // Cleanup
  await testDeleteAppointment(created.appointmentId);

  return results;
}

// Run cancellation scenario
async function runCancellationScenario(): Promise<TestResult[]> {
  console.log('\n========================================');
  console.log('SCENARIO: Cancellation');
  console.log('========================================');

  const results: TestResult[] = [];

  // Step 1: Create appointment
  const created = await testCreateAppointment();
  if (!created) {
    results.push({ name: 'Create Appointment', passed: false, error: 'Failed to create' });
    return results;
  }
  results.push({ name: 'Create Appointment', passed: true });

  // Step 2: Take human control
  if (await testTakeControl(created.appointmentId)) {
    results.push({ name: 'Take Human Control', passed: true });
  } else {
    results.push({ name: 'Take Human Control', passed: false });
    await testDeleteAppointment(created.appointmentId);
    return results;
  }

  // Step 3: Confirm appointment
  if (await testConfirmAppointment(created.appointmentId)) {
    results.push({ name: 'Confirm Appointment', passed: true });
  } else {
    results.push({ name: 'Confirm Appointment', passed: false });
    await testDeleteAppointment(created.appointmentId);
    return results;
  }

  // Step 4: Cancel appointment
  if (await testCancelAppointment(created.appointmentId)) {
    results.push({ name: 'Cancel Appointment', passed: true });

    // Note: Using TEST therapist account - verify in Notion
    notificationChecks.push({
      type: 'Notion: TEST Therapist Unfrozen',
      expected: true,
      note: `Verify TEST therapist "${created.therapistName}" (${created.therapistNotionId}) is unfrozen in Notion`,
    });
  } else {
    results.push({ name: 'Cancel Appointment', passed: false });
    issuesToFix.push('Failed to cancel appointment');
  }

  // Step 5: Verify cancelled status
  if (await testVerifyStatus(created.appointmentId, 'cancelled')) {
    results.push({ name: 'Verify Cancelled Status', passed: true });
  } else {
    results.push({ name: 'Verify Cancelled Status', passed: false });
  }

  // Cleanup
  await testDeleteAppointment(created.appointmentId);

  return results;
}

// Run forms test
async function runFormsTest(): Promise<TestResult[]> {
  console.log('\n========================================');
  console.log('SCENARIO: Forms Admin');
  console.log('========================================');

  const result = await testFormsAdminPage();
  return [result];
}

// Print summary
function printSummary(allResults: TestResult[]): void {
  console.log('\n========================================');
  console.log('TEST SUMMARY');
  console.log('========================================\n');

  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;

  for (const result of allResults) {
    const status = result.passed ? '✅' : '❌';
    console.log(`  ${status} ${result.name}`);
    if (result.error) {
      console.log(`     Error: ${result.error}`);
    }
  }

  console.log('\n----------------------------------------');
  console.log(`  Total: ${allResults.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('----------------------------------------');

  // Notification checks
  if (notificationChecks.length > 0) {
    console.log('\n========================================');
    console.log('NOTIFICATIONS TO VERIFY MANUALLY');
    console.log('========================================\n');
    for (const check of notificationChecks) {
      console.log(`  📋 ${check.type}`);
      console.log(`     ${check.note}`);
    }
  }

  // Issues to fix
  if (issuesToFix.length > 0) {
    console.log('\n========================================');
    console.log('ISSUES TO FIX');
    console.log('========================================\n');
    for (const issue of issuesToFix) {
      console.log(`  ⚠️  ${issue}`);
    }
  }
}

// Main entry point
async function main(): Promise<void> {
  const scenario = process.argv[2] || 'all';

  console.log('========================================');
  console.log('E2E TEST RUNNER');
  console.log('========================================');
  console.log(`API Base: ${TEST_CONFIG.apiBase}`);
  console.log(`Scenario: ${scenario}`);
  console.log(`Test Email: ${TEST_CONFIG.testUserEmail}`);

  const allResults: TestResult[] = [];

  try {
    if (scenario === 'forms' || scenario === 'all') {
      const formsResults = await runFormsTest();
      allResults.push(...formsResults);
    }

    if (scenario === 'completion' || scenario === 'all') {
      const completionResults = await runCompletionScenario();
      allResults.push(...completionResults);
    }

    if (scenario === 'cancellation' || scenario === 'all') {
      const cancellationResults = await runCancellationScenario();
      allResults.push(...cancellationResults);
    }

    printSummary(allResults);

  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }

  // Exit with error code if any tests failed
  const failed = allResults.filter(r => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main();
