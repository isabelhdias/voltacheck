-- Temporary diagnostic. Reports the SHAPE of x-forwarded-for, never the
-- address: element count, per-element family/private-range/length, and the
-- names (not values) of the headers PostgREST can see. Installed for a few
-- minutes and dropped again.
create or replace function public.xff_probe() returns json
language plpgsql stable
set search_path = pg_catalog
as $$
declare
  hdrs  json;
  xff   text;
  parts text[];
  outp  json[] := '{}';
  p     text;
begin
  hdrs := nullif(current_setting('request.headers', true), '')::json;
  if hdrs is null then
    return json_build_object('headers_visible', false);
  end if;

  xff := hdrs ->> 'x-forwarded-for';
  if xff is null then
    return json_build_object(
      'headers_visible', true, 'xff_present', false,
      'header_names', (select json_agg(k order by k) from json_object_keys(hdrs) k));
  end if;

  parts := string_to_array(xff, ',');
  foreach p in array parts loop
    p := trim(p);
    outp := outp || json_build_object(
      'family',  case when p like '%:%' then 'ipv6' else 'ipv4' end,
      'private', (p like '10.%' or p like '127.%' or p like '192.168.%'
                  or p ~ '^172\.(1[6-9]|2[0-9]|3[01])\.'
                  or p like 'fd%' or p like 'fc%' or p = '::1'),
      'len',     length(p));
  end loop;

  return json_build_object(
    'headers_visible', true,
    'xff_present',     true,
    'element_count',   array_length(parts, 1),
    'elements',        array_to_json(outp),
    'header_names',    (select json_agg(k order by k) from json_object_keys(hdrs) k));
end $$;

grant execute on function public.xff_probe() to anon;

-- PostgREST caches the schema; without this the function exists but is
-- invisible over REST. Supabase listens on the same channel.
notify pgrst, 'reload schema';
