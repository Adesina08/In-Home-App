// Significance tests for reporting (framework section 15: "Methods should be
// configurable and documented; notation should be consistent").
//
// Two tests, both two-tailed:
//   proportions -- pooled two-proportion z-test (column % vs column %);
//   means       -- Welch's t-test (unequal variances), with the exact
//                  t-distribution so small bases are not overstated.
// They assume independent samples. Columns that share people (e.g. two
// options of a multi-select banner) are tested as if independent, which
// overstates confidence; the crosstab export says so.

/** Standard normal CDF (Abramowitz & Stegun 7.1.26; error < 1.5e-7). */
function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const v of c) ser += v / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Continued fraction for the regularised incomplete beta (Numerical Recipes betacf).
function betaContinuedFraction(a, b, x) {
  const EPS = 3e-14, FPMIN = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(a, b, x)) / a : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-tailed p-value of a t statistic with `df` degrees of freedom. */
function tTwoTailed(t, df) {
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

/** Pooled two-proportion z-test. Returns { z, p } or null when it cannot be tested. */
function proportions(x1, n1, x2, n2) {
  if (!(n1 > 0 && n2 > 0)) return null;
  const p1 = x1 / n1, p2 = x2 / n2, pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!se) return null; // both 0% or both 100%
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Welch's t-test from summary statistics. Returns { t, df, p } or null. */
function means(m1, sd1, n1, m2, sd2, n2) {
  if (!(n1 > 1 && n2 > 1)) return null;
  const v1 = (sd1 * sd1) / n1, v2 = (sd2 * sd2) / n2;
  const se = Math.sqrt(v1 + v2);
  if (!se) return null;
  const t = (m1 - m2) / se;
  const df = (v1 + v2) ** 2 / ((v1 * v1) / (n1 - 1) + (v2 * v2) / (n2 - 1));
  return { t, df, p: tTwoTailed(t, df) };
}

const LEVELS = { "90": 0.9, "95": 0.95, "99": 0.99 };

/** Column letters A, B, … Z, AA, AB … */
function letter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

module.exports = { normalCdf, proportions, means, tTwoTailed, LEVELS, letter };
