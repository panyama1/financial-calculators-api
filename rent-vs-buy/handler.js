// --- Configuration constants ---
const MAX_RATE = 1; // 100% ceiling for interest/escalation rates
const MAX_APPRECIATION_RATE = 1; // allows -100% to +100% annual change
const MAX_AMORTIZATION_YEARS = 40;
const MAX_HORIZON_YEARS = 40;

/**
 * Lambda entry point: Commercial Lease Rent vs. Buy analysis.
 * Invoked by API Gateway (HTTP API) on POST /rent-vs-buy.
 *
 * ASSUMPTION / SCOPE NOTE: converting a $/sqft lease rate and a purchase
 * price into a real year-by-year comparison requires inputs beyond the
 * original 5 listed — square footage (to size the lease cost) and the buy
 * scenario's loan terms (rate + amortization) and an analysis horizon.
 * Those are added here as required inputs.
 *
 * This model compares cumulative lease payments against the buy scenario's
 * "net cost" (cash outlaid minus equity built via principal paydown +
 * appreciation). It intentionally excludes property tax, insurance,
 * maintenance, and income-tax depreciation benefits — those require a tax
 * rate and operating-cost inputs not specified, and are noted here as a
 * scope limitation rather than silently assumed away.
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

    const {
      square_footage,
      lease_cost_per_sqft,
      lease_escalation_pct,
      purchase_price,
      down_payment,
      annual_interest_rate,
      amortization_years,
      property_appreciation_rate,
      analysis_horizon_years,
    } = body;

    const comparison = buildComparison({
      squareFootage: square_footage,
      leaseCostPerSqft: lease_cost_per_sqft,
      leaseEscalationPct: lease_escalation_pct,
      purchasePrice: purchase_price,
      downPayment: down_payment,
      annualInterestRate: annual_interest_rate,
      amortizationYears: amortization_years,
      appreciationRate: property_appreciation_rate,
      horizonYears: analysis_horizon_years,
    });

    const breakEvenYear = comparison.find((y) => y.buy_net_cost <= y.lease_cumulative_cost);
    const last = comparison[comparison.length - 1];

    console.log(JSON.stringify({
      level: 'INFO', requestId, event: 'rent_vs_buy_calculated',
      horizonYears: analysis_horizon_years,
      breakEvenYear: breakEvenYear ? breakEvenYear.year : null,
    }));

    return response(200, {
      break_even_ownership_year: breakEvenYear ? breakEvenYear.year : null,
      total_lease_cost_at_horizon: last.lease_cumulative_cost,
      total_buy_net_cost_at_horizon: last.buy_net_cost,
      comparison_by_year: comparison,
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
    square_footage,
    lease_cost_per_sqft,
    lease_escalation_pct,
    purchase_price,
    down_payment,
    annual_interest_rate,
    amortization_years,
    property_appreciation_rate,
    analysis_horizon_years,
  } = body;

  if (typeof square_footage !== 'number' || !Number.isFinite(square_footage) || square_footage <= 0) {
    errors.push('square_footage must be a finite number > 0');
  }
  if (
    typeof lease_cost_per_sqft !== 'number' ||
    !Number.isFinite(lease_cost_per_sqft) ||
    lease_cost_per_sqft <= 0
  ) {
    errors.push('lease_cost_per_sqft must be a finite number > 0');
  }
  if (
    typeof lease_escalation_pct !== 'number' ||
    !Number.isFinite(lease_escalation_pct) ||
    lease_escalation_pct < 0 ||
    lease_escalation_pct > MAX_RATE
  ) {
    errors.push(`lease_escalation_pct must be a finite number between 0 and ${MAX_RATE}`);
  }
  if (typeof purchase_price !== 'number' || !Number.isFinite(purchase_price) || purchase_price <= 0) {
    errors.push('purchase_price must be a finite number > 0');
  }
  if (
    typeof down_payment !== 'number' ||
    !Number.isFinite(down_payment) ||
    down_payment < 0 ||
    (typeof purchase_price === 'number' && down_payment > purchase_price)
  ) {
    errors.push('down_payment must be a finite number >= 0 and <= purchase_price');
  }
  if (
    typeof annual_interest_rate !== 'number' ||
    !Number.isFinite(annual_interest_rate) ||
    annual_interest_rate < 0 ||
    annual_interest_rate > MAX_RATE
  ) {
    errors.push(`annual_interest_rate must be a finite number between 0 and ${MAX_RATE}`);
  }
  if (
    !Number.isInteger(amortization_years) ||
    amortization_years <= 0 ||
    amortization_years > MAX_AMORTIZATION_YEARS
  ) {
    errors.push(`amortization_years must be an integer between 1 and ${MAX_AMORTIZATION_YEARS}`);
  }
  if (
    typeof property_appreciation_rate !== 'number' ||
    !Number.isFinite(property_appreciation_rate) ||
    property_appreciation_rate < -MAX_APPRECIATION_RATE ||
    property_appreciation_rate > MAX_APPRECIATION_RATE
  ) {
    errors.push(
      `property_appreciation_rate must be a finite number between -${MAX_APPRECIATION_RATE} and ${MAX_APPRECIATION_RATE}`
    );
  }
  if (
    !Number.isInteger(analysis_horizon_years) ||
    analysis_horizon_years <= 0 ||
    analysis_horizon_years > MAX_HORIZON_YEARS
  ) {
    errors.push(`analysis_horizon_years must be an integer between 1 and ${MAX_HORIZON_YEARS}`);
  }

  return errors;
}

/**
 * Builds a year-by-year lease vs. buy comparison.
 * @returns {object[]} One entry per year of the analysis horizon.
 */
function buildComparison({
  squareFootage,
  leaseCostPerSqft,
  leaseEscalationPct,
  purchasePrice,
  downPayment,
  annualInterestRate,
  amortizationYears,
  appreciationRate,
  horizonYears,
}) {
  const loanAmount = purchasePrice - downPayment;
  const monthlyRate = annualInterestRate / 12;
  const totalMonths = amortizationYears * 12;

  let monthlyPayment;
  if (loanAmount <= 0) {
    monthlyPayment = 0;
  } else if (monthlyRate === 0) {
    monthlyPayment = loanAmount / totalMonths;
  } else {
    monthlyPayment =
      (loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, totalMonths))) /
      (Math.pow(1 + monthlyRate, totalMonths) - 1);
  }

  let balance = loanAmount;
  let cumulativeLeaseCost = 0;
  let cumulativeBuyCashOutlay = downPayment;
  const results = [];

  for (let year = 1; year <= horizonYears; year++) {
    const leaseCostThisYear =
      squareFootage * leaseCostPerSqft * Math.pow(1 + leaseEscalationPct, year - 1);
    cumulativeLeaseCost += leaseCostThisYear;

    let debtServiceThisYear = 0;
    for (let m = 0; m < 12; m++) {
      if (balance <= 0) break;
      const interestPortion = balance * monthlyRate;
      const principalPortion = Math.min(monthlyPayment - interestPortion, balance);
      balance -= principalPortion;
      debtServiceThisYear += principalPortion + interestPortion;
    }
    cumulativeBuyCashOutlay += debtServiceThisYear;

    const propertyValue = purchasePrice * Math.pow(1 + appreciationRate, year);
    const equity = propertyValue - Math.max(balance, 0);
    const buyNetCost = cumulativeBuyCashOutlay - equity;

    results.push({
      year,
      lease_annual_cost: round2(leaseCostThisYear),
      lease_cumulative_cost: round2(cumulativeLeaseCost),
      buy_debt_service_this_year: round2(debtServiceThisYear),
      buy_equity: round2(equity),
      buy_net_cost: round2(buyNetCost),
    });
  }

  return results;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
