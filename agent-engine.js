/* Agentic Finance Crew — deterministic decision engine (client-side port).
 *
 * Faithful JavaScript port of the Python `finance_crew` domain layer
 * (models/tools/decision/pipeline). No LLM, no network — the model advises,
 * this deterministic guardrail decides. Runs entirely in the browser so the
 * Hugging Face Static Space is free to host.
 *
 * Source of truth: https://github.com/furqunali/agentic-finance-crew
 */
(function (global) {
  "use strict";

  const POLICY = {
    auto_approve_limit: 200.0,
    human_review_limit: 2000.0,
    receipt_required_above: 50.0,
    category_limits: {
      travel: 1500.0, meals: 100.0, software: 1000.0,
      equipment: 3000.0, other: 500.0,
    },
  };
  const limitFor = (c) => POLICY.category_limits[c] ?? POLICY.category_limits.other;

  const VALID = new Set(["travel", "meals", "software", "equipment", "other"]);
  const ALIASES = {
    flight: "travel", hotel: "travel", taxi: "travel", uber: "travel",
    food: "meals", lunch: "meals", dinner: "meals", restaurant: "meals",
    saas: "software", subscription: "software", license: "software",
    hardware: "equipment", laptop: "equipment", device: "equipment",
  };

  function normalizeCategory(category) {
    let c = (category || "").trim().toLowerCase();
    c = ALIASES[c] || c;
    return VALID.has(c) ? c : "other";
  }

  function runIntake(req) {
    const issues = [];
    if (!req.employee) issues.push("missing employee");
    if (!req.id) issues.push("missing request id");
    if (req.amount <= 0) issues.push("amount must be positive");
    if (req.amount > 100000) issues.push("amount implausibly large");
    const normalized = normalizeCategory(req.category);
    if (normalized === "other" && req.category &&
        !VALID.has(String(req.category).toLowerCase())) {
      issues.push(`unknown category '${req.category}' mapped to 'other'`);
    }
    const valid = !issues.some((i) => i.startsWith("missing") || i.startsWith("amount"));
    return { valid, normalized_category: normalized, issues };
  }

  function checkPolicy(req, category) {
    const v = [];
    const limit = limitFor(category);
    if (req.amount > limit)
      v.push(`amount $${fmt(req.amount)} exceeds ${category} limit $${fmt(limit)}`);
    if (req.amount > POLICY.receipt_required_above && !req.has_receipt)
      v.push(`receipt required for amounts over $${fmt(POLICY.receipt_required_above)}`);
    if (req.amount > POLICY.human_review_limit)
      v.push(`amount over $${fmt(POLICY.human_review_limit)} always needs human sign-off`);
    return v;
  }

  function computeRisk(req, category, violations) {
    const limit = limitFor(category);
    const ratio = limit ? Math.min(req.amount / limit, 2.0) : 1.0;
    let score = Math.floor(ratio * 30);
    score += 20 * violations.length;
    if (!req.has_receipt && req.amount > POLICY.receipt_required_above) score += 10;
    return Math.max(0, Math.min(score, 100));
  }

  function detectDuplicate(req, history) {
    return (history || []).some(
      (h) => h.id !== req.id && h.employee === req.employee &&
        Math.abs(h.amount - req.amount) < 0.01 &&
        normalizeCategory(h.category) === normalizeCategory(req.category));
  }

  function analyze(req, category, history) {
    let violations = checkPolicy(req, category);
    let risk = computeRisk(req, category, violations);
    const dup = detectDuplicate(req, history || []);
    if (dup) {
      violations = violations.concat(["possible duplicate of an earlier request"]);
      risk = Math.min(risk + 15, 100);
    }
    return { violations, risk_score: risk, is_possible_duplicate: dup };
  }

  function decide(req, intake, analysis) {
    if (!intake.valid) {
      return verdict("rejected",
        "Request failed intake validation: " + intake.issues.join("; "),
        analysis, 0.95, intake);
    }
    const overHuman = req.amount > POLICY.human_review_limit;
    const hasViolation = analysis.violations.length > 0;
    const highRisk = analysis.risk_score >= 60;
    if (overHuman || hasViolation || highRisk) {
      const reasons = analysis.violations.length
        ? analysis.violations
        : [`risk score ${analysis.risk_score} requires review`];
      return verdict("needs_human_review",
        "Routed to a human approver — " + reasons.join("; "),
        analysis, 0.9, intake);
    }
    if (req.amount <= POLICY.auto_approve_limit) {
      return verdict("auto_approved",
        `Auto-approved: $${fmt(req.amount)} is within the $${fmt(POLICY.auto_approve_limit)} ` +
        `auto-approve limit, compliant, low risk.`, analysis, 0.85, intake);
    }
    return verdict("needs_human_review",
      `Compliant but $${fmt(req.amount)} exceeds the $${fmt(POLICY.auto_approve_limit)} ` +
      `auto-approve limit — needs sign-off.`, analysis, 0.8, intake);
  }

  function verdict(decision, rationale, analysis, confidence, intake) {
    return {
      decision, rationale, risk_score: analysis.risk_score, confidence,
      intake, analysis, engine: "local",
    };
  }

  function fromDict(d) {
    return {
      id: d.id || "", employee: d.employee || "",
      category: d.category || "other", amount: Number(d.amount) || 0.0,
      description: d.description || "", has_receipt: Boolean(d.has_receipt),
      date: d.date || "",
    };
  }

  function processRequest(payload, history) {
    const req = fromDict(payload);
    const hist = (history || []).map(fromDict);
    const intake = runIntake(req);
    const analysis = analyze(req, intake.normalized_category, hist);
    return decide(req, intake, analysis);
  }

  function processBatch(payloads) {
    const results = [], seen = [];
    for (const p of payloads) {
      const req = fromDict(p);
      results.push(processRequest(p, seen.slice()));
      seen.push(req);
    }
    return results;
  }

  function fmt(n) {
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const SAMPLE = [
    { id: "EXP-1001", employee: "A. Rivera", category: "software", amount: 149.0, description: "Design tool annual seat", has_receipt: true },
    { id: "EXP-1002", employee: "J. Okafor", category: "meals", amount: 85.0, description: "Client lunch", has_receipt: true },
    { id: "EXP-1003", employee: "M. Haider", category: "travel", amount: 1450.0, description: "Conference flight + hotel", has_receipt: true },
    { id: "EXP-1004", employee: "S. Kim", category: "equipment", amount: 2500.0, description: "Workstation refresh", has_receipt: true },
    { id: "EXP-1005", employee: "L. Moreau", category: "meals", amount: 180.0, description: "Team dinner, no receipt", has_receipt: false },
    { id: "EXP-1006", employee: "P. Silva", category: "software", amount: -5.0, description: "Malformed refund entry", has_receipt: false },
    { id: "EXP-1007", employee: "D. Novak", category: "uber", amount: 60.0, description: "Airport taxi, receipt lost", has_receipt: false },
    { id: "EXP-1008", employee: "A. Rivera", category: "software", amount: 149.0, description: "Design tool annual seat (resubmitted)", has_receipt: true },
  ];

  const API = { POLICY, normalizeCategory, runIntake, analyze, decide,
    processRequest, processBatch, fmt, SAMPLE };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else global.FinanceCrew = API;
})(typeof window !== "undefined" ? window : globalThis);
