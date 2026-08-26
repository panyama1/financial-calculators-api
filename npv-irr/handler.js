// --- Configuration constants ---
const MAX_DISCOUNT_RATE = 2; // 200% ceiling — generous enough for venture-style rates
const MAX_CASH_FLOW_YEARS = 50;
const IRR_LOW_BOUND = -0.9999; // just above -100%, avoids division by zero
const IRR_HIGH_BOUND = 10; // 1000% ceiling for the search range
const IRR_MAX_ITERATIONS = 100;
const IRR_TOLERANCE = 1e-6;

/**
 * Lambda entry point: NPV & IRR calculator for multi-year capital projects.
 * Invoked by API Gateway (HTTP API) on POST /npv-irr.
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

    const { initial_investment, cash_flows_by_year, discount_rate } = body;

    const npvValue = calculateNPV(initial_investment, cash_flows_by_year, discount_rate);
    const irr = calculateIRR(initial_investment, cash_flows_by_year);
    const paybackPeriodYears = calculatePaybackPeriod(initial_investment, cash_flows_by_year);

    console.log(JSON.stringify({
      level: 'INFO', requestId, event: 'npv_irr_calculated',
      npvValue, irrFound: irr !== null,
    }));

    return response(200, {
      npv_value: round2(npvValue),
      irr_percentage: irr === null ? null : round2(irr * 100),
      payback_period_years: paybackPeriodYears === null ? null : round2(paybackPeriodYears),
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
  const { initial_investment, cash_flows_by_year, discount_rate } = body;

  if (
    typeof initial_investment !== 'number' ||
    !Number.isFinite(initial_investment) ||
    initial_investment <= 0
  ) {
    errors.push('initial_investment must be a finite number > 0');
  }
  if (!Array.isArray(cash_flows_by_year) || cash_flows_by_year.length === 0) {
    errors.push('cash_flows_by_year must be a non-empty array');
  } else if (cash_flows_by_year.length > MAX_CASH_FLOW_YEARS) {
    errors.push(`cash_flows_by_year must contain at most ${MAX_CASH_FLOW_YEARS} entries`);
  } else if (!cash_flows_by_year.every((cf) => typeof cf === 'number' && Number.isFinite(cf))) {
    errors.push('cash_flows_by_year must contain only finite numbers');
  }
  if (
    typeof discount_rate !== 'number' ||
    !Number.isFinite(discount_rate) ||
    discount_rate < 0 ||
    discount_rate > MAX_DISCOUNT_RATE
  ) {
    errors.push(`discount_rate must be a finite number between 0 and ${MAX_DISCOUNT_RATE}`);
  }

  return errors;
}

/**
 * @param {number} initialInvestment
 * @param {number[]} cashFlows - Cash flow for year 1, 2, 3, ... in order.
 * @param {number} rate - Discount rate as a decimal.
 * @returns {number}
 */
function npvAt(initialInvestment, cashFlows, rate) {
  return (
    -initialInvestment +
    cashFlows.reduce((sum, cf, idx) => sum + cf / Math.pow(1 + rate, idx + 1), 0)
  );
}

function calculateNPV(initialInvestment, cashFlows, discountRate) {
  return npvAt(initialInvestment, cashFlows, discountRate);
}

/**
 * Solves for the discount rate where NPV = 0 using bisection — chosen over
 * Newton-Raphson because it always converges given a valid bracket, with no
 * risk of derivative-related instability on irregular cash flow patterns.
 *
 * @returns {number|null} IRR as a decimal, or null if no root exists in the
 *   search range (e.g. all cash flows are the same sign as the investment).
 */
function calculateIRR(initialInvestment, cashFlows) {
  let low = IRR_LOW_BOUND;
  let high = IRR_HIGH_BOUND;
  let npvLow = npvAt(initialInvestment, cashFlows, low);
  let npvHigh = npvAt(initialInvestment, cashFlows, high);

  // No sign change across the bracket means no root — IRR is undefined
  // for this cash flow pattern within the search range.
  if (npvLow === 0) return low;
  if (npvHigh === 0) return high;
  if ((npvLow > 0 && npvHigh > 0) || (npvLow < 0 && npvHigh < 0)) {
    return null;
  }

  for (let i = 0; i < IRR_MAX_ITERATIONS; i++) {
    const mid = (low + high) / 2;
    const npvMid = npvAt(initialInvestment, cashFlows, mid);

    if (Math.abs(npvMid) < IRR_TOLERANCE) {
      return mid;
    }

    if ((npvMid > 0 && npvLow > 0) || (npvMid < 0 && npvLow < 0)) {
      low = mid;
      npvLow = npvMid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

/**
 * Finds the fractional year at which cumulative cash flow first reaches
 * zero, using linear interpolation within the crossing year.
 * @returns {number|null} Years to payback, or null if never within the
 *   given cash flow horizon.
 */
function calculatePaybackPeriod(initialInvestment, cashFlows) {
  let cumulative = -initialInvestment;

  for (let i = 0; i < cashFlows.length; i++) {
    const before = cumulative;
    cumulative += cashFlows[i];

    if (cumulative >= 0) {
      if (cashFlows[i] === 0) return i + 1;
      const fraction = -before / cashFlows[i];
      return i + fraction;
    }
  }

  return null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
