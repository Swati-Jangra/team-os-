export interface PageParams {
  page: number;
  pageSize: number;
}

export interface PageMeta extends PageParams {
  total: number;
  totalPages: number;
}

export const MAX_PAGE_SIZE = 100;

export function normalizePage(input: { page?: number; pageSize?: number }): PageParams {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize ?? 20)));
  return { page, pageSize };
}

export function toSkipTake({ page, pageSize }: PageParams): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function buildPageMeta(params: PageParams, total: number): PageMeta {
  return { ...params, total, totalPages: Math.max(1, Math.ceil(total / params.pageSize)) };
}
