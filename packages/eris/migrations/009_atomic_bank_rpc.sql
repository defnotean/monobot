-- Atomic bank balance updates for Eris economy.
-- Keeps deposit/withdraw invariants correct across multiple bot workers.

create table if not exists public.eris_bank (
  user_id text primary key,
  balance integer not null default 0,
  last_interest timestamptz
);

create or replace function public.eris_add_bank_balance(
  p_user_id text,
  p_delta integer,
  p_max_balance integer default null
)
returns table (
  user_id text,
  balance integer,
  last_interest timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.eris_bank%rowtype;
  v_next integer;
begin
  if p_user_id is null or p_user_id = '' then
    raise exception 'invalid_user_id';
  end if;

  insert into public.eris_bank (user_id, balance, last_interest)
  values (p_user_id, 0, now())
  on conflict (user_id) do nothing;

  select *
    into v_row
    from public.eris_bank b
    where b.user_id = p_user_id
    for update;

  v_next := coalesce(v_row.balance, 0) + p_delta;
  if v_next < 0 then
    return;
  end if;
  if p_max_balance is not null and v_next > p_max_balance then
    return;
  end if;

  update public.eris_bank b
    set balance = v_next,
        last_interest = coalesce(b.last_interest, now())
    where b.user_id = p_user_id
    returning b.user_id, b.balance, b.last_interest
    into user_id, balance, last_interest;

  return next;
end;
$$;
