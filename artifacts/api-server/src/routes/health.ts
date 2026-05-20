import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getHlPressure } from "../services/hyperliquid";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Lightweight upstream-pressure probe for the frontend toolbar dot. Reports
// whether the HL adaptive backoff is currently active (i.e. we observed a
// 429 within the cooldown window) so the UI can warn the user before they
// blame us for slow chart updates.
router.get("/upstream-pressure", (_req, res) => {
  const hl = getHlPressure();
  res.setHeader("Cache-Control", "no-store");
  res.json({ hyperliquid: hl });
});

export default router;
