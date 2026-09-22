-- Existing projects may grant broad privileges on new public tables through
-- default privileges. Reduce the runtime role to the operations the gateway
-- actually performs. This is idempotent and leaves postgres ownership intact.
revoke all on table public.model_attempts from service_role;
grant select, insert, update on table public.model_attempts to service_role;
