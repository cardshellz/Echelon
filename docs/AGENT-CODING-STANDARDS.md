# Agent Coding Standards

These standards are binding for agent-authored code in this repository, especially for financial, inventory, wallet, order, and dropship work.

## Short Version

Write production-grade code only. Optimize for correctness, clarity, maintainability, robustness, and scalability over speed or cleverness.

Requirements:

- Follow clean architecture and separation of concerns.
- Prefer simple, explicit, readable solutions over hacks or overly compact code.
- Use consistent naming, small focused functions, and modular design.
- Validate all inputs and handle errors explicitly.
- Assume edge cases, bad data, concurrency issues, and partial failures will happen.
- Avoid duplication; extract reusable logic where appropriate, but do not over-abstract prematurely.
- Make code easy to test, with deterministic behavior and minimal hidden side effects.
- Preserve backward compatibility unless a breaking change is explicitly required.
- Use secure defaults and never expose secrets, unsafe eval patterns, injection risks, or trust unchecked input.
- Design for observability: clear logging, actionable errors, and traceable behavior.
- Consider performance, but do not sacrifice correctness or readability without a clear reason.
- Document non-obvious decisions, assumptions, and tradeoffs inline.
- Keep files and functions organized so the codebase can grow safely over time.

Before finishing:

- Review for bugs, edge cases, and failure modes.
- Remove dead code, misleading comments, and unnecessary complexity.
- Ensure the final result is cohesive, production-ready, and understandable by another engineer.

## Evidence Discipline

Do not guess. Do not infer missing implementation details unless they are clearly labeled as assumptions.

Only make claims that are directly supported by code, logs, config, files, or user-provided snippets.

For every conclusion:

1. Cite the exact file and function, or the pasted snippet it comes from.
2. Explain the reasoning from that evidence.
3. State what is still unknown.

If there is not enough evidence to answer, say exactly what is missing instead of filling gaps.

When debugging:

- Inspect the actual code path end to end.
- Trace inputs, conditionals, side effects, and outputs.
- Check related config, environment variables, schema, and error handling.
- Prefer "I cannot verify this from the provided code" over speculation.

Required debugging output format:

- What the code definitely does
- What is likely happening
- What is not proven
- Next checks

## Trace-First Rule

Do not answer from general experience alone.

Before answering implementation or debugging questions:

1. Identify the relevant files/functions.
2. Quote or reference the exact lines that matter.
3. Trace the execution path step by step.
4. Separate facts from hypotheses.
5. Give the answer only after the trace.

Any statement not grounded in provided material must be labeled `HYPOTHESIS`.

If grounding is impossible, say `INSUFFICIENT EVIDENCE`.

## Long Version

Build software where correctness is more important than speed.

Assume bugs will result in financial loss.

Write code that would pass a financial audit.

## Core Directive

Write code that is correct, testable, deterministic, auditable, and safe for financial systems.

Favor clarity and correctness over speed or cleverness.

## 1. Architecture Rules

Separation of concerns:

- No mixed responsibilities.
- Enforce layers:
  - Domain: business logic.
  - Application: orchestration.
  - Infrastructure: DB and APIs.
  - Interface: HTTP and UI.

No business logic in:

- Controllers.
- Routes.
- Views.
- DB queries.

## 2. Determinism

No hidden state.

No reliance on:

- System time unless a clock is injected.
- Randomness unless a seed/source is injected.

All functions must be pure or explicitly stateful.

## 3. Data Integrity

Never:

- Mutate input objects.
- Use floating point for money.

Always:

- Use integers in cents or decimal libraries.
- Validate all inputs at boundaries.

## 4. Explicit Types and Contracts

No implicit types.

Define:

- DTOs.
- Schemas.
- Interfaces.

Validate:

- Inbound data.
- Outbound data.

## 5. Error Handling

No silent failures.

Every error must be:

- Caught.
- Classified.
- Logged.

Use structured errors:

```json
{
  "code": "INSUFFICIENT_FUNDS",
  "message": "...",
  "context": {}
}
```

## 6. Idempotency

All operations that can be retried must be idempotent.

Examples:

- Payments.
- Order creation.
- Inventory adjustments.

Use:

- Idempotency keys.
- Unique constraints.

## 7. Database Discipline

Never:

- Write without a transaction for financial operations.
- Do multi-step writes without rollback protection.

Always:

- Use transactions.
- Enforce constraints:
  - Foreign keys.
  - Unique indexes.

## 8. Logging and Auditability

Every critical action must log:

- Who.
- What.
- When.
- Before/after state.

Logs must be structured and immutable.

## 9. Testing Requirements

Agent work must produce:

- Unit tests for business logic paths.
- Integration tests for DB interactions.
- External API tests with mocks.

Edge cases:

- Zero values.
- Max values.
- Invalid input.
- Concurrency.

## 10. Concurrency Safety

No race conditions.

Use:

- Locks.
- Transactions.
- Atomic operations.

Especially for:

- Balances.
- Inventory.
- Order state.

## 11. No Magic

No hardcoded values.

No unexplained constants.

Everything must be named and documented.

## 12. Security

Never trust input.

Sanitize everything.

No secrets in code.

Use environment variables.

## 13. Readability Standard

Code must be obvious to a senior engineer in 30 seconds.

Boring is better than clever.

## 14. File Structure Example

```text
/domain
  order.ts
  payment.ts

/application
  createOrder.ts
  processPayment.ts

/infrastructure
  db.ts
  stripeClient.ts

/interfaces
  http/
    routes.ts
```

## 15. PR / Output Requirements

Agent must always output:

- Summary of changes
- Assumptions made
- Risks
- Test coverage explanation
- Failure modes

## 16. Absolute Prohibitions

Agent must never:

- Use floating point for currency.
- Skip validation.
- Write directly to DB from controllers.
- Ignore error handling.
- Create hidden side effects.
- Introduce non-idempotent financial operations.

## 17. Enforcement Clause

If any rule is violated, the solution is invalid and must be rewritten.

