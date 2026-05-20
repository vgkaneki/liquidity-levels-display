import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, consumeReturnTo } from "@/lib/auth";

// Standalone page rendered for unauthenticated visitors. Deliberately
// minimal: no engine state, no WebSocket subscriptions, no chart
// providers. The heavy app context (ChartSettings/Toaster/etc) is
// mounted in App.tsx OUTSIDE the RequireAuth subtree only when the
// user is signed in.
export default function Login() {
  const { login, user } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the user already has a session (e.g. opened /login while
  // already authenticated), bounce them to the heatmap.
  if (user) {
    queueMicrotask(() => navigate(consumeReturnTo()));
    return <div className="h-screen w-screen bg-background" />;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Navigate to the intended destination. PreferenceSync will then
      // hydrate from /api/user/preferences and (if there are stored
      // prefs) trigger a hard reload to apply them — that's why we
      // don't bother to refresh() here.
      navigate(consumeReturnTo());
    } catch {
      setError("Unable to sign in. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-6 text-primary font-bold">
          <Activity className="w-6 h-6" />
          <span className="text-lg">Market Strategy</span>
        </div>
        <div className="border border-border rounded-lg bg-card p-6 shadow-lg">
          <h1 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">Sign in</h1>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-mono uppercase">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                data-testid="input-email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs font-mono uppercase">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                maxLength={200}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                data-testid="input-password"
              />
            </div>
            {error ? (
              <div className="text-xs text-destructive font-mono" role="alert" data-testid="text-error">
                {error}
              </div>
            ) : null}
            <Button
              type="submit"
              disabled={submitting || !email || password.length < 8}
              className="w-full"
              data-testid="button-submit"
            >
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
          <div className="mt-4 text-xs text-muted-foreground text-center">
            No account?{" "}
            <Link href="/register" className="text-primary hover:underline" data-testid="link-register">
              Create one
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
