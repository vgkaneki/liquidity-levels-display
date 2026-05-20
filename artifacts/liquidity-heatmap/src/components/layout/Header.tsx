import { Link, useLocation } from "wouter";
import {
  Activity,
  LayoutDashboard,
  Radar,
  Bell,
  LogOut,
  User,
  FlaskConical,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WsHealthPanel } from "@/components/health/WsHealthPanel";
import { ValidationPanel } from "@/components/heatmap/ValidationPanel";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

const NAV_ITEMS = [
  { href: "/", label: "HEATMAP", Icon: Activity },
  { href: "/market", label: "MARKETS", Icon: LayoutDashboard },
  { href: "/scanner", label: "SCANNER", Icon: Radar },
  { href: "/alerts", label: "ALERTS", Icon: Bell },
];

export function Header() {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [validationOpen, setValidationOpen] = useState(false);

  return (
    <header className="market-header relative z-40 h-14 shrink-0 border-b border-white/[0.07] bg-card/86 backdrop-blur-xl supports-[backdrop-filter]:bg-card/72">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent" />
      <div className="flex h-full items-center justify-between gap-2 px-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 lg:gap-5">
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.045] px-2.5 py-1.5 shadow-[0_0_26px_rgba(34,211,238,0.08)]">
            <div className="relative flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-300/25 bg-gradient-to-br from-cyan-400/20 via-sky-500/10 to-blue-950/40 text-cyan-200">
              <Activity className="h-4 w-4" />
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]" />
            </div>
            <div className="hidden min-w-0 sm:block leading-none">
              <div className="text-[11px] font-semibold tracking-[0.24em] text-cyan-100/95">
                MARKET STRATEGY
              </div>
              <div className="mt-1 flex items-center gap-1 text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                <ShieldCheck className="h-3 w-3 text-emerald-300/80" />
                Engines protected
              </div>
            </div>
          </div>

          <nav className="flex min-w-0 items-center gap-1 rounded-xl border border-white/[0.06] bg-background/34 p-1 shadow-inner shadow-black/25">
            {NAV_ITEMS.map(({ href, label, Icon }) => {
              const active = location === href;
              return (
                <Button
                  key={href}
                  asChild
                  variant="ghost"
                  size="sm"
                  className={`h-8 rounded-lg px-2 sm:px-3 font-mono text-[11px] tracking-[0.12em] transition-all ${
                    active
                      ? "bg-cyan-400/12 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.18),0_0_18px_rgba(34,211,238,0.08)]"
                      : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                  }`}
                >
                  <Link href={href}>
                    <Icon className="h-4 w-4 sm:mr-2" />
                    <span className="hidden md:inline">{label}</span>
                  </Link>
                </Button>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2 text-xs text-muted-foreground">
          <Popover open={validationOpen} onOpenChange={setValidationOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="hidden sm:flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.07] bg-background/35 px-2.5 font-mono text-[11px] tracking-[0.12em] text-muted-foreground hover:border-cyan-300/25 hover:bg-cyan-400/[0.07] hover:text-cyan-100"
                aria-label="Open HL validation panel"
                data-testid="button-validation-open"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                VALIDATE
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[760px] max-w-[95vw] max-h-[80vh] overflow-hidden p-0">
              <ValidationPanel onClose={() => setValidationOpen(false)} />
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-8 items-center gap-2 rounded-lg border border-emerald-400/15 bg-emerald-400/[0.055] px-2.5 font-mono text-[11px] tracking-[0.12em] text-emerald-100/90 hover:border-emerald-300/30 hover:bg-emerald-400/10"
                aria-label="Show feed health"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.75)]" />
                </span>
                <span className="hidden md:inline">API CONNECTED</span>
                <span className="md:hidden">LIVE</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[420px] max-h-[80vh] overflow-auto p-0">
              <WsHealthPanel />
            </PopoverContent>
          </Popover>

          {user ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-8 items-center gap-2 rounded-lg border border-white/[0.07] bg-background/35 px-2.5 hover:border-white/[0.12] hover:bg-white/[0.04] hover:text-foreground"
                  aria-label="Account menu"
                  data-testid="button-user-menu"
                >
                  <User className="h-3.5 w-3.5" />
                  <span className="hidden lg:inline max-w-[160px] truncate font-mono text-[11px]">
                    {user.email}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-2">
                <div className="px-2 py-1.5 text-[11px] font-mono text-muted-foreground truncate" data-testid="text-user-email">
                  {user.email}
                </div>
                <div className="my-1 border-t border-border" />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-xs font-mono"
                  onClick={() => { void logout(); }}
                  data-testid="button-logout"
                >
                  <LogOut className="mr-2 h-3.5 w-3.5" />
                  Sign out
                </Button>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    </header>
  );
}
