-- Run once in the Supabase SQL editor (leadmachine project).
-- Adds the tables the script-based harvester and the Lead Generation Manager need.
-- Nothing here changes or deletes existing data.

-- 1. Town queue. The harvester works through towns in priority order.
--    The manager can reorder (priority) or skip saturated towns (skip = true).
create table if not exists harvest_towns (
  city        text primary key,          -- written exactly like search_log.city
  priority    int  not null,
  lat         double precision,          -- filled automatically (OSM Nominatim) on first use
  lng         double precision,
  skip        boolean not null default false,
  skip_reason text,
  updated_at  timestamptz not null default now()
);

insert into harvest_towns (city, priority, lat, lng) values
  ('Aubrey', 10, 33.3057, -96.9575),
  ('Providence Village', 20, null, null),
  ('Cross Roads', 30, 33.2436, -96.9964),
  ('Krugerville', 40, 33.2815064, -96.9905628),
  ('Little Elm', 50, 33.1782296, -96.8909892),
  ('Oak Point', 60, null, null),
  ('Pilot Point', 70, null, null),
  ('Savannah', 80, null, null),
  ('Denton', 90, null, null),
  ('Frisco', 100, null, null),
  ('Prosper', 110, null, null),
  ('Celina', 120, null, null),
  ('McKinney', 130, null, null),
  ('Sanger', 140, null, null),
  ('Justin', 150, null, null),
  ('Argyle', 160, null, null),
  ('Corinth', 170, null, null),
  ('Lake Dallas', 180, null, null),
  ('Plano', 190, null, null),
  ('Allen', 200, null, null),
  ('Lewisville', 210, null, null),
  ('Flower Mound', 220, null, null),
  ('Carrollton', 230, null, null),
  ('Fort Worth', 240, null, null),
  ('Dallas', 250, null, null),
  ('Waco', 300, null, null),
  ('Austin', 310, null, null),
  ('San Antonio', 320, null, null),
  ('Houston', 330, null, null),
  ('Tyler', 340, null, null),
  ('Lubbock', 350, null, null),
  ('Amarillo', 360, null, null),
  ('El Paso', 370, null, null),
  ('Corpus Christi', 380, null, null)
on conflict (city) do nothing;

-- 2. Known spam-farm / mismatched-pin coordinates (moved out of the agent's memory file
--    so the script and every agent share one list). Cards pinned within ~50 m are dropped.
create table if not exists spam_coords (
  lat   double precision not null,
  lng   double precision not null,
  note  text,
  added_at timestamptz not null default now(),
  primary key (lat, lng)
);

insert into spam_coords (lat, lng, note) values
  (33.2523966, -97.1083496, 'spam-farm cluster (roofing/fence/concrete/electric)'),
  (32.9856821, -96.8651,    'spam-farm cluster flagged by Qualifier UNA-89'),
  (32.7430719, -96.963595,  'spam-farm cluster (appliance/towing/junk)'),
  (33.1896905, -96.929719,  'spam-farm cluster (hvac/electric)'),
  (33.1516709, -96.758125,  'spam-farm cluster (landscaping/electric)'),
  (33.1502614, -96.827798,  'spam-farm cluster (lawn/fence)'),
  (33.171793,  -96.783522,  'spam-farm cluster (landscaping)'),
  (33.00936,   -96.8651,    'spam-farm cluster (flooring/remodel)'),
  (31.1689103, -100.0768425,'mismatched San Angelo pin')
on conflict do nothing;

-- 3. One row per harvester run, so the manager can read results without transcripts.
create table if not exists harvest_runs (
  id               bigserial primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  runner           text not null default 'script',   -- 'script' or 'agent'
  status           text not null default 'running',  -- running | ok | stopped | selector_broken | challenged | error
  stop_reason      text,
  selector_version text,
  searches         int not null default 0,
  cards_seen       int not null default 0,
  inserted         int not null default 0,
  duplicates       int not null default 0,
  out_of_area      int not null default 0,
  notes            text
);

-- 4. Views the manager reads (read-only, cheap).
create or replace view mgr_daily_leads as
select (first_seen at time zone 'America/Chicago')::date as day,
       count(*) as harvested,
       count(*) filter (where website_class = 'social_only') as social_only
from "no-Website-lead"
where city is not null
group by 1
order by 1 desc;

create or replace view mgr_pipeline_state as
select coalesce(state, 'null') as state, count(*) as leads
from "no-Website-lead"
where city is not null
group by 1
order by 2 desc;

create or replace view mgr_yield_by_city_category as
select city, category,
       sum(cards_seen)          as cards_seen,
       sum(inserted)            as inserted,
       sum(duplicates_skipped)  as duplicates,
       round(100.0 * sum(inserted) / nullif(sum(cards_seen), 0), 2) as new_lead_pct,
       max(searched_at)         as last_searched
from search_log
group by 1, 2;

create or replace view mgr_town_progress as
select t.city, t.priority, t.skip,
       count(distinct s.category) filter (where s.status = 'done') as categories_done,
       coalesce(sum(s.inserted), 0)   as inserted,
       coalesce(sum(s.cards_seen), 0) as cards_seen
from harvest_towns t
left join search_log s on lower(regexp_replace(s.city, ',\s*tx$', '', 'i')) = lower(t.city)
group by 1, 2, 3
order by t.priority;

create or replace view mgr_recent_runs as
select * from harvest_runs order by started_at desc limit 50;

-- 5. Everything the manager needs in ONE call: select mgr_report();
create or replace function mgr_report() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'generated_at', now(),
    'daily_leads', (select coalesce(jsonb_agg(d), '[]'::jsonb) from (select * from mgr_daily_leads limit 14) d),
    'pipeline_state', (select coalesce(jsonb_agg(p), '[]'::jsonb) from mgr_pipeline_state p),
    'recent_runs', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select id, started_at, finished_at, runner, status, stop_reason, searches, cards_seen, inserted, duplicates, out_of_area
        from harvest_runs order by started_at desc limit 20) r),
    'towns_in_progress', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select * from mgr_town_progress where not skip and categories_done < 24 limit 15) t),
    'lowest_yield_7d', (select coalesce(jsonb_agg(y), '[]'::jsonb) from (
        select * from mgr_yield_by_city_category
        where last_searched > now() - interval '7 days'
        order by new_lead_pct nulls first limit 25) y)
  );
$$;

-- 6. Lead scorer v1 (gateway/src/scorer.js). Adds columns only; existing rows stay as they are
--    until score_leads scores them (rows with city IS NULL are never scored).
alter table "no-Website-lead"
  add column if not exists score            int,
  add column if not exists tier             text check (tier in ('qualified', 'review', 'rejected')),
  add column if not exists score_breakdown  jsonb,
  add column if not exists reject_reason    text,
  add column if not exists scored_at        timestamptz,
  add column if not exists scorer_version   text,
  -- Maps listing signals (harvest card + check_operating), so scoring never browses
  add column if not exists closed_status      text check (closed_status in ('permanent', 'temporary')),
  add column if not exists newest_review_date date,
  add column if not exists hours_present      boolean,
  add column if not exists photo_count        int,          -- all listing photos: Maps' panel has no owner/customer split
  add column if not exists signals_at         timestamptz,  -- when check_operating last filled the fields above
  -- US Census batch geocoder
  add column if not exists geo_match        text check (geo_match in ('exact', 'non_exact', 'no_match')),
  add column if not exists geo_lat          double precision,
  add column if not exists geo_lng          double precision,
  add column if not exists geo_county_fips  text,
  add column if not exists geocoded_at      timestamptz,
  -- same phone_e164 as an older row (that row's source_id)
  add column if not exists duplicate_of     text;
-- website_class gains a third value: 'website' (check_operating found a real website later).

create index if not exists no_website_lead_tier_idx on "no-Website-lead" (tier) where city is not null;
create index if not exists no_website_lead_phone_e164_idx on "no-Website-lead" (phone_e164);

-- 7. Route harvested leads by scorer tier (was: heuristics on review_count / social link / name).
--    The Qualifier only gets tier 'review' (via agent_review_queue, now with the score breakdown);
--    'qualified' and 'rejected' are decided by the scorer. Unscored rows stay 'harvested'.
create or replace function public.promote_to_review() returns json
language plpgsql as $$
declare n_review int; n_qualified int; n_rejected int; n_unscored int; n_waiting int;
begin
  with upd as (
    update public."no-Website-lead" t
       set state = case t.tier when 'review' then 'needs_review' when 'qualified' then 'qualified' else 'rejected' end,
           review_reason = 'scorer ' || t.scorer_version || ': ' ||
             case when t.tier = 'rejected' then coalesce(t.reject_reason, 'low_score') || ' (' || t.score || ')' else 'score ' || t.score end
     where t.state = 'harvested' and t.city is not null and t.tier is not null
    returning t.state
  )
  select count(*) filter (where state = 'needs_review'), count(*) filter (where state = 'qualified'),
         count(*) filter (where state = 'rejected')
    into n_review, n_qualified, n_rejected from upd;
  select count(*) into n_unscored from public."no-Website-lead" where state = 'harvested' and city is not null and tier is null;
  select count(*) into n_waiting from public."no-Website-lead" where state = 'needs_review';
  return json_build_object('newly_needs_review', n_review, 'newly_qualified', n_qualified, 'newly_rejected', n_rejected,
                           'harvested_not_scored_yet', n_unscored, 'needs_review_waiting', n_waiting);
end
$$;

create or replace view agent_review_queue as
select source_id, name, category, address, phone, rating, review_count, google_maps_url, website_class,
       social_or_notes, city, review_reason, first_seen, score, tier, score_breakdown
from "no-Website-lead"
where state = 'needs_review' and tier = 'review'
order by score desc, first_seen
limit 200;
