import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapacity, evaluateGraduation, evaluateProgression } from './workflowEvaluators.js';

test('progression evaluator uses configured thresholds and does not invent policy', () => {
  const missing = evaluateProgression({ cgpa: 3.2, passedCredits: 40 });
  assert.ok(missing.some(f => f.code === 'PROGRESSION_POLICY_INCOMPLETE'));
  const below = evaluateProgression({ cgpa: 1.8, passedCredits: 30, policy: { minimumCGPA: 2, minimumCreditsPassed: 36 } });
  assert.ok(below.some(f => f.code === 'MINIMUM_CGPA_NOT_MET'));
  assert.ok(below.some(f => f.code === 'MINIMUM_PASSED_CREDITS_NOT_MET'));
});

test('graduation evaluator identifies missing clearance and preserves Registrar decision', () => {
  const findings = evaluateGraduation({ requiredClearances: ['academic', 'finance', 'library'], approvedClearances: ['academic'], academicEligible: true, financeCleared: false });
  assert.ok(findings.some(f => f.code === 'GRADUATION_CLEARANCES_MISSING'));
  assert.ok(findings.some(f => f.code === 'FINANCE_CLEARANCE_NOT_CONFIRMED'));
  assert.ok(findings.some(f => f.code === 'REGISTRAR_FINAL_DECISION_REQUIRED'));
});

test('capacity evaluator flags over-allocation and warns that atomic reservation checks remain required', () => {
  const findings = evaluateCapacity({ capacity: 10, occupied: 8, activeReservations: 3 });
  assert.ok(findings.some(f => f.code === 'CAPACITY_OVERALLOCATED'));
  assert.ok(findings.some(f => f.code === 'ATOMIC_BOOKING_CHECK_REQUIRED'));
});
