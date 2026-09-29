/* =========================================================================
   FINANCIAL PLAN — calculation engine (pure functions, no DOM, no app state)
   Kept separate from tab-planner.js so it can be unit/stress-tested on its
   own. Mirrors the "Financial_Plan" spreadsheet it was modelled on:
     - one row per year, from (age+1) up to the retirement age
     - each year: FV(monthly rate, 12, -SIP, -start value), where the
       monthly rate is (1+annual)^(1/12)-1  [= NOMINAL(annual,12)/12]
     - SIP steps up by `stepUp` each year AFTER the first
   ...plus the extras common to good online planners (freefincal, FIRE
   calculators, step-up SIP calculators): inflation-adjusted value, required
   SIP for a goal, step-up vs flat comparison, Coast-FIRE check, safe-
   withdrawal income, and a return x step-up sensitivity grid.
   All money is in ONE consistent unit (whatever the caller uses).
   ========================================================================= */

function plannerNum(v, fallback){
  const n = (typeof v === 'number') ? v : parseFloat(v);
  return (isFinite(n)) ? n : (fallback === undefined ? 0 : fallback);
}

/* Effective annual rate -> equivalent monthly rate. Clamped so a nonsense
   rate (<= -100%) can't produce NaN/Infinity. */
function plannerMonthlyRate(annual){
  const a = Math.max(-0.99, plannerNum(annual));
  return Math.pow(1 + a, 1/12) - 1;
}

/* Value after 12 monthly deposits (end of month, Excel FV type 0) on top of
   a starting balance. Handles a 0% rate without dividing by zero. */
function plannerFvYear(start, monthlySip, annualReturn){
  const i = plannerMonthlyRate(annualReturn);
  if(Math.abs(i) < 1e-12) return start + monthlySip * 12;
  const g = Math.pow(1 + i, 12);
  return start * g + monthlySip * ((g - 1) / i);
}

/* Whole years between now and retirement. Never negative. */
function plannerYears(age, retireAge){
  return Math.max(0, Math.round(plannerNum(retireAge) - plannerNum(age)));
}

/* Year-by-year projection.
   opts: {age, retireAge, current, sip, stepUp, ret, inflation, years?}
   `years` overrides the horizon (used to look past the retirement age). */
function plannerProject(opts){
  const age = plannerNum(opts.age);
  const years = (opts.years !== undefined) ? Math.max(0, Math.round(opts.years)) : plannerYears(age, opts.retireAge);
  const stepUp = plannerNum(opts.stepUp);
  const ret = plannerNum(opts.ret);
  const infl = Math.max(-0.99, plannerNum(opts.inflation));
  let value = plannerNum(opts.current);
  let sip = plannerNum(opts.sip);
  let cumInvested = plannerNum(opts.current);
  const rows = [];
  for(let k = 1; k <= years; k++){
    if(k > 1) sip = sip * (1 + stepUp);
    const start = value;
    const end = plannerFvYear(start, sip, ret);
    const invested = sip * 12;
    cumInvested += invested;
    rows.push({
      year: k, age: age + k, start, sip, invested, cumInvested,
      growth: end - start - invested, end,
      real: end / Math.pow(1 + infl, k)
    });
    value = end;
  }
  return { rows, final: value, years };
}

/* Final value only (fast path used by the solver/grid). */
function plannerFinal(opts){
  return plannerProject(opts).final;
}

/* FV is LINEAR in the starting SIP (value = lump-sum growth + sip * k), so
   the SIP needed to hit a target has a closed form — no iteration needed.
   Returns 0 if the lump sum alone already gets there, or null if there are
   no years left to invest. */
function plannerRequiredSip(opts){
  const years = (opts.years !== undefined) ? opts.years : plannerYears(opts.age, opts.retireAge);
  if(years <= 0) return null;
  const base = Object.assign({}, opts, {sip: 0});
  const fv0 = plannerFinal(base);
  const fv1 = plannerFinal(Object.assign({}, opts, {sip: 1}));
  const k = fv1 - fv0;
  if(!(k > 0)) return null;
  const need = (plannerNum(opts.target) - fv0) / k;
  return need > 0 ? need : 0;
}

/* Age at which the plan first reaches the target if you simply keep going
   (SIP + step-up continue past the planned retirement age). Caps at 80 yrs. */
function plannerReachTarget(opts, maxYears){
  const target = plannerNum(opts.target);
  const cap = maxYears || 80;
  if(plannerNum(opts.current) >= target && target > 0) return { years: 0, age: plannerNum(opts.age), reached: true };
  if(!(target > 0)) return { years: 0, age: plannerNum(opts.age), reached: true };
  const proj = plannerProject(Object.assign({}, opts, {years: cap}));
  for(const r of proj.rows){
    if(r.end >= target) return { years: r.year, age: r.age, reached: true };
  }
  return { years: null, age: null, reached: false };
}

/* Coast-FIRE: does what you already have, left alone, reach the target by
   retirement? (No further SIP at all.) */
function plannerCoast(opts){
  const fv0 = plannerFinal(Object.assign({}, opts, {sip: 0}));
  return { value: fv0, coasting: plannerNum(opts.target) > 0 && fv0 >= plannerNum(opts.target) };
}

/* Return x step-up sensitivity grid. Rows: return -2%/base/+2%. Columns:
   step-up 0 / base / base+5pp (de-duplicated). */
function plannerSensitivity(opts){
  const r = plannerNum(opts.ret), s = plannerNum(opts.stepUp);
  const rets = [r - 0.02, r, r + 0.02];
  let steps = [0, s, s + 0.05];
  steps = steps.filter((v, i) => steps.indexOf(v) === i).sort((a, b) => a - b);
  if(steps.length < 3){ // s == 0 or s == 0.05 collide — pad to keep a 3-wide grid
    let extra = steps[steps.length - 1] + 0.05;
    while(steps.length < 3){ steps.push(extra); extra += 0.05; }
  }
  return {
    rets, steps,
    cells: rets.map(rr => steps.map(ss => plannerFinal(Object.assign({}, opts, {ret: rr, stepUp: ss}))))
  };
}

/* Sheet blocks "Short/Long Term Tax Calculation": post-tax return. */
function plannerPostTax(netReturn, taxRate){
  return plannerNum(netReturn) * (1 - Math.min(1, Math.max(0, plannerNum(taxRate))));
}

/* Safe-withdrawal-rate income: what a corpus supports per month. */
function plannerWithdrawal(corpus, swr, inflation, years){
  const monthly = plannerNum(corpus) * plannerNum(swr) / 12;
  return { monthly, monthlyReal: monthly / Math.pow(1 + Math.max(-0.99, plannerNum(inflation)), Math.max(0, years)) };
}

/* Corpus needed to sustain today's monthly spending at retirement:
   expenses inflated to retirement, divided by the withdrawal rate. */
function plannerFireNumber(monthlyExpenses, inflation, years, swr){
  if(!(plannerNum(swr) > 0)) return null;
  const inflated = plannerNum(monthlyExpenses) * 12 * Math.pow(1 + Math.max(-0.99, plannerNum(inflation)), Math.max(0, years));
  return inflated / plannerNum(swr);
}

/* Monthly-equivalent of a recurring buy plan (amount is per firing). */
function plannerMonthlyEquivalent(plan){
  if(!plan) return 0;
  const amt = plannerNum(plan.amount);
  if(!(amt > 0)) return 0;
  const f = plan.frequencyType || ((plan.daysOfMonth && plan.daysOfMonth.length) ? 'daysOfMonth' : 'monthly');
  switch(f){
    case 'daily':       return amt * 365.25 / 12;
    case 'weekly':      return amt * (365.25 / 7) / 12;
    case 'biweekly':    return amt * (365.25 / 14) / 12;
    case 'monthly':     return amt;
    case 'quarterly':   return amt / 3;
    case 'daysOfMonth': return amt * ((plan.daysOfMonth && plan.daysOfMonth.length) || 0);
    default:            return 0;
  }
}

/* Average of a 12-slot monthly array over months that actually have data,
   up to and including `uptoIdx` (so untouched future months don't drag the
   average down). Returns {avg, months}. */
function plannerAverageActive(arr, uptoIdx){
  const last = (uptoIdx === undefined || uptoIdx === null) ? 11 : Math.min(11, Math.max(0, uptoIdx));
  let sum = 0, n = 0;
  for(let i = 0; i <= last; i++){
    const v = plannerNum((arr || [])[i]);
    if(v > 0){ sum += v; n++; }
  }
  return { avg: n ? sum / n : 0, months: n };
}

/* Plain-language health checks shown above the results. */
function plannerInsights(x){
  const out = [];
  const years = plannerYears(x.age, x.retireAge);
  if(years <= 0) out.push({level:'bad', text:'Retirement age must be greater than your current age.'});
  if(x.ret >= 0.18) out.push({level:'warn', text:`A ${(x.ret*100).toFixed(1)}%/yr return is aggressive for a long horizon — try the sensitivity grid below with a lower rate.`});
  if(x.ret < x.inflation) out.push({level:'warn', text:'Your expected return is below inflation — the money loses buying power even while it grows.'});
  if(x.salary > 0 && x.sip > x.salary) out.push({level:'bad', text:'Your monthly SIP is larger than your monthly salary — check both numbers.'});
  if(x.salary > 0 && x.sip > 0 && x.sip / x.salary > 0.5) out.push({level:'warn', text:`SIP is ${(x.sip/x.salary*100).toFixed(0)}% of salary — very high; make sure it's sustainable.`});
  if(x.requiredSip !== null && x.requiredSip !== undefined && x.salary > 0 && x.requiredSip > x.salary * 0.5 && x.requiredSip > x.sip)
    out.push({level:'warn', text:'Reaching the goal on time needs more than half your salary as SIP — consider a later age, lower target, or higher step-up.'});
  if(x.target > 0 && x.projected >= x.target && years > 0) out.push({level:'good', text:'On track: your projected corpus meets or beats the goal by retirement.'});
  if(x.target > 0 && x.projected < x.target && years > 0) out.push({level:'info', text:'Below goal at the planned age — see “Required SIP” and “Age you’d reach it” for ways to close the gap.'});
  if(x.emergencyMonths !== null && x.emergencyMonths !== undefined && x.emergencyMonths < 3 && x.monthlyExpenses > 0)
    out.push({level:'warn', text:`Emergency fund covers only ${x.emergencyMonths.toFixed(1)} months of expenses — 3–6 months is the usual guideline.`});
  return out;
}

/* Forgiving amount parser for the input boxes: "1,00,000", "$2.5m", "₹1.2cr",
   "50L", "40k", "1e6". Returns a number, or null if it isn't a number. */
function plannerParseAmount(str){
  if(typeof str === 'number') return isFinite(str) ? str : null;
  if(str === null || str === undefined) return null;
  let s = String(str).trim().toLowerCase().replace(/[,\s$₹]/g, '').replace(/^\((.*)\)$/, '-$1');
  if(s === '') return null;
  const m = s.match(/^(-?\d*\.?\d+(?:e[+-]?\d+)?)(k|l|lac|lacs|lakh|lakhs|cr|crore|crores|m|mn|mm|b|bn)?$/);
  if(!m) return null;
  let n = parseFloat(m[1]);
  const mult = { k:1e3, l:1e5, lac:1e5, lacs:1e5, lakh:1e5, lakhs:1e5, cr:1e7, crore:1e7, crores:1e7, m:1e6, mn:1e6, mm:1e6, b:1e9, bn:1e9 };
  if(m[2]) n *= mult[m[2]];
  return isFinite(n) ? n : null;
}
/* "10", "10%", "0.5" -> 0.10 / 0.10 / 0.005 (typed as a percent). */
function plannerParsePercent(str){
  if(typeof str === 'string') str = str.replace('%', '');
  const n = plannerParseAmount(str);
  return n === null ? null : n / 100;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    plannerNum, plannerMonthlyRate, plannerFvYear, plannerYears, plannerProject, plannerFinal,
    plannerRequiredSip, plannerReachTarget, plannerCoast, plannerSensitivity, plannerPostTax,
    plannerWithdrawal, plannerFireNumber, plannerMonthlyEquivalent, plannerAverageActive, plannerInsights,
    plannerParseAmount, plannerParsePercent
  };
}