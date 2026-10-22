/**
 * Deterministic, policy-driven workflow checks shared by the university workflow API.
 * These helpers report evidence and blockers; they never make institutional decisions.
 */
export type WorkflowFinding = {
  code: string;
  severity: 'INFO' | 'REVIEW_REQUIRED';
  message: string;
};

const finiteNumber = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

export function evaluateProgression(inputs: Record<string, unknown>): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  const policy = (inputs.policy && typeof inputs.policy === 'object' ? inputs.policy : {}) as Record<string, unknown>;
  const cgpa = finiteNumber(inputs.cgpa);
  const passedCredits = finiteNumber(inputs.passedCredits);
  const minimumCGPA = finiteNumber(policy.minimumCGPA);
  const minimumCredits = finiteNumber(policy.minimumCreditsPassed);

  if (minimumCGPA === null || minimumCredits === null) {
    findings.push({ code: 'PROGRESSION_POLICY_INCOMPLETE', severity: 'REVIEW_REQUIRED', message: 'The approved policy must define both minimumCGPA and minimumCreditsPassed. No institutional threshold is assumed.' });
  } else {
    if (cgpa === null) findings.push({ code: 'CGPA_EVIDENCE_MISSING', severity: 'REVIEW_REQUIRED', message: 'A numeric CGPA based on official published results is required.' });
    else if (cgpa < minimumCGPA) findings.push({ code: 'MINIMUM_CGPA_NOT_MET', severity: 'REVIEW_REQUIRED', message: `Reported CGPA ${cgpa} is below the configured minimum ${minimumCGPA}. Authorized academic review is required.` });
    else findings.push({ code: 'MINIMUM_CGPA_MET', severity: 'INFO', message: `Reported CGPA meets the configured minimum ${minimumCGPA}.` });

    if (passedCredits === null) findings.push({ code: 'PASSED_CREDITS_EVIDENCE_MISSING', severity: 'REVIEW_REQUIRED', message: 'Passed-credit evidence is required.' });
    else if (passedCredits < minimumCredits) findings.push({ code: 'MINIMUM_PASSED_CREDITS_NOT_MET', severity: 'REVIEW_REQUIRED', message: `Reported passed credits ${passedCredits} are below the configured minimum ${minimumCredits}.` });
    else findings.push({ code: 'MINIMUM_PASSED_CREDITS_MET', severity: 'INFO', message: `Reported passed credits meet the configured minimum ${minimumCredits}.` });
  }
  findings.push({ code: 'HUMAN_ACADEMIC_DECISION_REQUIRED', severity: 'REVIEW_REQUIRED', message: 'These checks are advisory. Progression requires the authorized institutional decision.' });
  return findings;
}

export function evaluateGraduation(inputs: Record<string, unknown>): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  const requiredRaw = Array.isArray(inputs.requiredClearances) ? inputs.requiredClearances : ['academic', 'finance', 'library', 'department'];
  const approvedRaw = Array.isArray(inputs.approvedClearances) ? inputs.approvedClearances : [];
  const required = [...new Set(requiredRaw.map(String).map(s => s.trim().toLowerCase()).filter(Boolean))];
  const approved = new Set(approvedRaw.map(String).map(s => s.trim().toLowerCase()).filter(Boolean));
  const missing = required.filter(item => !approved.has(item));
  if (missing.length) findings.push({ code: 'GRADUATION_CLEARANCES_MISSING', severity: 'REVIEW_REQUIRED', message: `Outstanding clearance evidence: ${missing.join(', ')}.` });
  else findings.push({ code: 'GRADUATION_CLEARANCES_COMPLETE', severity: 'INFO', message: 'All supplied required clearance types have matching approved evidence; source records must still be verified.' });
  if (inputs.academicEligible !== true) findings.push({ code: 'ACADEMIC_ELIGIBILITY_NOT_CONFIRMED', severity: 'REVIEW_REQUIRED', message: 'Academic eligibility must be explicitly confirmed from official published records.' });
  if (inputs.financeCleared !== true) findings.push({ code: 'FINANCE_CLEARANCE_NOT_CONFIRMED', severity: 'REVIEW_REQUIRED', message: 'Finance clearance must be explicitly confirmed.' });
  findings.push({ code: 'REGISTRAR_FINAL_DECISION_REQUIRED', severity: 'REVIEW_REQUIRED', message: 'The evaluator cannot graduate a student; final approval remains with the authorized Registrar.' });
  return findings;
}

export function evaluateCapacity(inputs: Record<string, unknown>): WorkflowFinding[] {
  const capacity = finiteNumber(inputs.capacity);
  const occupied = finiteNumber(inputs.occupied);
  const activeReservations = finiteNumber(inputs.activeReservations ?? 0);
  if (capacity === null || occupied === null || activeReservations === null || capacity < 0 || occupied < 0 || activeReservations < 0) {
    return [{ code: 'CAPACITY_EVIDENCE_INVALID', severity: 'REVIEW_REQUIRED', message: 'Capacity, occupied beds, and active reservations must be non-negative numeric values.' }];
  }
  const remaining = capacity - occupied - activeReservations;
  const findings: WorkflowFinding[] = remaining < 0
    ? [{ code: 'CAPACITY_OVERALLOCATED', severity: 'REVIEW_REQUIRED', message: `Recorded occupancy and active reservations exceed capacity by ${Math.abs(remaining)}. Reconcile records before confirming bookings.` }]
    : [{ code: 'CAPACITY_RECONCILED', severity: 'INFO', message: `${remaining} places remain after recorded occupancy and active reservations.` }];
  findings.push({ code: 'ATOMIC_BOOKING_CHECK_REQUIRED', severity: 'REVIEW_REQUIRED', message: 'This calculation is advisory; reservation creation must still enforce capacity atomically in the owning hostel workflow.' });
  return findings;
}

const recruitmentTransitions: Record<string, string[]> = {
  SUBMITTED: ['ADMIN_CHECKED', 'NEEDS_INFORMATION', 'NOT_ELIGIBLE'],
  ADMIN_CHECKED: ['SHORTLISTED', 'NEEDS_INFORMATION', 'NOT_ELIGIBLE'],
  NEEDS_INFORMATION: ['SUBMITTED', 'ADMIN_CHECKED', 'NOT_ELIGIBLE'],
  SHORTLISTED: ['INTERVIEWED', 'NEEDS_INFORMATION', 'NOT_RECOMMENDED'],
  INTERVIEWED: ['RECOMMENDED', 'NOT_RECOMMENDED', 'NEEDS_INFORMATION'],
  RECOMMENDED: ['APPROVED', 'REJECTED', 'RETURNED_FOR_REVIEW'],
  RETURNED_FOR_REVIEW: ['RECOMMENDED', 'NOT_RECOMMENDED'],
};

export function assertRecruitmentTransition(current: string, next: string): void {
  if (!(recruitmentTransitions[current] || []).includes(next)) {
    throw new Error(`Invalid recruitment transition: ${current} -> ${next}.`);
  }
}
