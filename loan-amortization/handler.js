// --- Configuration constants ---
// Centralized here so limits can be tuned in one place instead of hunting
// for magic numbers scattered through validation logic.
const MAX_TERM_MONTHS = 600;
const MAX_INTEREST_RATE = 1;

/**
 * Lambda entry point for the loan amortization API.
 * Invoked by API Gateway (HTTP API) on POST /amortization.
 *
 * @param {object} event - API Gateway proxy event; event.body is a JSON string.
 * @param {object} context - Lambda context, used here only for the request ID.
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
export const handler = async (event, context) => {
  const requestId = context?.awsRequestId || event?.requestContext?.requestId || 'local';

  try {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return response(400, { error: 'Invalid JSON body', requestId });
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return response(400, { error: 'Request body must be a JSON object', requestId });
    }

    console.log(JSON.stringify({ level: 'INFO', requestId, event: 'request_received', body }));

    const errors = validate(body);
    if (errors.length > 0) {
      console.log(JSON.stringify({ level: 'WARN', requestId, event: 'validation_failed', errors }));
      return response(400, { error: 'Validation failed', requestId, details: errors });
    }

    const startDate = body.start_date ? new Date(body.start_date) : new Date();

    // Efficiency: the full schedule is always calculated below, but if the
    // caller doesn't need it (include_schedule: false), we leave it out of
    // the response instead of sending it. For a 360-month loan, that's the
    // difference between a multi-KB response and a ~200 byte one.
    const includeSchedule = body.include_schedule !== false;

    const schedule = calculateAmortizationSchedule({
      principal: body.principal,
      annualInterestRate: body.annual_interest_rate,
      termMonths: body.term_months,
      startDate,
      extraPayment: body.extra_payment || 0,
    });

    const totalInterest = round2(schedule.reduce((sum, e) => sum + e.interest, 0));
    const totalPaid = round2(body.principal + totalInterest);

    console.log(JSON.stringify({
      level: 'INFO', requestId, event: 'amortization_calculated',
      termMonths: body.term_months, periodsReturned: includeSchedule ? schedule.length : 0,
    }));

    return response(200, {
      monthly_payment: schedule[0].payment,
      total_interest: totalInterest,
      total_paid: totalPaid,
      ...(includeSchedule && {
        schedule: schedule.map((e) => ({
          period: e.period,
          payment_date: e.paymentDate,
          payment: e.payment,
          principal: e.principal,
          interest: e.interest,
          remaining_balance: e.remainingBalance,
        })),
      }),
    });
  } catch (err) {
    console.log(JSON.stringify({
      level: 'ERROR', requestId, event: 'unhandled_exception',
      message: err.message, stack: err.stack,
    }));
    return response(500, { error: 'Internal server error', requestId });
  }
};

/**
 * Builds a consistent API Gateway proxy response.
 * Centralizing this guarantees every response — success or error —
 * carries the same headers, so nothing forgets CORS or cache-control.
 *
 * @param {number} statusCode
 * @param {object} body - Will be JSON.stringify'd as the response body.
 */
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Validates the parsed request body against the API's input contract.
 * Returns an array of human-readable error strings (empty if valid).
 *
 * @param {object} body - Parsed JSON request body.
 * @returns {string[]} List of validation error messages.
 */
function validate(body) {
  const errors = [];
  const {
    principal,
    annual_interest_rate,
    term_months,
    start_date,
    extra_payment = 0,
    include_schedule,
  } = body;

  if (typeof principal !== 'number' || !Number.isFinite(principal) || principal <= 0) {
    errors.push('principal must be a finite number > 0');
  }
  if (
    typeof annual_interest_rate !== 'number' ||
    !Number.isFinite(annual_interest_rate) ||
    annual_interest_rate < 0 ||
    annual_interest_rate > MAX_INTEREST_RATE
  ) {
    errors.push(`annual_interest_rate must be a finite number between 0 and ${MAX_INTEREST_RATE}`);
  }
  if (!Number.isInteger(term_months) || term_months <= 0 || term_months > MAX_TERM_MONTHS) {
    errors.push(`term_months must be an integer between 1 and ${MAX_TERM_MONTHS}`);
  }
  if (start_date !== undefined && isNaN(Date.parse(start_date))) {
    errors.push('start_date must be a valid date (YYYY-MM-DD)');
  }
  if (
    typeof extra_payment !== 'number' ||
    !Number.isFinite(extra_payment) ||
    extra_payment < 0
  ) {
    errors.push('extra_payment must be a finite number >= 0');
  }
  if (include_schedule !== undefined && typeof include_schedule !== 'boolean') {
    errors.push('include_schedule must be a boolean');
  }

  return errors;
}

/**
 * Computes a full amortization schedule for a fixed-rate loan.
 *
 * @param {object} params
 * @param {number} params.principal - Loan amount.
 * @param {number} params.annualInterestRate - Annual rate as a decimal (e.g. 0.06 = 6%).
 * @param {number} params.termMonths - Loan term in months.
 * @param {Date} params.startDate - First payment date.
 * @param {number} [params.extraPayment=0] - Extra principal paid each period.
 * @returns {object[]} One entry per payment period.
 */
function calculateAmortizationSchedule({
  principal,
  annualInterestRate,
  termMonths,
  startDate,
  extraPayment = 0,
}) {
  const monthlyRate = annualInterestRate / 12;

  let payment;
  if (monthlyRate === 0) {
    payment = principal / termMonths;
  } else {
    payment =
      (principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths))) /
      (Math.pow(1 + monthlyRate, termMonths) - 1);
  }

  const schedule = [];
  let balance = principal;

  for (let period = 1; period <= termMonths; period++) {
    const interest = balance * monthlyRate;
    const principalPaid = Math.min(payment - interest + extraPayment, balance);
    balance -= principalPaid;

    // UTC-only date math — mixing UTC parsing with local setMonth()/getMonth()
    // shifts results by a day depending on server timezone. Caught in testing.
    const paymentDate = new Date(Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth() + (period - 1),
      startDate.getUTCDate()
    ));

    schedule.push({
      period,
      paymentDate: paymentDate.toISOString().split('T')[0],
      payment: round2(principalPaid + interest),
      principal: round2(principalPaid),
      interest: round2(interest),
      remainingBalance: round2(Math.max(balance, 0)),
    });

    if (balance <= 0) break;
  }

  return schedule;
}

/**
 * Rounds a number to 2 decimal places (currency-safe rounding).
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

// Named export purely for convenience if you ever unit-test the math
// directly. AWS Lambda only invokes the 'handler' export above — this
// doesn't affect what gets deployed or how the function runs in the console.
export { calculateAmortizationSchedule };
