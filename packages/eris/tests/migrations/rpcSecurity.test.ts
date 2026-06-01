import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readMigration(name: string) {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), "utf8");
}

function stripSqlComments(sql: string) {
  return sql.replace(/--.*$/gm, "");
}

const privilegedFunctions = [
  ["002_atomic_balance_rpc.sql", "eris_add_balance", "TEXT, BIGINT, TEXT, TEXT"],
  ["003_atomic_claim_rpc.sql", "eris_claim_reward", "TEXT, TEXT, BIGINT, INTEGER, BIGINT, TIMESTAMPTZ"],
  ["007_atomic_whitelist.sql", "bot_whitelist_add", "TEXT, JSONB"],
  ["007_atomic_whitelist.sql", "bot_whitelist_remove", "TEXT"],
  ["009_atomic_bank_rpc.sql", "eris_add_bank_balance", "text, integer, integer"],
  ["010_atomic_inventory_consume_rpc.sql", "eris_consume_inventory_item", "TEXT, TEXT"],
  ["011_atomic_boss_damage_rpc.sql", "eris_damage_boss", "text, text, integer"],
  ["012_atomic_stock_portfolios_rpc.sql", "eris_buy_stock_shares", "TEXT, TEXT, BIGINT, NUMERIC, NUMERIC"],
  ["012_atomic_stock_portfolios_rpc.sql", "eris_sell_stock_shares", "TEXT, TEXT, BIGINT, NUMERIC"],
  ["013_atomic_lottery_rpc.sql", "eris_buy_lottery_ticket", "TEXT, INTEGER, INTEGER, INTEGER, BIGINT"],
  ["013_atomic_lottery_rpc.sql", "eris_claim_lottery_draw", "NUMERIC, INTEGER, BIGINT, NUMERIC"],
] as const;

describe("economy/security RPC grants", () => {
  it.each(privilegedFunctions)("%s revokes client/public execution for %s", (file, name, signature) => {
    const sql = stripSqlComments(readMigration(file));
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    expect(sql).toMatch(new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${name}\\(${escapedSignature}\\)\\s+FROM\\s+PUBLIC`, "i"));
    expect(sql).toMatch(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${name}\\(${escapedSignature}\\)\\s+TO\\s+service_role`, "i"));
    expect(sql).not.toMatch(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${name}\\(${escapedSignature}\\)\\s+TO\\s+[^;]*(anon|authenticated)`, "i"));
  });

  it("keeps direct stock portfolio DML service-role only", () => {
    const sql = stripSqlComments(readMigration("012_atomic_stock_portfolios_rpc.sql"));

    expect(sql).toMatch(/REVOKE\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+public\.eris_stock_portfolios\s+FROM\s+PUBLIC/i);
    expect(sql).toMatch(/REVOKE\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+public\.eris_stock_portfolios\s+FROM\s+anon,\s+authenticated/i);
    expect(sql).toMatch(/GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+public\.eris_stock_portfolios\s+TO\s+service_role/i);
    expect(sql).not.toMatch(/GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+public\.eris_stock_portfolios\s+TO\s+[^;]*(anon|authenticated)/i);
  });
});

describe("lottery RPC caller-controlled economics", () => {
  const sql = stripSqlComments(readMigration("013_atomic_lottery_rpc.sql"));

  it("rejects caller attempts to alter ticket price, house seed, draw window, or rollover", () => {
    expect(sql).toContain("invalid_lottery_config");
    expect(sql).toMatch(/p_ticket_price\s+IS\s+DISTINCT\s+FROM\s+v_ticket_price/i);
    expect(sql).toMatch(/p_house_seed\s+IS\s+DISTINCT\s+FROM\s+v_house_seed/i);
    expect(sql).toMatch(/p_day_ms\s+IS\s+DISTINCT\s+FROM\s+v_day_ms/i);
    expect(sql).toMatch(/p_rollover_fraction\s+IS\s+DISTINCT\s+FROM\s+v_rollover_fraction/i);
  });

  it("uses server constants and server-side random selection for money-changing math", () => {
    expect(sql).toMatch(/v_cost\s*:=\s*p_count::bigint\s*\*\s*v_ticket_price/i);
    expect(sql).toMatch(/v_roll\s*:=\s*floor\(random\(\)\s*\*\s*v_total\)::bigint\s*\+\s*1/i);
    expect(sql).toMatch(/v_rollover\s*:=\s*floor\(v_pot\s*\*\s*v_rollover_fraction\)::bigint/i);
    expect(sql).not.toMatch(/v_cost\s*:=\s*p_count::bigint\s*\*\s*p_ticket_price/i);
    expect(sql).not.toMatch(/COALESCE\(\s*p_roll\s*,\s*random\(\)\s*\)/i);
    expect(sql).not.toMatch(/v_rollover\s*:=\s*floor\(v_pot\s*\*\s*p_rollover_fraction\)::bigint/i);
  });
});

describe("stock RPC caller-controlled economics", () => {
  const sql = stripSqlComments(readMigration("012_atomic_stock_portfolios_rpc.sql"));

  it("prices trades from the stored ticker state, not the caller price argument", () => {
    expect(sql).toMatch(/WHERE\s+b\.id\s*=\s*'eris_stocks'/i);
    expect(sql).toMatch(/ARRAY\['tickers',\s*v_symbol,\s*'price'\]/i);
    expect(sql).toMatch(/v_cost\s*:=\s*ceil\(v_price\s*\*\s*p_shares\)::bigint/i);
    expect(sql).toMatch(/v_proceeds\s*:=\s*floor\(v_price\s*\*\s*p_shares\)::bigint/i);
    expect(sql).toMatch(/v_max_position_value\s+NUMERIC\s*:=\s*1000000000000/i);
    expect(sql).not.toMatch(/v_cost\s*:=\s*ceil\(p_price\s*\*\s*p_shares\)::bigint/i);
    expect(sql).not.toMatch(/v_proceeds\s*:=\s*floor\(p_price\s*\*\s*p_shares\)::bigint/i);
    expect(sql).not.toMatch(/>\s*p_max_position_value/i);
  });
});
