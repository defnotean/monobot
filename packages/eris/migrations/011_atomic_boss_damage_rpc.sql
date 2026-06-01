create or replace function public.eris_damage_boss(
  p_boss_id text,
  p_user_id text,
  p_damage integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  boss_row public.eris_boss_battles%rowtype;
  new_hp integer;
  new_phase integer;
  current_damage integer;
  new_participants jsonb;
  updated_row public.eris_boss_battles%rowtype;
begin
  if p_damage is null or p_damage <= 0 then
    raise exception 'invalid damage';
  end if;

  select *
    into boss_row
    from public.eris_boss_battles
   where id::text = p_boss_id
   for update;

  if not found then
    return null;
  end if;

  if coalesce(boss_row.boss_hp, 0) <= 0 then
    return to_jsonb(boss_row)
      || jsonb_build_object('defeated', false, 'alreadyDead', true);
  end if;

  new_hp := greatest(0, boss_row.boss_hp - p_damage);
  current_damage := coalesce((coalesce(boss_row.participants, '{}'::jsonb) ->> p_user_id)::integer, 0);
  new_participants := jsonb_set(
    coalesce(boss_row.participants, '{}'::jsonb),
    array[p_user_id],
    to_jsonb(current_damage + p_damage),
    true
  );
  new_phase := case
    when new_hp <= 0 then 0
    when new_hp <= boss_row.max_hp * 0.25 then 3
    when new_hp <= boss_row.max_hp * 0.5 then 2
    else 1
  end;

  update public.eris_boss_battles
     set boss_hp = new_hp,
         participants = new_participants,
         phase = new_phase
   where id = boss_row.id
   returning * into updated_row;

  return to_jsonb(updated_row)
    || jsonb_build_object('defeated', new_hp <= 0, 'alreadyDead', false);
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.eris_damage_boss(text, text, integer) from anon, authenticated;
  end if;
  revoke execute on function public.eris_damage_boss(text, text, integer) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.eris_damage_boss(text, text, integer) to service_role;
  end if;
end $$;
