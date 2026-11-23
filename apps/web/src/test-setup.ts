import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// only DOM test files (`// @vitest-environment jsdom`) have a document to clean
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
