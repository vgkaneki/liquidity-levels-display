# Deploy fix notes

All previously pending patches have been applied:

- Structural-level retry patch: `patch-levels-request-resilience.cjs` wired into `apply-render-patches.cjs`.
- Level overlay zoom-stability patch: `patch-level-overlay-zoom-stability.cjs` wired in.
- Render runtime pressure patch: `patch-render-runtime-pressure.cjs` wired in.
- Chart request debounce patch: `patch-chart-request-debounce.cjs` wired in.
- `vite.config.ts`: PORT validation no longer throws during `vite build` in production environments
  where PORT has not yet been injected (falls back to Render default of 10000).
- `App.tsx`: Fixed misleading indentation — `AuthProvider` is now correctly indented as
  a child of `TooltipProvider`.
