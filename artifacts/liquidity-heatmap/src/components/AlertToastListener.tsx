import { useRef } from "react";
import { useChannel } from "@/hooks/useChannel";
import { toast } from "@/hooks/use-toast";

interface ScannerAlert {
  id: string;
  symbol: string;
  kind: string;
  message: string;
  ts: number;
}

/**
 * Global listener for the `scanner:alerts` WS channel. Whenever the
 * alert engine dispatches a rule with the `toast` sink, the backend
 * republishes the event on this channel and we raise an in-app toast
 * using the existing shadcn toast system. Mounted once at App root so
 * toasts show on every page, not only on the Scanner.
 */
export function AlertToastListener() {
  // Snapshot replays historical alerts on mount; we don't want to flood
  // the toast queue with those. Track "seen" ids so only live deltas
  // (arrived after subscription) fire a toast.
  const seenRef = useRef<Set<string>>(new Set());
  const bootedRef = useRef(false);

  useChannel<{ alerts?: ScannerAlert[]; alert?: ScannerAlert }>(
    "scanner:alerts",
    (payload, kind) => {
      if (!payload) return;
      if (kind === "snapshot") {
        for (const a of payload.alerts ?? []) seenRef.current.add(a.id);
        bootedRef.current = true;
        return;
      }
      const a = payload.alert;
      if (!a || typeof a.id !== "string") return;
      if (seenRef.current.has(a.id)) return;
      seenRef.current.add(a.id);
      if (!bootedRef.current) return; // skip pre-snapshot deltas
      toast({ title: a.symbol, description: a.message });
    },
  );

  return null;
}
