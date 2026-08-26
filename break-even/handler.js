// --- Configuration constants ---
const DAYS_PER_MONTH = 30; // simplification, documented
const DEFAULT_SENSITIVITY_DELTAS = [0.01, 0.03, 0.05]; // +1pt, +3pt, +5pt variable cost shocks

/**
 * Lambda entry point: Multi-Unit Operating Break-Even & Contribution Margin.
 * Invoked by API Gateway (HTTP API) on POST /break-even.
 *
 * ASSUMPTION: "margin_of_safety_percentage" requires a projected/actual
 * sales figure to compare against breakeven — not in the original 3-input
 * spec. Added as an optional input (projected_monthly_revenue); if omitted,
 * that field returns null rather than a fabricated number.
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
      fixed_monthly_costs,
      average_ticket_size,
      variable_cost_percentage,
      projected_monthly_revenue,
    } = body;
    const sensitivityDeltas = body.sensitivity_deltas || DEFAULT_SENSITIVITY_DELTAS;

    const contributionMarginPct = 1 - variable_cost_percentage;
    const breakevenRevenue = fixed_monthly_costs / contributionMarginPct;
    const breakevenUnitsPerMonth = breakevenRevenue / average_ticket_size;
    const breakevenUnitsPerDay = breakevenUnitsPerMonth / DAYS_PER_MONTH;

    const marginOfSafetyPercentage =
      typeof projected_monthly_revenue === 'number'
        ? round2(((projected_monthly_revenue - breakevenRevenue) / projected_monthly_revenue) * 100)
        : null;

    const sensitivityAnalysis = sensitivityDeltas.map((delta) => {
      const adjustedVcp = Math.min(variable_cost_percentage + delta, 0.99);
      const adjustedMargin = 1 - adjustedVcp;
      return {
        delta_percentage_points: round2(delta * 100),
        adjusted_variable_cost_percentage: round2(adjustedVcp * 100),
        breakeven_revenue: round2(fixed_monthly_costs / adjustedMargin),
      };
    });

    console.log(JSON.stringify({
      level: 'INFO', requestId, event: 'breakeven_calculated', breakevenRevenue,
    }));

    return response(200, {
      contribution_margin_percentage: round2(contributionMarginPct * 100),
      breakeven_revenue: round2(breakevenRevenue),
      breakeven_units_per_month: round2(breakevenUnitsPerMonth),
      breakeven_units_per_day: round2(breakevenUnitsPerDay),
      margin_of_safety_percentage: marginOfSafetyPercentage,
      sensitivity_analysis: sensitivityAnalysis,
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
    fixed_monthly_costs,
    average_ticket_size,
    variable_cost_percentage,
    projected_monthly_revenue,
    sensitivity_deltas,
  } = body;

  if (
    typeof fixed_monthly_costs !== 'number' ||
    !Number.isFinite(fixed_monthly_costs) ||
    fixed_monthly_costs <= 0
  ) {
    errors.push('fixed_monthly_costs must be a finite number > 0');
  }
  if (
    typeof average_ticket_size !== 'number' ||
    !Number.isFinite(average_ticket_size) ||
    average_ticket_size <= 0
  ) {
    errors.push('average_ticket_size must be a finite number > 0');
  }
  if (
    typeof variable_cost_percentage !== 'number' ||
    !Number.isFinite(variable_cost_percentage) ||
    variable_cost_percentage < 0 ||
    variable_cost_percentage >= 1
  ) {
    errors.push('variable_cost_percentage must be a finite number >= 0 and < 1');
  }
  if (
    projected_monthly_revenue !== undefined &&
    (typeof projected_monthly_revenue !== 'number' ||
      !Number.isFinite(projected_monthly_revenue) ||
      projected_monthly_revenue < 0)
  ) {
    errors.push('projected_monthly_revenue, if provided, must be a finite number >= 0');
  }
  if (
    sensitivity_deltas !== undefined &&
    (!Array.isArray(sensitivity_deltas) ||
      !sensitivity_deltas.every((d) => typeof d === 'number' && Number.isFinite(d)))
  ) {
    errors.push('sensitivity_deltas, if provided, must be an array of finite numbers');
  }

  return errors;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
