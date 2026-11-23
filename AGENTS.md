# ST-Agentic Agent Guidelines

## Commands

- Run all commands inside this directory (`ST-Agentic`); this is a standalone npm package nested inside SillyTavern.
- On Windows PowerShell where `.ps1` script execution is restricted, use `npm.cmd` and `npx.cmd` instead of `npm` / `npx`.
- Install dependencies with `npm ci` (never hand-edit `package-lock.json`).
- Core static & unit validation: `npm run typecheck`, `npm run lint`, and `npm test` (Vitest Node suite).
- Build production ESM bundle: `npm run build` (Webpack outputs `dist/index.js`, loaded by `manifest.json`).
- Additional suites (configured in Wave 0): `npm run dev:ui`, `npm run test:browser`, `npm run test:e2e`.

## Authoritative Docs

- Architecture & data contracts: `docs/ARCHITECTURE.md`
- Parallel task board, wave dependencies & exclusive path locks: `docs/TASKS.md`
- Interactive UI layout & Dark/Light visual reference: follow `docs/ARCHITECTURE.md` §9.
- UI design system (tokens, components, shell layout, copy & CSS conventions): `docs/UI_DESIGN_SYSTEM.md`.

## Architectural Red Lines

1. **Strict Host Boundary**: `src/core/**` MUST NOT import `@st/*`, `window`, `document`, `$`, or `jQuery`. All host interactions go strictly through `HostBridge` (`src/core/bridge/`). Only `src/host/**` and `src/index.ts` may import `@st/*`.
2. **Append-Only KV Cache Invariance**: Never mutate Layer 0 or historical Layer 1 messages/tool results before hitting the High Watermark compaction threshold. Object serialization for tools and stable prompts must use canonical key ordering.
3. **Zero Native Chat Replacement & Isolated UI**: Never replace SillyTavern's `#chat .mes` DOM. Keep `<agentic-capsule>` outside `.mes_text`. All configuration/logs/editors/file views live inside a single `<dialog id="agentic-app">` with `Shadow DOM` isolation (`:host { all: initial }`), defaulting to `dark` theme with Light/Auto support, full keyboard event propagation stop, and mobile `< 768px` compliance (`100vw × 100dvh`, stack navigation, `>= 40×40px` touch targets, `>= 16px` form inputs, no Monaco).
4. **Causal Branch Safety**: All VFS writes, variable overrides, persistent trajectory checkpoints, and background async media tasks must bind to `(messageId, swipeId)` and honor `AbortSignal` on swipe/regenerate/cancel.

## Parallel Worker Rules

- **Respect Owned Paths**: Only create or edit files listed under your assigned task's `Owned Paths` in `docs/TASKS.md`. Never modify shared config (`package.json`, `tsconfig.json`, `webpack.config.js`), frozen contracts (`src/core/types/**`, `src/core/bridge/**`), or `docs/TASKS.md` from a parallel worker branch.
- **No Unapproved Contract Drift**: If a shared type or bridge method needs changes, report it to the Coordinator instead of editing upstream files locally.
- **Merge Gate**: Run `npm run typecheck`, `npm run lint`, and your task's targeted `npx vitest run ...` before reporting completion.
