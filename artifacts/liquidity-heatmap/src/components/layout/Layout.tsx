import { ReactNode } from "react";
import { Header } from "./Header";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div
      className="market-shell flex flex-col h-screen min-h-screen bg-background text-foreground overflow-hidden font-mono"
      style={{ height: "100dvh" }}
    >
      <Header />
      <main className="market-main relative flex-1 overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  );
}
