"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Kind = "info" | "success" | "error";
type Item = { id: number; message: string; kind: Kind };

const ToastContext = createContext<(message: string, kind?: Kind) => void>(() => {});

export const useToast = () => useContext(ToastContext);

const TIMEOUT_MS = 4000;
const kindClass: Record<Kind, string> = {
  info: "border-line",
  success: "border-success",
  error: "border-danger",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);

  const toast = useCallback((message: string, kind: Kind = "info") => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, message, kind }]);
    setTimeout(() => setItems((list) => list.filter((i) => i.id !== id)), TIMEOUT_MS);
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-20 z-[70] flex flex-col items-center gap-2 md:bottom-6"
      >
        {items.map((i) => (
          <div
            key={i.id}
            className={`pop-in pointer-events-auto origin-bottom rounded-full border bg-surface px-5 py-3 text-sm shadow-lg shadow-black/40 ${kindClass[i.kind]}`}
          >
            {i.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
