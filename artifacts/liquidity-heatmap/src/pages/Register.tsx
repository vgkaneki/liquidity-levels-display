import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, consumeReturnTo } from "@/lib/auth";

// Sister of Login.tsx — same layout philosophy: no engine context, no
// WebSocket. Successful registration auto-logs the user in (the server
// establishes the session in the same response), so we navigate
// straight to the heatmap.
export default function Register() {
  const { register, user } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) {
    queueMicrotask(() => navigate(consumeReturnTo()));
    return <div className="h-screen w-screen bg-background" />;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await register(email.trim(), password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      navigate(consumeReturnTo());
    } catch {
      setError("Unable to create account. Check your connection and try again.");
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
          <h1 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">Create account</h1>
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
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={200}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                data-testid="input-password"
              />
              <p className="text-[11px] text-muted-foreground font-mono">Min 8 characters.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm" className="text-xs font-mono uppercase">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={200}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={submitting}
                data-testid="input-confirm"
              />
            </div>
            {error ? (
              <div className="text-xs text-destructive font-mono" role="alert" data-testid="text-error">
                {error}
              </div>
            ) : null}
            <Button
              type="submit"
              disabled={submitting || !email || password.length < 8 || password !== confirm}
              className="w-full"
              data-testid="button-submit"
            >
              {submitting ? "Creating..." : "Create account"}
            </Button>
          </form>
          <div className="mt-4 text-xs text-muted-foreground text-center">
            Already have an account?{" "}
            <Link href="/login" className="text-primary hover:underline" data-testid="link-login">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
