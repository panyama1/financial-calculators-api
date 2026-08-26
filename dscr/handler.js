// --- Configuration constants ---
const DEFAULT_DSCR_THRESHOLD = 1.25; // Standard bank minimum for commercial loans
const MAX_INTEREST_RATE = 1;
const MAX_AMORTIZATION_YEARS = 40;

/**
 * Lambda entry point: Commercial DSCR & Loan Sizing calculator.
 * Invoked by API Gateway (HTTP API) on POST /dscr.
 *
 * ASSUMPTION: the requested output "max_allowable_loan_amount" requires a
 * loan interest rate and amortization term to convert a dollar-denominated
 * debt service budget into a loan principal — these weren't in the original
 * input spec, so they're added as required inputs here.
 *
 * @param {object} event
 * @param {object} context
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

    const dscrThreshold = body.dscr_threshold ?? DEFAULT_DSCR_THRESHOLD;

    const netOperatingIncome = body.gross_revenue - body.operating_expenses;
    const dscrRatio = round2(netOperatingIncome / body.proposed_annual_debt);
    const isApprovable = dscrRatio >= dscrThreshold;

    const maxAnnualDebtService = netOperatingIncome / dscrThreshold;
    const monthlyRate = body.annual_interest_rate / 12;
    const n = body.amortization_years * 12;
    const maxMonthlyDebtService = maxAnnualDebtService / 12;

    let maxAllowableLoanAmount;
    if (monthlyRate === 0) {
      maxAllowableLoanAmount = maxMonthlyDebtService * n;
    } else {
      maxAllowableLoanAmount =
        (maxMonthlyDebtService * (1 - Math.pow(1 + monthlyRate, -n))) / monthlyRate;
    }

    console.log(JSON.stringify({
      level: 'INFO', requestId, event: 'dscr_calculated', dscrRatio, isApprovable,
    }));

    return response(200, {
      dscr_ratio: dscrRatio,
      is_approvable: isApprovable,
      dscr_threshold_used: dscrThreshold,
      net_operating_income: round2(netOperatingIncome),
      max_allowable_annual_debt_service: round2(Math.max(maxAnnualDebtService, 0)),
      max_allowable_loan_amount: round2(Math.max(maxAllowableLoanAmount, 0)),
    });
  } catch (err) {
    console.log(JSON.stringify({
      level: 'ERROR', requestId, event: 'unhandled_exception',
      message: err.message, stack: err.stack,
    }));
    return response(500, { error: 'Internal server error', requestId });
  }
};

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

function validate(body) {
  const errors = [];
  const {
    gross_revenue,
    operating_expenses,
    proposed_annual_debt,
    annual_interest_rate,
    amortization_years,
    dscr_threshold,
  } = body;

  if (typeof gross_revenue !== 'number' || !Number.isFinite(gross_revenue) || gross_revenue <= 0) {
    errors.push('gross_revenue must be a finite number > 0');
  }
  if (
    typeof operating_expenses !== 'number' ||
    !Number.isFinite(operating_expenses) ||
    operating_expenses < 0
  ) {
    errors.push('operating_expenses must be a finite number >= 0');
  }
  if (
    typeof proposed_annual_debt !== 'number' ||
    !Number.isFinite(proposed_annual_debt) ||
    proposed_annual_debt <= 0
  ) {
    errors.push('proposed_annual_debt must be a finite number > 0');
  }
  if (
    typeof annual_interest_rate !== 'number' ||
    !Number.isFinite(annual_interest_rate) ||
    annual_interest_rate < 0 ||
    annual_interest_rate > MAX_INTEREST_RATE
  ) {
    errors.push(`annual_interest_rate must be a finite number between 0 and ${MAX_INTEREST_RATE}`);
  }
  if (
    !Number.isInteger(amortization_years) ||
    amortization_years <= 0 ||
    amortization_years > MAX_AMORTIZATION_YEARS
  ) {
    errors.push(`amortization_years must be an integer between 1 and ${MAX_AMORTIZATION_YEARS}`);
  }
  if (
    dscr_threshold !== undefined &&
    (typeof dscr_threshold !== 'number' || !Number.isFinite(dscr_threshold) || dscr_threshold <= 0)
  ) {
    errors.push('dscr_threshold, if provided, must be a finite number > 0');
  }

  return errors;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
