-- geo_assets: the real, persisted work the engine produces for a customer. This is
-- what turns the trial from a diagnosis into delivery — each generated page/schema
-- is stored, listed in the dashboard, and (when QA-approved) served as a live,
-- indexable page at /v/<id>. That live page IS the switching cost: cancel and it
-- goes away. Fail-soft: generation still returns to the browser if this is absent.
-- Only assets tied to a real client_id and qa_status='approved' are served publicly.
-- Run in the Supabase SQL editor.

create table if not exists geo_assets (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  client_id   text,
  type        text,          -- article | landing | listicle | schema
  focus       text,          -- the scorecard gap this asset closes
  title       text,
  content     text,
  schema      jsonb,
  qa_status   text,          -- approved | needs_review
  vertical    text,
  published   boolean default true
);

create index if not exists geo_assets_client_idx  on geo_assets (client_id, created_at desc);
