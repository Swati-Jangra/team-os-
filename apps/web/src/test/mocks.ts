import { vi } from 'vitest';

/** Shared mutable state the mocked hooks read, so each test sets the scenario it needs. */
export const scenario = {
  permissions: new Set<string>(),
  emails: [] as unknown[],
  email: null as unknown,
  events: [] as unknown[],
  projects: [] as unknown[],
  meetings: [] as unknown[],
};
export const mutations = {
  approve: vi.fn(), reject: vi.fn(), editItem: vi.fn(), linkProject: vi.fn(), link: vi.fn(), unlink: vi.fn(),
};
export const query = <T,>(data: T) => ({ isPending: false, isError: false, data, refetch: vi.fn() });
