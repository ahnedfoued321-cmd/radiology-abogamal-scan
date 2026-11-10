# ADR-008: Fastify + plain SQL instead of NestJS + ORM

- **Status:** Accepted (MVP build, supersedes the NestJS choice in Phase 0 / ADR-002)
- **Date:** 2026-11-10

## Context
Phase 0 proposed NestJS. During the MVP build the priorities were: correctness of money and tax logic,
strict multi-tenant isolation, fast cold starts for the API and workers, and the fewest moving parts.

## Decision
- HTTP: **Fastify 5** with explicit route modules and **Zod** validation (TypeScript end-to-end, as approved).
- Data: **PostgreSQL 16** via `pg` with hand-written SQL and versioned SQL migrations — no ORM.
- Business rules live in framework-free packages (`@mithqal/domain`, `@mithqal/zatca`, `@mithqal/money`)
  shared by the API, the web POS and (next) the mobile van app.
- Tenant isolation is enforced by **Row-Level Security** with a non-superuser runtime role, not by application filters.

## Consequences
- + Database-level invariants (balanced journals, append-only ledgers, RLS) are explicit and testable.
- + No decorator/reflection build step; the same TypeScript runs in tests, dev (`tsx`) and production (`tsc`).
- − No DI container: services are plain functions taking a transaction. If the team grows, NestJS can wrap
  these services without rewriting them.
