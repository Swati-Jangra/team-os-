-- Aggregate-only view of the outbox for monitoring. Returns counts and ages, never payloads or tenant ids,
-- so the worker can export a backlog gauge without any broader read access to outbox_events.
CREATE FUNCTION outbox_stats() RETURNS TABLE (pending bigint, oldest_pending_seconds double precision, retrying bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FILTER (WHERE published_at IS NULL),
         COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published_at IS NULL))), 0),
         count(*) FILTER (WHERE published_at IS NULL AND last_error IS NOT NULL)
  FROM outbox_events
$$;
REVOKE ALL ON FUNCTION outbox_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_stats() TO app_user;
