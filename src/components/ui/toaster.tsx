"use client";

import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from "react";
import * as Toast from "@radix-ui/react-toast";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";

type Variant = "success" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: Variant;
}

interface Ctx {
  toast: (opts: { title: string; description?: string; variant?: Variant }) => void;
}

const ToastCtx = createContext<Ctx | null>(null);

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToasterProvider>");
  return ctx;
}

const variantStyles: Record<Variant, { ring: string; icon: ReactNode }> = {
  success: { ring: "ring-emerald-500/40", icon: <CheckCircle2 className="h-4 w-4 text-emerald-600" /> },
  error:   { ring: "ring-red-500/40",     icon: <AlertTriangle className="h-4 w-4 text-red-600" /> },
  info:    { ring: "ring-blue-500/40",    icon: <Info className="h-4 w-4 text-blue-600" /> },
};

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback<Ctx["toast"]>(({ title, description, variant = "info" }) => {
    setItems((prev) => [...prev, { id: Date.now() + Math.random(), title, description, variant }]);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastCtx.Provider value={value}>
      <Toast.Provider swipeDirection="right" duration={4200}>
        {children}
        {items.map((t) => (
          <Toast.Root
            key={t.id}
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((p) => p.id !== t.id));
            }}
            className={`group pointer-events-auto flex items-start gap-3 rounded-xl border border-[var(--border)] bg-white px-4 py-3 shadow-md ring-1 ring-inset ${variantStyles[t.variant].ring} data-[state=open]:animate-slide-in data-[state=closed]:animate-fade-out`}
          >
            <div className="mt-0.5 shrink-0">{variantStyles[t.variant].icon}</div>
            <div className="min-w-0 flex-1">
              <Toast.Title className="text-[13px] font-semibold text-[#1A1A1A]">{t.title}</Toast.Title>
              {t.description && (
                <Toast.Description className="mt-0.5 text-[12px] text-[var(--text-secondary)] leading-relaxed">
                  {t.description}
                </Toast.Description>
              )}
            </div>
            <Toast.Close className="ml-1 text-[var(--text-tertiary)] hover:text-[#1A1A1A] transition-colors">
              <X className="h-3.5 w-3.5" />
            </Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport className="fixed bottom-5 right-5 z-50 m-0 flex w-[360px] max-w-[calc(100vw-2rem)] list-none flex-col gap-2 outline-none" />
      </Toast.Provider>
    </ToastCtx.Provider>
  );
}
