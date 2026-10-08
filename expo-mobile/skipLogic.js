// Questionnaire logic engine shared by the server (lib/skipLogic.js), every web
// page that shows/hides questions as someone answers (diary form, admin
// preview) and the mobile app (expo-mobile/skipLogic.js is a byte-identical
// copy -- tests/skipLogicCompound.test.js keeps them in step). One engine means
// the respondent's screen and the server can never disagree about which
// questions were shown -- the server rejects a missing required answer only
// for questions this engine says were visible.
//
// Rules (skip_rules rows) have one or more conditions joined by rule.match:
// "all" (AND) or "any" (OR). Rules created before compound conditions existed
// carry a single condition in condition_question_id / operator / value and no
// conditions_json. A condition reads either a question's answer (question_id)
// or a derived value (variable): "score" is the entry's total score, any other
// name is a variable set by a set_variable rule.
//
// A condition can also be a custom logic expression ({ expression }) -- see
// "Custom logic expressions" below.
//
// Actions:
//   show / hide   -- target_question_id or target_section. Several rules on one
//                    target combine: shown when it has no show rule or ANY show
//                    rule matches, hidden when ANY hide rule matches (hide
//                    wins). A question in a hidden section stays hidden.
//   skip_to       -- after source_question_id, jump to target_question_id (or
//                    to the end when skip_to_end): everything between is hidden.
//   set_variable  -- set variable_name to variable_value. Rules run in order,
//                    so a later rule can read a variable an earlier one set.
//   terminate     -- end the entry / participation (see findTerminateMatch).
//
// Scoring: each choice option can carry a score (question.option_scores_json,
// { "Option": 3 }). The total score sums the scores of every chosen option on
// visible questions.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SkipLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var NUMERIC = ["gt", "gte", "lt", "lte"];

  function parseJson(raw, fallback) {
    if (raw === undefined || raw === null || raw === "") return fallback;
    if (typeof raw !== "string") return raw;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  // ---------- Custom logic expressions ----------
  //
  // The "JavaScript Logic" equivalent: a small expression language parsed and
  // evaluated here -- never eval'd -- so nothing an author types can run as
  // code in a respondent's browser or on the server. Like QuestionPro's
  // $survey API it reads answers through a fixed set of functions:
  //
  //   answer('Q1')            selected option / typed answer ("" if none)
  //   number('Q4')            the answer as a number (0 if not a number)
  //   selectedCount('Q3')     how many options are selected
  //   selectedIndex('Q1')     1-based position of the first selected option
  //   isSelected('Q3', 'A')   true when that option is selected
  //   isAnswered('Q2')        true when the question has an answer
  //   score, segment          the total score; any other name is a variable
  //
  // Operators: == != > >= < <= && || ! (and / or / not) + - * / and ( ).
  // QuestionPro's $survey.getSelectedOption / getSelectedOptionIndex /
  // getSelectedCount names are accepted as aliases.
  var FUNCTION_ALIASES = {
    answer: "answer", getselectedoption: "answer", getresponse: "answer",
    number: "number",
    selectedcount: "selectedCount", getselectedcount: "selectedCount",
    selectedindex: "selectedIndex", getselectedoptionindex: "selectedIndex",
    isselected: "isSelected", hasoption: "isSelected",
    isanswered: "isAnswered",
  };
  var ARITY = { answer: 1, number: 1, selectedCount: 1, selectedIndex: 1, isSelected: 2, isAnswered: 1 };

  function tokenize(src) {
    var tokens = [], i = 0, s = String(src || "");
    while (i < s.length) {
      var ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      var two = s.substr(i, 2);
      if (["==", "!=", ">=", "<=", "&&", "||"].indexOf(two) > -1) { tokens.push({ t: "op", v: two }); i += 2; continue; }
      if ("<>!+-*/(),".indexOf(ch) > -1) { tokens.push({ t: ch === "(" || ch === ")" || ch === "," ? ch : "op", v: ch }); i++; continue; }
      if (ch === "=") { tokens.push({ t: "op", v: "==" }); i++; continue; }
      if (ch === "'" || ch === '"') {
        var end = i + 1, out = "";
        while (end < s.length && s[end] !== ch) { if (s[end] === "\\" && end + 1 < s.length) end++; out += s[end]; end++; }
        if (end >= s.length) throw new Error("A text value is missing its closing quote.");
        tokens.push({ t: "str", v: out }); i = end + 1; continue;
      }
      var num = /^\d+(\.\d+)?/.exec(s.slice(i));
      if (num) { tokens.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
      var id = /^[$A-Za-z_][$A-Za-z0-9_.]*/.exec(s.slice(i));
      if (id) {
        var word = id[0], lower = word.toLowerCase();
        if (lower === "and") tokens.push({ t: "op", v: "&&" });
        else if (lower === "or") tokens.push({ t: "op", v: "||" });
        else if (lower === "not") tokens.push({ t: "op", v: "!" });
        else if (lower === "true" || lower === "false") tokens.push({ t: "bool", v: lower === "true" });
        else tokens.push({ t: "id", v: word });
        i += word.length; continue;
      }
      throw new Error("Unexpected “" + ch + "” in the expression.");
    }
    return tokens;
  }

  // Recursive-descent parser producing a small AST.
  function parseExpression(src) {
    var tokens = tokenize(src), pos = 0;
    if (!tokens.length) throw new Error("The expression is empty.");
    var peek = function () { return tokens[pos]; };
    var isOp = function (v) { var t = tokens[pos]; return t && t.t === "op" && t.v === v; };
    var expect = function (type, label) {
      var t = tokens[pos];
      if (!t || t.t !== type) throw new Error("Expected " + label + " in the expression.");
      pos++; return t;
    };
    function binary(next, ops) {
      return function () {
        var left = next();
        while (tokens[pos] && tokens[pos].t === "op" && ops.indexOf(tokens[pos].v) > -1) {
          var op = tokens[pos++].v;
          left = { k: "bin", op: op, l: left, r: next() };
        }
        return left;
      };
    }
    function primary() {
      var t = peek();
      if (!t) throw new Error("The expression ends too early.");
      if (t.t === "num" || t.t === "str" || t.t === "bool") { pos++; return { k: "lit", v: t.v }; }
      if (t.t === "(") { pos++; var inner = orExpr(); expect(")", "“)”"); return inner; }
      if (t.t === "id") {
        pos++;
        if (tokens[pos] && tokens[pos].t === "(") {
          var name = t.v.replace(/^\$survey\./i, "").toLowerCase();
          var fn = FUNCTION_ALIASES[name];
          if (!fn) throw new Error("Unknown function “" + t.v + "”.");
          pos++;
          var args = [];
          if (!(tokens[pos] && tokens[pos].t === ")")) {
            args.push(orExpr());
            while (tokens[pos] && tokens[pos].t === ",") { pos++; args.push(orExpr()); }
          }
          expect(")", "“)”");
          if (args.length !== ARITY[fn]) throw new Error(t.v + " takes " + ARITY[fn] + " value" + (ARITY[fn] === 1 ? "" : "s") + ".");
          return { k: "call", fn: fn, args: args };
        }
        if (t.v.indexOf(".") > -1 || t.v.indexOf("$") > -1) throw new Error("Unknown name “" + t.v + "”.");
        return { k: "var", name: t.v };
      }
      throw new Error("Unexpected “" + t.v + "” in the expression.");
    }
    function unary() {
      if (isOp("!")) { pos++; return { k: "not", e: unary() }; }
      if (isOp("-")) { pos++; return { k: "neg", e: unary() }; }
      return primary();
    }
    var mul = binary(unary, ["*", "/"]);
    var add = binary(mul, ["+", "-"]);
    var cmp = binary(add, ["==", "!=", ">", ">=", "<", "<="]);
    var andExpr = binary(cmp, ["&&"]);
    var orExpr = binary(andExpr, ["||"]);
    var ast = orExpr();
    if (pos < tokens.length) throw new Error("Unexpected “" + tokens[pos].v + "” in the expression.");
    return ast;
  }

  var parsedCache = {};
  function compiled(src) {
    if (!Object.prototype.hasOwnProperty.call(parsedCache, src)) parsedCache[src] = parseExpression(src);
    return parsedCache[src];
  }

  /** null when the expression is valid, else a message saying what's wrong. */
  function validateExpression(src) {
    try { parseExpression(src); return null; } catch (e) { return e.message; }
  }

  function numeric(v) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    var n = Number(v);
    return String(v).trim() !== "" && isFinite(n) ? n : null;
  }
  function truthy(v) { return typeof v === "string" ? v !== "" : !!v; }

  function evalNode(node, ctx) {
    switch (node.k) {
      case "lit": return node.v;
      case "var":
        if (node.name.toLowerCase() === "score") return ctx.score === undefined ? 0 : ctx.score;
        // Own properties only, so "constructor" is an unset variable, not Object's.
        return ctx.variables && Object.prototype.hasOwnProperty.call(ctx.variables, node.name) && ctx.variables[node.name] != null ? ctx.variables[node.name] : "";
      case "not": return !truthy(evalNode(node.e, ctx));
      case "neg": return -(numeric(evalNode(node.e, ctx)) || 0);
      case "call": {
        var args = node.args.map(function (a) { return evalNode(a, ctx); });
        var q = ctx.questionByCode ? ctx.questionByCode(String(args[0])) : null;
        var raw = q ? ctx.answerFor(Number(q.id)) : undefined;
        var answer = raw === undefined || raw === null ? "" : String(raw);
        var picked = answer ? answer.split("|") : [];
        if (node.fn === "answer") return answer;
        if (node.fn === "number") return numeric(answer) || 0;
        if (node.fn === "selectedCount") return picked.length;
        if (node.fn === "isAnswered") return answer !== "";
        if (node.fn === "isSelected") return picked.indexOf(String(args[1])) > -1;
        var options = q && Array.isArray(q.options) ? q.options : [];
        return picked.length ? options.indexOf(picked[0]) + 1 : 0; // selectedIndex
      }
      case "bin": {
        if (node.op === "&&") return truthy(evalNode(node.l, ctx)) && truthy(evalNode(node.r, ctx));
        if (node.op === "||") return truthy(evalNode(node.l, ctx)) || truthy(evalNode(node.r, ctx));
        var l = evalNode(node.l, ctx), r = evalNode(node.r, ctx);
        var ln = numeric(l), rn = numeric(r);
        if (node.op === "+") return ln !== null && rn !== null ? ln + rn : String(l) + String(r);
        if (node.op === "-") return (ln || 0) - (rn || 0);
        if (node.op === "*") return (ln || 0) * (rn || 0);
        if (node.op === "/") return rn ? (ln || 0) / rn : 0;
        if (node.op === "==") return ln !== null && rn !== null ? ln === rn : String(l) === String(r);
        if (node.op === "!=") return ln !== null && rn !== null ? ln !== rn : String(l) !== String(r);
        if (ln === null || rn === null) return false;
        if (node.op === ">") return ln > rn;
        if (node.op === ">=") return ln >= rn;
        if (node.op === "<") return ln < rn;
        return ln <= rn;
      }
    }
    return false;
  }

  function expressionTrue(src, ctx) {
    try { return truthy(evalNode(compiled(src), ctx)); } catch (_) { return false; }
  }

  function normalizeCondition(c) {
    if (c.expression) return { question_id: null, variable: null, expression: String(c.expression), operator: "expression", value: "" };
    var variable = c.variable ? String(c.variable) : null;
    return {
      question_id: variable || c.question_id == null ? null : Number(c.question_id),
      variable: variable,
      operator: c.operator || "equals",
      value: c.value == null ? "" : String(c.value),
    };
  }

  function ruleConditions(rule) {
    var list = parseJson(rule && rule.conditions_json, null);
    if (Array.isArray(list) && list.length) {
      return list.filter(function (c) { return c && (c.question_id != null || c.variable || c.expression); }).map(normalizeCondition);
    }
    if (!rule || rule.condition_question_id == null) return [];
    return [normalizeCondition({ question_id: rule.condition_question_id, operator: rule.operator, value: rule.value })];
  }

  // val is the answer as stored: "|"-joined for multi-select. A condition's
  // value is "|"-joined when it lists several values ("is one of A or B").
  function matchesCondition(val, condition) {
    var ruleValues = String(condition.value || "").split("|");
    if (NUMERIC.indexOf(condition.operator) > -1) {
      var a = Number(val), b = Number(condition.value);
      if (String(val) === "" || !isFinite(a) || !isFinite(b)) return false;
      if (condition.operator === "gt") return a > b;
      if (condition.operator === "gte") return a >= b;
      if (condition.operator === "lt") return a < b;
      return a <= b;
    }
    switch (condition.operator) {
      case "not_equals":
        return val !== condition.value;
      case "in":
        return ruleValues.indexOf(val) > -1;
      case "not_in":
        return ruleValues.indexOf(val) === -1;
      case "includes": {
        var valValues = String(val || "").split("|").filter(Boolean);
        return ruleValues.some(function (rv) { return valValues.indexOf(rv) > -1; });
      }
      case "equals":
      default:
        return val === condition.value;
    }
  }

  // ctx.answerFor(questionId) returns the stored answer, or undefined when the
  // question wasn't answered; ctx.score / ctx.variables hold derived values.
  // requireAnswered makes a condition on a missing value fail instead of
  // comparing against "" -- terminate rules use it so a skipped question never
  // screens anyone out.
  function ruleMatches(rule, ctx, requireAnswered) {
    var conditions = ruleConditions(rule);
    if (!conditions.length) return false;
    var test = function (c) {
      if (c.expression) return expressionTrue(c.expression, ctx);
      var val;
      if (c.variable === "score") val = ctx.score === undefined ? undefined : String(ctx.score);
      else if (c.variable) val = ctx.variables && Object.prototype.hasOwnProperty.call(ctx.variables, c.variable) ? ctx.variables[c.variable] : undefined;
      else val = ctx.answerFor(c.question_id);
      if (val === undefined || val === null) return requireAnswered ? false : matchesCondition("", c);
      return matchesCondition(String(val), c);
    };
    return rule.match === "any" ? conditions.some(test) : conditions.every(test);
  }

  function optionScores(question) {
    var map = parseJson(question.option_scores_json !== undefined ? question.option_scores_json : question.optionScores, {});
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  }

  function totalScore(questions, answerFor, visibleIds) {
    var total = 0;
    (questions || []).forEach(function (q) {
      if (q.type !== "single" && q.type !== "multi") return;
      if (visibleIds && !visibleIds.has(Number(q.id))) return;
      var scores = optionScores(q), answer = answerFor(Number(q.id));
      if (answer === undefined || answer === null || answer === "") return;
      String(answer).split("|").forEach(function (choice) {
        var s = Number(scores[choice]);
        if (isFinite(s)) total += s;
      });
    });
    return Math.round(total * 1000) / 1000;
  }

  function visibility(questions, rules, ctx) {
    var showRules = {}, hideMatched = {};
    var key = function (rule) {
      if (rule.target_section) return "s:" + rule.target_section;
      return rule.target_question_id != null ? "q:" + Number(rule.target_question_id) : null;
    };
    (rules || []).forEach(function (rule) {
      if (rule.action !== "show" && rule.action !== "hide") return;
      var k = key(rule);
      if (!k) return;
      var matched = ruleMatches(rule, ctx, false);
      if (rule.action === "show") showRules[k] = !!showRules[k] || matched;
      else if (matched) hideMatched[k] = true;
    });
    var isShown = function (k) { return (!(k in showRules) || showRules[k]) && !hideMatched[k]; };
    var hiddenSections = new Set();
    Object.keys(showRules).concat(Object.keys(hideMatched)).forEach(function (k) {
      if (k.indexOf("s:") === 0 && !isShown(k)) hiddenSections.add(k.slice(2));
    });
    var visibleIds = new Set();
    (questions || []).forEach(function (q) {
      if (q.section && hiddenSections.has(q.section)) return;
      if (isShown("q:" + Number(q.id))) visibleIds.add(Number(q.id));
    });

    // Skip-to runs in questionnaire order, so a jump from a question that an
    // earlier jump already skipped never fires. Each source question takes at
    // most one jump: the first matching rule, else its default branch (only
    // once the source question has been answered, so an untouched question
    // doesn't jump ahead before the respondent has even read it).
    var position = {};
    (questions || []).forEach(function (q, i) { position[Number(q.id)] = i; });
    var bySource = {};
    (rules || []).forEach(function (r) {
      if (r.action !== "skip_to" || r.source_question_id == null || position[Number(r.source_question_id)] === undefined) return;
      (bySource[Number(r.source_question_id)] = bySource[Number(r.source_question_id)] || []).push(r);
    });
    Object.keys(bySource)
      .sort(function (a, b) { return position[a] - position[b]; })
      .forEach(function (source) {
        source = Number(source);
        if (!visibleIds.has(source)) return;
        var list = bySource[source];
        var chosen = list.filter(function (r) { return !r.is_default; }).find(function (r) { return ruleMatches(r, ctx, false); });
        if (!chosen) {
          var answer = ctx.answerFor(source);
          if (answer !== undefined && answer !== null && answer !== "") chosen = list.find(function (r) { return r.is_default; });
        }
        if (!chosen) return;
        var from = position[source];
        var to = chosen.skip_to_end ? questions.length : position[Number(chosen.target_question_id)];
        if (to === undefined || to <= from) return;
        for (var i = from + 1; i < to; i++) visibleIds.delete(Number(questions[i].id));
      });
    return { visibleIds: visibleIds, hiddenSections: hiddenSections };
  }

  function sameSet(a, b) {
    if (a.size !== b.size) return false;
    var same = true;
    a.forEach(function (v) { if (!b.has(v)) same = false; });
    return same;
  }

  // Score and variables depend on which questions are visible, and visibility
  // can depend on score and variables -- so iterate to a fixed point (a few
  // passes at most for any real questionnaire). questions must be in
  // questionnaire order: [{ id, section, type, option_scores_json }].
  function codeLookup(questions) {
    var byCode = {};
    (questions || []).forEach(function (q) { if (q.code) byCode[String(q.code).toLowerCase()] = q; });
    return function (code) { return byCode[String(code).toLowerCase()] || null; };
  }

  function evaluate(questions, rules, answerFor) {
    var visibleIds = null, state = null, questionByCode = codeLookup(questions);
    for (var pass = 0; pass < 6; pass++) {
      var score = totalScore(questions, answerFor, visibleIds);
      var variables = {};
      var ctx = { answerFor: answerFor, score: score, variables: variables, questionByCode: questionByCode };
      (rules || []).forEach(function (rule) {
        if (rule.action !== "set_variable" || !rule.variable_name) return;
        if (visibleIds && rule.source_question_id != null && !visibleIds.has(Number(rule.source_question_id))) return;
        if (ruleMatches(rule, ctx, false)) variables[rule.variable_name] = rule.variable_value == null ? "" : String(rule.variable_value);
      });
      var shown = visibility(questions, rules, ctx);
      state = { visibleIds: shown.visibleIds, hiddenSections: shown.hiddenSections, score: score, variables: variables };
      if (visibleIds && sameSet(visibleIds, shown.visibleIds)) break;
      visibleIds = shown.visibleIds;
    }
    return state;
  }

  function evaluateVisibility(questions, rules, answerFor) {
    return evaluate(questions, rules, answerFor);
  }

  // The first terminate rule that matches, or null. Pass questions so a rule
  // can read the score or a variable.
  function findTerminateMatch(rules, answerFor, questions) {
    var terminates = (rules || []).filter(function (r) { return r.action === "terminate"; });
    if (!terminates.length) return null;
    var state = questions ? evaluate(questions, rules, answerFor) : { score: undefined, variables: {} };
    var ctx = { answerFor: answerFor, score: state.score, variables: state.variables, questionByCode: codeLookup(questions) };
    for (var i = 0; i < terminates.length; i++) {
      if (ruleMatches(terminates[i], ctx, true)) return terminates[i];
    }
    return null;
  }

  // Plain-language description for the builder, e.g.
  // "Q2 is Yes and Total score is at least 10".
  function describeConditions(rule, questionText, operatorLabels) {
    var parts = ruleConditions(rule).map(function (c) {
      var val = ["in", "not_in", "includes"].indexOf(c.operator) > -1 ? c.value.split("|").join(", ") : c.value;
      if (c.expression) return { question: "custom logic", operator: "is true:", value: c.expression };
      var subject = c.variable === "score" ? "Total score" : c.variable ? "variable “" + c.variable + "”" : questionText(c.question_id);
      return { question: subject, operator: (operatorLabels && operatorLabels[c.operator]) || c.operator, value: val };
    });
    return { parts: parts, joiner: rule.match === "any" ? "or" : "and" };
  }

  return {
    ruleConditions: ruleConditions,
    matchesCondition: matchesCondition,
    ruleMatches: ruleMatches,
    optionScores: optionScores,
    totalScore: totalScore,
    evaluate: evaluate,
    evaluateVisibility: evaluateVisibility,
    findTerminateMatch: findTerminateMatch,
    describeConditions: describeConditions,
    validateExpression: validateExpression,
  };
});
