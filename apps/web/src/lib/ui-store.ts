'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  assistantOpen: boolean;
  toggleSidebar: () => void;
  toggleAssistant: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      assistantOpen: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleAssistant: () => set((s) => ({ assistantOpen: !s.assistantOpen })),
    }),
    {
      name: 'teamos-ui',
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }),
    },
  ),
);
