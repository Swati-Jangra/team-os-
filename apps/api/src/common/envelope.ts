import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { PageMeta } from '@teamos/shared';

/** Return from a controller to get `{ data: items, meta }`. Anything else becomes `{ data: value }`. */
export class Paged<T> {
  constructor(
    readonly items: T[],
    readonly meta: PageMeta,
  ) {}
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (value instanceof Paged) return { data: value.items, meta: value.meta };
        return { data: value === undefined ? null : value };
      }),
    );
  }
}
