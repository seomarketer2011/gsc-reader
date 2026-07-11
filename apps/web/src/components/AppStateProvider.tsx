"use client";

import { createContext, useContext } from "react";

export interface AppState {
  configured: boolean; // Supabase env vars present
  userId: string | null;
  orgId: string | null;
  email: string | null;
}

const AppStateContext = createContext<AppState>({
  configured: false,
  userId: null,
  orgId: null,
  email: null,
});

export function AppStateProvider({
  value,
  children,
}: {
  value: AppState;
  children: React.ReactNode;
}) {
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  return useContext(AppStateContext);
}
